import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

export interface RyzeCredentials {
  instanceName: string;
  tokenInstance: string;
  baseUrl: string;
  /** De onde veio — para diagnóstico. Nunca logue o token. */
  source: "session" | "env";
}

/** A chave da busca por credenciais com isolamento tenant-aware obrigatório. */
export interface RyzeCredsLookup {
  organizationId: string;
  instanceName: string;
}

/**
 * Resolve as credenciais da instância Ryze para uma organização.
 * NUNCA busca apenas pelo instanceName (evita colisão cross-tenant).
 */
export async function resolveRyzeCreds(
  db: SupabaseClient,
  lookup: RyzeCredsLookup
): Promise<RyzeCredentials | null> {
  const { data, error } = await db
    .from("channel_sessions")
    .select("ryze_instance_name, ryze_token_encrypted")
    .eq("organization_id", lookup.organizationId)
    .eq("provider", "ryze")
    .eq("ryze_instance_name", lookup.instanceName)
    .is("archived_at", null)
    .maybeSingle();

  if (!error && data?.ryze_instance_name && data?.ryze_token_encrypted) {
    const rawCipher = data.ryze_token_encrypted;
    const cipherStr = typeof rawCipher === "string"
      ? rawCipher
      : typeof Buffer !== "undefined" && Buffer.isBuffer(rawCipher)
      ? `\\x${rawCipher.toString("hex")}`
      : String(rawCipher);

    const tokenInstance = await decryptWebhookSecret(db, cipherStr);
    if (tokenInstance) {
      const baseUrl = process.env.RYZE_API_BASE_URL || "https://ryzeapi.cloud";
      return {
        instanceName: data.ryze_instance_name,
        tokenInstance,
        baseUrl,
        source: "session",
      };
    }
  }

  // Fallback seguro por variável de ambiente em ambiente de dev/teste local
  const envInstance = process.env.RYZE_INSTANCE_NAME;
  const envToken = process.env.RYZE_TOKEN_INSTANCE;
  const envBaseUrl = process.env.RYZE_API_BASE_URL || "https://ryzeapi.cloud";
  if (envInstance && envToken && envInstance === lookup.instanceName) {
    return {
      instanceName: envInstance,
      tokenInstance: envToken,
      baseUrl: envBaseUrl,
      source: "env",
    };
  }

  return null;
}
