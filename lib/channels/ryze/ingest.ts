import type { SupabaseClient } from "@supabase/supabase-js";

import { aplicarEfeitosPosEntrada } from "@/lib/channels/pos-entrada";
import type { RyzeEnvelope, RyzeExchangeMessage } from "./envelope";
import { ryzeEventId } from "./envelope";

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
  const eventId = ryzeEventId(input.envelope);
  if (eventId) {
    const claimed = await claimRyzeEvent(admin, input, eventId);
    if (!claimed) return { status: "duplicate" };
  }

  if (input.envelope.event === "message.status") return updateRyzeMessageStatus(admin, input);
  if (input.envelope.event !== "message.exchange") {
    return { status: "ignored", reason: "evento_ryze_nao_processavel" };
  }
  if (input.envelope.data.message.direction === "outgoing") return reconcileRyzeOutgoing(admin, input);
  return insertRyzeIncoming(admin, { ...input, envelope: input.envelope });
}

async function claimRyzeEvent(admin: SupabaseClient, input: RyzeIngestInput, eventId: string): Promise<boolean> {
  const result = await admin
    .from("ryze_webhook_events")
    .insert({
      organization_id: input.organizationId,
      channel_session_id: input.channelSessionId,
      event_id: eventId,
      event_type: input.envelope.event,
    })
    .select("event_id")
    .maybeSingle();
  if ((result.error as DbError)?.code === "23505") return false;
  if (result.error) throw new Error("ryze_event_dedupe_failed");
  return true;
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
    p_org: input.organizationId, p_kind: "phone", p_phone: identity, p_lid: null, p_chat_id: identity, p_notify: null,
  });
  if (contact.error || !contact.data) throw new Error("ryze_contact_upsert_failed");
  const contactId = String(contact.data);

  const conversation = await admin.rpc("fn_upsert_wa_conversation" as never, {
    p_org: input.organizationId, p_contact: contactId, p_session: input.channelSessionId,
  });
  if (conversation.error || !conversation.data) throw new Error("ryze_conversation_upsert_failed");
  const conversationId = String(conversation.data);

  await admin.from("conversations").update({ provider_conversation_id: identity }).eq("id", conversationId).eq("organization_id", input.organizationId);
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

  if (inserted.error?.code === "23505") return { status: "duplicate", conversationId };
  if (inserted.error || !inserted.data) throw new Error("ryze_message_insert_failed");
  const messageId = (inserted.data as { id: string }).id;
  const preview = message.text ?? message.body ?? "";

  // Depois do INSERT, efeitos são best-effort e idempotentes: retry não pode ficar preso em 500.
  try {
    await admin.rpc("fn_mark_conversation_message" as never, {
      p_conv: conversationId, p_direction: "inbound", p_preview: preview, p_at: new Date().toISOString(),
    });
  } catch {
    // A mensagem persistida é a fonte de verdade; a reconciliação posterior pode refazer o carimbo.
  }
  try {
    await aplicarEfeitosPosEntrada(admin, {
      organizationId: input.organizationId, contactId, conversationId, messageId,
      channelSessionId: input.channelSessionId, texto: message.text ?? message.body ?? null,
      nomeDoContato: null, origem: "ryze_webhook",
    });
  } catch {
    // Nunca transformar falha pós-commit em reentrega impossível de recuperar.
  }
  return { status: "ingested", conversationId, messageId };
}

function resolveRyzeIdentity(message: RyzeExchangeMessage): string | null {
  const raw = message.remoteJid ?? message.from ?? null;
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 8 ? digits : null;
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
