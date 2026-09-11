import type { SupabaseClient } from "@supabase/supabase-js";

import { aplicarEfeitosPosEntrada } from "@/lib/channels/pos-entrada";
import { canonicalPhoneBR } from "@/lib/channels/phone-variants";
import type { RyzeEnvelope, RyzeExchangeMessage } from "./envelope";
import { ryzeEventId, ryzeMessageExternalId, ryzeStatusDedupeKey } from "./envelope";

export type RyzeIngestResult =
  | { status: "ingested"; conversationId?: string; messageId?: string }
  | { status: "duplicate"; conversationId?: string }
  | { status: "reconciled"; messageId?: string }
  | { status: "ignored"; reason: string };

interface RyzeIngestInput {
  organizationId: string;
  channelSessionId: string;
  envelope: RyzeEnvelope;
}

type RyzeExchangeInput = Omit<RyzeIngestInput, "envelope"> & {
  envelope: Extract<RyzeEnvelope, { event: "message.exchange" }>;
};

type DbError = { code?: string; message?: string } | null;

export async function ingestRyzeInbound(
  admin: SupabaseClient,
  input: RyzeIngestInput,
): Promise<RyzeIngestResult> {
  const eventKey = input.envelope.event === "message.status"
    ? ryzeStatusDedupeKey(input.envelope)
    : ryzeEventId(input.envelope) ?? ryzeMessageExternalId(input.envelope);
  if (eventKey) {
    const claim = await claimRyzeEvent(admin, input, eventKey);
    if (claim.outcome === "busy") throw new Error("ryze_event_busy");
    if (claim.outcome === "already_processed") return { status: "duplicate" };
    try {
      const result = await processRyzeEvent(admin, input);
      await finishRyzeEvent(admin, input, eventKey, claim.token!, "processed");
      return result;
    } catch (error) {
      await finishRyzeEvent(admin, input, eventKey, claim.token!, "failed");
      throw error;
    }
  }
  return processRyzeEvent(admin, input);
}

async function processRyzeEvent(admin: SupabaseClient, input: RyzeIngestInput): Promise<RyzeIngestResult> {
  if (input.envelope.event === "message.status") return updateRyzeMessageStatus(admin, input);
  if (input.envelope.event !== "message.exchange") return { status: "ignored", reason: "evento_ryze_nao_processavel" };
  if (input.envelope.data.message.direction === "outgoing") return reconcileRyzeOutgoing(admin, input);
  return insertRyzeIncoming(admin, { ...input, envelope: input.envelope });
}

async function claimRyzeEvent(admin: SupabaseClient, input: RyzeIngestInput, eventId: string): Promise<{ outcome: "claimed" | "already_processed" | "busy"; token?: string }> {
  const response = await admin.rpc("fn_claim_ryze_webhook_event", {
    p_org: input.organizationId, p_session: input.channelSessionId, p_event: eventId, p_event_type: input.envelope.event,
  });
  if (response.error) throw new Error("ryze_event_claim_failed");
  const row = Array.isArray(response.data) ? response.data[0] : response.data;
  if (row?.outcome === "claimed" && row.claim_token) return { outcome: "claimed", token: row.claim_token as string };
  if (row?.outcome === "already_processed") return { outcome: "already_processed" };
  return { outcome: "busy" };
}

async function finishRyzeEvent(admin: SupabaseClient, input: RyzeIngestInput, eventId: string, claimToken: string, state: "processed" | "failed"): Promise<void> {
  const response = await admin.rpc("fn_finish_ryze_webhook_event", {
    p_org: input.organizationId,
    p_session: input.channelSessionId,
    p_event: eventId,
    p_claim_token: claimToken,
    p_state: state,
    p_error_code: state === "failed" ? "processing_failed" : null,
  });
  if (response.error || response.data !== true && !(Array.isArray(response.data) && response.data[0] === true)) {
    throw new Error("ryze_event_finish_failed");
  }
}

async function updateRyzeMessageStatus(admin: SupabaseClient, input: RyzeIngestInput): Promise<RyzeIngestResult> {
  const message = input.envelope.data.message;
  const externalId = message.id;
  const status = normalizeStatus(message.status);
  if (!externalId || !status) return { status: "ignored", reason: "status_sem_identificador_ou_status_invalido" };

  const update: Record<string, unknown> = { status };
  const now = new Date().toISOString();
  if (status === "delivered") update.delivered_at = now;
  if (status === "read") {
    update.read_at = now;
    update.delivered_at = now;
  }

  const query = admin
    .from("messages")
    .update(update)
    .eq("organization_id", input.organizationId)
    .eq("channel_session_id", input.channelSessionId)
    .eq("external_id", externalId)
    .not("status", "in", blockedStatuses(status));
  const { data, error } = await query.select("id");
  if (error) throw new Error("ryze_status_update_failed");
  const row = Array.isArray(data) ? data[0] : data;
  return row?.id ? { status: "ingested", messageId: row.id } : { status: "ignored", reason: "mensagem_desconhecida" };
}

async function reconcileRyzeOutgoing(admin: SupabaseClient, input: RyzeIngestInput): Promise<RyzeIngestResult> {
  const message = input.envelope.data.message;
  if (!message.id) return { status: "ignored", reason: "outgoing_sem_external_id" };
  const status = normalizeStatus(message.status) ?? "sent";
  const query = admin
    .from("messages")
    .update({ status })
    .eq("organization_id", input.organizationId)
    .eq("channel_session_id", input.channelSessionId)
    .eq("external_id", message.id)
    .not("status", "in", blockedStatuses(status));
  const { data, error } = await query.select("id");
  if (error) throw new Error("ryze_outgoing_reconcile_failed");
  const row = Array.isArray(data) ? data[0] : data;
  return row?.id ? { status: "reconciled", messageId: row.id } : { status: "ignored", reason: "mensagem_desconhecida" };
}

async function insertRyzeIncoming(admin: SupabaseClient, input: RyzeExchangeInput): Promise<RyzeIngestResult> {
  const message = input.envelope.data.message;
  const externalId = message.id ?? input.envelope.data.id;
  const identity = resolveRyzeIdentity(message);
  if (!externalId || !identity) return { status: "ignored", reason: "incoming_sem_identidade_ou_external_id" };

  const contact = await admin.rpc("fn_upsert_wa_contact" as never, {
    p_org: input.organizationId,
    p_kind: identity.kind,
    p_phone: identity.phone,
    p_lid: identity.lid,
    p_chat_id: identity.chatId,
    p_notify: null,
  });
  if (contact.error || !contact.data) throw new Error("ryze_contact_upsert_failed");
  const contactId = String(contact.data);

  const conversation = await admin.rpc("fn_upsert_wa_conversation" as never, {
    p_org: input.organizationId, p_contact: contactId, p_session: input.channelSessionId,
  });
  if (conversation.error || !conversation.data) throw new Error("ryze_conversation_upsert_failed");
  const conversationId = String(conversation.data);

  const providerConversationId = identity.chatId;
  await admin.from("conversations").update({ provider_conversation_id: providerConversationId }).eq("id", conversationId).eq("organization_id", input.organizationId);
  const inserted = await admin.from("messages").insert({
    organization_id: input.organizationId,
    conversation_id: conversationId,
    channel_session_id: input.channelSessionId,
    contact_id: contactId,
    external_id: externalId,
    type: message.media ? "document" : "text",
    direction: "inbound",
    status: "received",
    sent_via: "external_device",
    body: message.text ?? message.body ?? null,
    metadata: { provider: "ryze", event_id: input.envelope.data.id ?? null },
  }).select("id").maybeSingle();

  if (inserted.error?.code === "23505") {
    const existing = await admin.from("messages")
      .select("id,conversation_id,contact_id,body")
      .eq("organization_id", input.organizationId)
      .eq("channel_session_id", input.channelSessionId)
      .eq("external_id", externalId)
      .maybeSingle();
    if (existing.error) throw new Error("ryze_duplicate_readback_failed");
    const row = existing.data as { id?: string; conversation_id?: string; contact_id?: string; body?: string | null } | null;
    if (row?.id && row.conversation_id && row.contact_id) {
      const applied = await completarPosEntrada(admin, input, row.conversation_id, row.contact_id, row.id, row.body ?? "");
      return applied ? { status: "duplicate", conversationId: row.conversation_id } : { status: "duplicate", conversationId: row.conversation_id };
    }
    throw new Error("ryze_duplicate_readback_missing");
  }
  if (inserted.error || !inserted.data) throw new Error("ryze_message_insert_failed");
  const messageId = (inserted.data as { id: string }).id;
  const preview = message.text ?? message.body ?? "";

  const applied = await completarPosEntrada(admin, input, conversationId, contactId, messageId, preview);
  if (!applied) throw new Error("ryze_post_effects_claim_lost");
  return { status: "ingested", conversationId, messageId };
}

async function completarPosEntrada(
  admin: SupabaseClient,
  input: RyzeExchangeInput,
  conversationId: string,
  contactId: string,
  messageId: string,
  preview: string,
): Promise<boolean> {
  const claimed = await admin.rpc("fn_claim_ryze_message_effects" as never, {
    p_org: input.organizationId, p_session: input.channelSessionId, p_message: messageId,
    p_conversation: conversationId, p_contact: contactId, p_preview: preview,
    p_at: new Date().toISOString(),
  });
  if (claimed.error) throw new Error("ryze_conversation_mark_failed");
  const claimRow = Array.isArray(claimed.data) ? claimed.data[0] : claimed.data;
  if (claimRow?.outcome === "busy") throw new Error("ryze_post_effects_busy");
  if (claimRow?.outcome === "already_processed") return false;
  if (claimRow?.outcome !== "claimed" || !claimRow.claim_token) return false;

  try {
    await aplicarEfeitosPosEntrada(admin, {
      organizationId: input.organizationId, contactId, conversationId, messageId,
      channelSessionId: input.channelSessionId, texto: preview || null,
      nomeDoContato: null, origem: "ryze_webhook", strictEffects: true,
      durableDispatch: true,
    });
  } catch (error) {
    const released = await admin.rpc("fn_fail_ryze_message_effects" as never, {
      p_org: input.organizationId, p_session: input.channelSessionId, p_message: messageId,
      p_claim_token: claimRow.claim_token,
    });
    const releaseOk = !released.error && (released.data === true || (Array.isArray(released.data) && released.data[0] === true));
    if (!releaseOk) {
      const original = error instanceof Error ? error : new Error("ryze_post_effects_failed");
      const releaseFailure = released.error?.message ?? "fn_fail_ryze_message_effects_false";
      original.message = `${original.message}; release_failed:${releaseFailure}`;
      throw original;
    }
    throw error;
  }

  const finished = await admin.rpc("fn_finish_ryze_message_effects" as never, {
    p_org: input.organizationId, p_session: input.channelSessionId,
    p_message: messageId, p_claim_token: claimRow.claim_token,
  });
  if (finished.error || (finished.data !== true && !(Array.isArray(finished.data) && finished.data[0] === true))) {
    throw new Error("ryze_post_effects_finish_failed");
  }
  return true;
}


function resolveRyzeIdentity(message: RyzeExchangeMessage): { kind: "phone" | "lid"; phone: string | null; lid: string | null; chatId: string } | null {
  const raw = message.remoteJid ?? message.from ?? null;
  if (!raw) return null;
  const exactLid = /^(\d+)@lid$/.exec(raw);
  if (exactLid) {
    const lid = exactLid[1] ?? "";
    return { kind: "lid", phone: null, lid, chatId: `lid:${lid}` };
  }
  if (/^\d+@g\.us$/.test(raw)) return null;
  if (/^(?:\+?\d[\d ()-]{7,})@(?:c\.us|s\.whatsapp\.net)$/.test(raw) || /^\+?\d[\d ()-]{7,}$/.test(raw)) {
    const canonical = canonicalPhoneBR(raw);
    return canonical ? { kind: "phone", phone: canonical, lid: null, chatId: `phone:${canonical}` } : null;
  }
  return null;
}

function blockedStatuses(status: "sent" | "delivered" | "read" | "failed"): string {
  switch (status) {
    case "sent": return "(sent,delivered,read,failed)";
    case "delivered": return "(delivered,read,failed)";
    case "read": return "(read,failed)";
    case "failed": return "(delivered,read,failed)";
  }
}

function normalizeStatus(status: string | undefined): "sent" | "delivered" | "read" | "failed" | null {
  switch (status) {
    case "sent": case "delivered": case "read": case "failed": return status;
    default: return null;
  }
}
