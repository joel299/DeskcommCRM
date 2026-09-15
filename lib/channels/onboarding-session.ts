import type { SupabaseClient } from "@supabase/supabase-js";

/** Localiza somente a sessão Ryze de onboarding da própria organização. */
export async function loadOnboardingChannel(db: SupabaseClient, organizationId: string) {
  const { data, error } = await db.from("channel_sessions")
    .select("id, organization_id, ryze_instance_name, status, archived_at")
    .eq("organization_id", organizationId).eq("provider", "ryze")
    .or(`metadata->>onboarding.eq.true,ryze_instance_name.eq.org_${organizationId.slice(0, 8)}`)
    .order("created_at").limit(1).maybeSingle();
  if (error) throw new Error(error.message);
  return data as { id: string; organization_id: string; ryze_instance_name: string; status: string; archived_at: string | null } | null;
}
