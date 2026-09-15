import type { SupabaseClient } from "@supabase/supabase-js";

import { CHANNEL_PROVIDER_RYZE } from "./capabilities";

/**
 * Decide na fronteira de canais se o agent-engine é o proprietário da resposta.
 * Workers fora da fronteira não devem conhecer nomes de transportes.
 */
export async function isAgentEngineOwnedSession(
  admin: SupabaseClient,
  organizationId: string,
  channelSessionId: string,
): Promise<boolean> {
  const { data } = await admin
    .from("channel_sessions")
    .select("provider")
    .eq("organization_id", organizationId)
    .eq("id", channelSessionId)
    .maybeSingle();
  return data?.provider === CHANNEL_PROVIDER_RYZE;
}
