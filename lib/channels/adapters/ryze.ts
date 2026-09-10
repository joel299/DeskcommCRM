import { createAdminClient } from "@/lib/supabase/admin";
import { assertDestinoResolvidoSeguro } from "@/lib/automation/outbound-ip";
import { assertSafeOutboundUrl } from "@/lib/automation/outbound-url";
import { resolveRyzeCreds } from "../ryze/credentials";
import type {
  ChannelAdapter,
  ChannelHealth,
  ChannelTenantScope,
  OutboundEnvelope,
  RecipientInput,
} from "../types";

export const ryzeAdapter: ChannelAdapter = {
  provider: "ryze",

  resolveRecipient(input: RecipientInput): string | null {
    if (input.isGroup && input.groupChatId) {
      return input.groupChatId;
    }
    if (input.phoneNumber) {
      const digits = input.phoneNumber.replace(/\D/g, "");
      return digits ? digits : null;
    }
    if (input.waIdentity && input.waIdentity.startsWith("phone:")) {
      const digits = input.waIdentity.replace("phone:", "").replace(/\D/g, "");
      return digits ? digits : null;
    }
    if (input.waIdentity && (input.waIdentity.startsWith("lid:") || input.waIdentity.includes("@"))) {
      return input.waIdentity.replace("lid:", "");
    }
    return null;
  },

  isConfigured(): boolean {
    return true;
  },

  codes: {
    notConfigured: "ryze_not_configured",
    sendFailed: "ryze_send_failed",
    unknownError: "ryze_unknown",
  },

  async send(envelope: OutboundEnvelope): Promise<{ externalId: string | null }> {
    if (envelope.kind === "contact") {
      throw new Error("ryze_contact_not_supported: envio de cartao de contato nao suportado");
    }

    const toAddr = envelope.to;
    if (!toAddr) {
      return { externalId: null };
    }

    const admin = (envelope as unknown as { db?: any }).db ?? createAdminClient();
    const creds = await resolveRyzeCreds(admin, {
      organizationId: envelope.organizationId,
      instanceName: envelope.sessionRef,
    });
    if (!creds) {
      throw new Error("ryze_not_configured: credencial nao encontrada para esta instancia Ryze");
    }

    const baseUrl = creds.baseUrl || "https://ryzeapi.cloud";
    assertSafeOutboundUrl(baseUrl);
    await assertDestinoResolvidoSeguro(baseUrl);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      token: creds.tokenInstance,
    };

    await envelope.beforeSend?.();

    if (envelope.kind === "text" || !envelope.media) {
      const payload: Record<string, unknown> = {
        number: toAddr,
        message: envelope.body ?? "",
      };
      if (envelope.replyToExternalId) {
        payload.replyTo = envelope.replyToExternalId;
      }

      const res = await fetch(`${baseUrl}/api/message/text/${encodeURIComponent(creds.instanceName)}`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });

      const json = typeof res.json === "function" ? ((await res.json().catch(() => null)) as {
        success?: boolean;
        data?: { messageId?: string };
        messageId?: string;
        error?: string;
        code?: string;
      } | null) : null;

      if (!res.ok || json?.success === false) {
        const status = res.status;
        if (status === 401) throw new Error("ryze_auth_failed: 401 invalid token");
        if (status === 403) throw new Error("ryze_permission_denied: 403 instance mismatch");
        if (status === 404) throw new Error("ryze_instance_not_found: 404 instance not found");
        if (status === 429) throw new Error("ryze_rate_limited: 429 rate limit");
        const detalhe = json?.code ? `${json.code}: ${json.error ?? ""}` : (json?.error ?? res.statusText);
        throw new Error(`ryze_send_failed: HTTP ${status} ${detalhe}`.trim());
      }

      const messageId = json?.data?.messageId || json?.messageId || null;
      return { externalId: messageId };
    } else {
      const mediaKind = envelope.kind;
      const validMediaKinds = ["image", "video", "document", "audio"];
      if (!validMediaKinds.includes(mediaKind)) {
        throw new Error(`ryze_${mediaKind}_not_supported`);
      }

      const payload: Record<string, unknown> = {
        number: toAddr,
        type: mediaKind,
        mediaUrl: envelope.media.url,
        caption: envelope.body ?? "",
      };
      if (mediaKind === "audio") {
        payload.isVoice = true;
      }
      if (envelope.replyToExternalId) {
        payload.replyTo = envelope.replyToExternalId;
      }

      const res = await fetch(`${baseUrl}/api/message/media/${encodeURIComponent(creds.instanceName)}`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });

      const json = typeof res.json === "function" ? ((await res.json().catch(() => null)) as {
        success?: boolean;
        data?: { messageId?: string };
        messageId?: string;
        error?: string;
        code?: string;
      } | null) : null;

      if (!res.ok || json?.success === false) {
        const status = res.status;
        if (status === 401) throw new Error("ryze_auth_failed: 401 invalid token");
        if (status === 403) throw new Error("ryze_permission_denied: 403 instance mismatch");
        if (status === 404) throw new Error("ryze_instance_not_found: 404 instance not found");
        if (status === 429) throw new Error("ryze_rate_limited: 429 rate limit");
        const detalhe = json?.code ? `${json.code}: ${json.error ?? ""}` : (json?.error ?? res.statusText);
        throw new Error(`ryze_send_failed: HTTP ${status} ${detalhe}`.trim());
      }

      const messageId = json?.data?.messageId || json?.messageId || null;
      return { externalId: messageId };
    }
  },

  async checkHealth(input: ChannelTenantScope & { sessionRef: string }): Promise<ChannelHealth> {
    const admin = (input as unknown as { db?: any }).db ?? createAdminClient();
    const creds = await resolveRyzeCreds(admin, {
      organizationId: input.organizationId,
      instanceName: input.sessionRef,
    });
    if (!creds) {
      return { reachable: false, status: "NOT_CONFIGURED", detail: "credencial nao encontrada" };
    }
    return { reachable: true, status: "WORKING", detail: null };
  },
};
