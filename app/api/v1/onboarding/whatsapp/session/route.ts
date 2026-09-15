import { randomUUID } from "node:crypto";
import { ok, fail } from "@/lib/api/wrappers";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";
import { connectRyzeChannel } from "@/lib/channels/connect-ryze";

import { loadOnboardingChannel } from "@/lib/channels/onboarding-session";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const user = await loadAuthUser(); if (!user) return fail("unauthenticated", "Sessão expirada", 401, { requestId });
  const org = await resolveActiveOrg(user); if (!org) return fail("tenant_not_found", "Sem organização ativa", 404, { requestId });
  if (await mfaEmDivida()) return fail("mfa_required", "Confirme a verificação em duas etapas.", 403, { requestId });
  try {
    const db = await createClient(); const channel = await loadOnboardingChannel(db, org.orgId);
    if (!channel || channel.archived_at) return ok({ status: "NOT_STARTED", session: null }, { requestId });
    const status = channel.status;
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
    const result = await connectRyzeChannel(await createClient(), {
      organizationId: auth.org.orgId, idempotencyKey: req.headers.get("Idempotency-Key") ?? randomUUID(),
      displayName: "WhatsApp onboarding",
    });
    return ok({ status: result.channel.status, session: result.channel.ryze_instance_name, channel_session_id: result.channel.id }, { requestId });
  } catch (error) {
    return fail("internal_error", "Não foi possível concluir a conexão. Tente novamente.", 500, { requestId });
  }
}
