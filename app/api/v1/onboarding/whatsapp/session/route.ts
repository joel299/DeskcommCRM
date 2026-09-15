import { randomUUID } from "node:crypto";
import { ok, fail } from "@/lib/api/wrappers";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { connectRyzeChannel } from "@/lib/channels/connect-ryze";
import { listRyzeInstances } from "@/lib/channels/ryze/control-plane";
import { ChannelConnectionError } from "@/lib/channels/connection-error";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const user = await loadAuthUser(); if (!user) return fail("unauthenticated", "Sessão expirada", 401, { requestId });
  const org = await resolveActiveOrg(user); if (!org) return fail("tenant_not_found", "Sem organização ativa", 404, { requestId });
  if (await mfaEmDivida()) return fail("mfa_required", "Confirme a verificação em duas etapas.", 403, { requestId });
  try {
    const db = await createClient();
    const { data: channel } = await db.from("channel_sessions")
      .select("id, organization_id, ryze_instance_name, status, archived_at")
      .eq("organization_id", org.orgId).eq("provider", "ryze").is("archived_at", null)
      .order("created_at").limit(1).maybeSingle();
    if (!channel || channel.archived_at) return ok({ status: "NOT_STARTED", session: null }, { requestId });
    const remote = (await listRyzeInstances()).find((item) => item.name === channel.ryze_instance_name);
    const status = remote?.status === "connected" ? "WORKING" : remote?.status === "scan_qr_code" ? "SCAN_QR_CODE" : "STARTING";
    const { error, data } = await db.from("channel_sessions").update({ status, last_health_check_at: new Date().toISOString() })
      .eq("organization_id", org.orgId).eq("id", channel.id).is("archived_at", null).select("id").maybeSingle();
    if (error || !data) throw new Error("connection_sync_failed");
    return ok({ status, session: channel.ryze_instance_name, channel_session_id: channel.id }, { requestId });
  } catch { return fail("connection_status_failed", "Não foi possível conferir a conexão. Tente novamente.", 502, { requestId }); }
}

export async function POST(req: Request): Promise<Response> {
  const denied = await requireSupportWrite(); if (denied) return denied;
  const requestId = randomUUID();
  const auth = await requireRole("admin", { requestId, resource: "channel_sessions", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  if (await mfaEmDivida()) return fail("mfa_required", "Confirme a verificação em duas etapas.", 403, { requestId });
  try {
    const result = await connectRyzeChannel(createAdminClient(), {
      organizationId: auth.org.orgId, idempotencyKey: req.headers.get("Idempotency-Key") ?? "",
    });
    return ok({ status: result.channel.status, session: result.channel.ryze_instance_name, channel_session_id: result.channel.id }, { requestId });
  } catch (error) {
    if (error instanceof ChannelConnectionError) return fail(error.code,
      error.code === "connection_in_progress" ? "A conexão ainda está sendo preparada. Aguarde e tente novamente." : "Não foi possível concluir a conexão. Tente novamente ou repare o número em Conexões.",
      error.status, { requestId, details: error.technical });
    return fail("internal_error", "Não foi possível concluir a conexão. Tente novamente.", 500, { requestId });
  }
}
