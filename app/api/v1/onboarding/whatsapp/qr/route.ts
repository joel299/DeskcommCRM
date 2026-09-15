import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { createClient } from "@/lib/supabase/server";
import { loadOnboardingChannel } from "@/lib/channels/onboarding-session";
import { ok, fail } from "@/lib/api/wrappers";

/** QR de onboarding é provido pelo fluxo oficial Ryze; WAHA não participa. */
export async function GET() {
  const user = await loadAuthUser();
  if (!user) return fail("unauthenticated", "Sessão expirada", 401);
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) return fail("tenant_not_found", "Sem organização ativa", 404);

  try {
    const channel = await loadOnboardingChannel(await createClient(), activeOrg.orgId);
    if (!channel || channel.archived_at) {
      return ok({ status: "NOT_STARTED", session: null, provider: "ryze" });
    }

    // A instância existente e conectada não precisa de QR. Retornamos o estado
    // real para o cliente encerrar o polling sem iniciar outro pareamento.
    if (channel.status === "WORKING") {
      return ok({
        status: "WORKING",
        session: channel.ryze_instance_name,
        channel_session_id: channel.id,
        provider: "ryze",
      });
    }

    return ok({
      status: channel.status,
      session: channel.ryze_instance_name,
      channel_session_id: channel.id,
      provider: "ryze",
    });
  } catch {
    return fail("connection_status_failed", "Não foi possível consultar a instância Ryze.", 502);
  }
}
