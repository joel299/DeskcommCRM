import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptWebhookSecret, encryptWebhookSecret } from "@/lib/webhooks/secrets";
import { assertDestinoResolvidoSeguro } from "@/lib/automation/outbound-ip";
import { assertSafeOutboundUrl } from "@/lib/automation/outbound-url";

export interface RyzeInstanceDescriptor {
  id?: string;
  name: string;
  token?: string;
  status?: string;
}

export interface RyzeListResponse {
  success?: boolean;
  message?: string;
  instances?: RyzeInstanceDescriptor[];
}

/**
 * Lê o TokenAccount global do ambiente de runtime.
 * NUNCA imprime ou retorna o valor em logs/exceções.
 */
export function getRyzeAccountToken(): string {
  const token = process.env.RYZE_ACCOUNT_TOKEN || (() => {
    const tokenFile = process.env.RYZE_ACCOUNT_TOKEN_FILE;
    if (!tokenFile) return undefined;
    try {
      return readFileSync(tokenFile, "utf8").trim();
    } catch {
      return undefined;
    }
  })();
  if (!token) {
    throw new Error("ryze_account_token_missing: RYZE_ACCOUNT_TOKEN ausente no runtime");
  }
  return token;
}

/**
 * Lista as instâncias registradas na conta Ryze usando a TokenAccount global.
 * Fail-closed: se a resposta for HTTP 200 porém sem JSON válido, success=false ou instâncias ausentes,
 * lança erro explícito (JAMAIS retorna array vazio para não autorizar CREATE indevido).
 */
export async function listRyzeInstances(options?: {
  accountToken?: string;
  baseUrl?: string;
}): Promise<RyzeInstanceDescriptor[]> {
  const token = options?.accountToken || getRyzeAccountToken();
  const baseUrl = options?.baseUrl || process.env.RYZE_API_BASE_URL || "https://ryzeapi.cloud";

  const parsed = new URL(baseUrl);
  assertSafeOutboundUrl(parsed.toString());
  await assertDestinoResolvidoSeguro(parsed.hostname);

  const res = await fetch(`${baseUrl}/api/instance/list`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      token,
    },
  });

  if (!res.ok) {
    const status = res.status;
    if (status === 401) throw new Error("ryze_control_plane_auth_failed: 401 token da conta invalido");
    throw new Error(`ryze_control_plane_failed: HTTP ${status}`);
  }

  const json = (await res.json().catch(() => null)) as RyzeListResponse | null;
  if (!json || json.success === false || !Array.isArray(json.instances)) {
    throw new Error("ryze_instance_list_invalid_response: resposta da listagem malformada ou sem campo instances");
  }

  return json.instances;
}

export async function lookupRyzeSession(
  db: SupabaseClient,
  organizationId: string,
  instanceName: string,
): Promise<{ id: string | null; error: string | null }> {
  const { data, error } = await db
    .from("channel_sessions")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("provider", "ryze")
    .eq("ryze_instance_name", instanceName)
    .is("archived_at", null)
    .maybeSingle();

  if (error) return { id: null, error: "lookup_failed" };
  return { id: data?.id ?? null, error: null };
}

/**
 * Persiste a sessão do tenant de forma explícita e isolada (INSERT se nova, UPDATE por ID confiável se existente).
 */
export async function persistRyzeSession(
  db: SupabaseClient,
  params: {
    organizationId: string;
    instanceName: string;
    encryptedToken: string;
    webhookSecretEncrypted?: string;
  }
): Promise<{ id?: string; action: "inserted" | "updated" }> {
  const { organizationId, instanceName, encryptedToken, webhookSecretEncrypted } = params;

  const { id: existingSessionId, error: lookupErr } = await lookupRyzeSession(db, organizationId, instanceName);

  if (lookupErr) {
    throw new Error("ryze_session_lookup_failed: falha ao consultar sessao existente");
  }

  if (existingSessionId) {
    const { error: updateErr } = await db
      .from("channel_sessions")
      .update({
        ryze_token_encrypted: encryptedToken,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existingSessionId)
      .eq("organization_id", organizationId);

    if (updateErr) {
      throw new Error(`ryze_session_persistence_failed: ${updateErr.message}`);
    }
    return { id: existingSessionId, action: "updated" };
  }

  if (!webhookSecretEncrypted) {
    throw new Error("ryze_webhook_secret_required: nova sessao exige webhook secret cifrado");
  }

  const { error: insertErr } = await db
    .from("channel_sessions")
    .insert({
      organization_id: organizationId,
      provider: "ryze",
      ryze_instance_name: instanceName,
      ryze_token_encrypted: encryptedToken,
      webhook_secret_encrypted: webhookSecretEncrypted,
      metadata: {},
    });

  if (insertErr) {
    throw new Error(`ryze_session_persistence_failed: ${insertErr.message}`);
  }
  return { action: "inserted" };
}

async function configureRyzeWebhook(params: {
  instanceName: string;
  instanceToken: string;
  webhookPathToken: string;
  webhookSecret: string;
  baseUrl: string;
}): Promise<void> {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) throw new Error("ryze_webhook_base_url_missing: NEXT_PUBLIC_APP_URL ausente no runtime");
  const webhookUrl = `${appUrl.replace(/\/$/, "")}/api/v1/webhooks/channel/${params.webhookPathToken}`;
  const headers = { "Content-Type": "application/json", token: params.instanceToken };
  const update = await fetch(`${params.baseUrl}/api/events/webhook/${encodeURIComponent(params.instanceName)}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ label: "default", enabled: true, url: webhookUrl, authorization: `Bearer ${params.webhookSecret}`, byEvents: false, events: ["message.exchange"], mediaBase64: false }),
  });
  if (!update.ok) throw new Error(`ryze_webhook_configure_failed: HTTP ${update.status}`);
  const readback = await fetch(`${params.baseUrl}/api/events/getWebhook/${encodeURIComponent(params.instanceName)}`, { headers });
  if (!readback.ok) throw new Error(`ryze_webhook_readback_failed: HTTP ${readback.status}`);
  const json = (await readback.json().catch(() => null)) as { webhooks?: Array<Record<string, unknown>> } | null;
  const webhooks = Array.isArray(json?.webhooks) ? json.webhooks : [];
  const active = webhooks.filter((webhook) => webhook.enabled === true);
  const primary = active.find((webhook) => webhook.label === "default");
  if (!primary || primary.url !== webhookUrl || primary.byEvents !== false || primary.mediaBase64 !== false || JSON.stringify(primary.events) !== JSON.stringify(["message.exchange"])) {
    throw new Error("ryze_webhook_readback_mismatch: configuração oficial divergente");
  }
  for (const duplicate of active.filter((webhook) => webhook.label !== "default" && typeof webhook.label === "string")) {
    const disable = await fetch(`${params.baseUrl}/api/events/webhook/${encodeURIComponent(params.instanceName)}`, { method: "POST", headers, body: JSON.stringify({ label: duplicate.label, enabled: false }) });
    if (!disable.ok) throw new Error(`ryze_webhook_duplicate_disable_failed: HTTP ${disable.status}`);
  }
}

/**
 * Provisiona ou reutiliza uma instância Ryze para uma organização (idempotente).
 * Se a listagem falhar ou for inválida, falha fechado (CREATE = 0).
 * Se a instância já existir no plano de controle, JAMAIS dispara POST /api/instance/create.
 */
export async function provisionRyzeInstance(params: {
  organizationId: string;
  instanceName: string;
  db: SupabaseClient;
  baseUrl?: string;
}): Promise<{ instanceName: string; isNew: boolean }> {
  const { organizationId, instanceName, db } = params;
  const accountToken = getRyzeAccountToken();
  const baseUrl = params.baseUrl || process.env.RYZE_API_BASE_URL || "https://ryzeapi.cloud";

  const parsed = new URL(baseUrl);
  assertSafeOutboundUrl(parsed.toString());
  await assertDestinoResolvidoSeguro(parsed.hostname);

  // 1. Listar e verificar se a instância já existe (list-before-create fail-closed)
  const instances = await listRyzeInstances({ accountToken, baseUrl });
  const existing = instances.find((i) => i.name === instanceName);

  let tokenInstance: string | undefined;
  let isNew = false;
  let webhookSecretEncrypted: string | undefined;

  if (existing) {
    // Instância JÁ EXISTE no plano de controle -> JAMAIS disparar create
    if (existing.token) {
      tokenInstance = existing.token;
    } else {
      // Verificar se o tenant já possui credencial salva para esta instância
      const { data: dbCred } = await db
        .from("channel_sessions")
        .select("ryze_token_encrypted")
        .eq("organization_id", organizationId)
        .eq("provider", "ryze")
        .eq("ryze_instance_name", instanceName)
        .is("archived_at", null)
        .maybeSingle();

      if (dbCred?.ryze_token_encrypted) {
        tokenInstance = (await decryptWebhookSecret(db, dbCred.ryze_token_encrypted)) ?? undefined;
      } else {
        throw new Error("ryze_existing_instance_token_unavailable: a instancia ja existe no plano de controle mas o token nao esta disponivel para re-vinculo");
      }
    }
  } else {
    // Pré-cifrar antes do efeito externo: falha de webhook não pode consumir a única instância.
    const webhookSecret = randomBytes(32).toString("base64url");
    webhookSecretEncrypted = await encryptWebhookSecret(db, webhookSecret) ?? undefined;
    if (!webhookSecretEncrypted) {
      throw new Error("ryze_control_webhook_encrypt_failed: falha ao criptografar webhook secret");
    }

    // Instância NÃO existe -> Criar UMA instância
    const createRes = await fetch(`${baseUrl}/api/instance/new`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        token: accountToken,
      },
      body: JSON.stringify({ name: instanceName }),
    });

    if (!createRes.ok) {
      const status = createRes.status;
      if (status === 401) throw new Error("ryze_control_plane_auth_failed: 401 token da conta invalido");
      throw new Error(`ryze_instance_create_failed: HTTP ${status}`);
    }

    const createJson = (await createRes.json().catch(() => null)) as {
      success?: boolean;
      instance?: RyzeInstanceDescriptor;
      data?: { name?: string; token?: string };
    } | null;

    if (!createJson || createJson.success === false) {
      throw new Error("ryze_instance_create_invalid_response: resposta de criação inválida");
    }

    tokenInstance = createJson.instance?.token || createJson.data?.token;
    isNew = true;

    if (!tokenInstance) {
      throw new Error("ryze_token_instance_missing: nao foi possivel obter TokenInstance da resposta do create");
    }
  }

  // 2. Cifrar TokenInstance e, para uma nova sessão, gerar e cifrar webhook secret real.
  if (!tokenInstance) throw new Error("ryze_token_instance_missing: TokenInstance indisponível para reconciliar webhook");
  const encryptedToken = await encryptWebhookSecret(db, tokenInstance);
  if (!encryptedToken) {
    throw new Error("ryze_control_encrypt_failed: falha ao criptografar TokenInstance");
  }

  const sessionLookup = await lookupRyzeSession(db, organizationId, instanceName);
  if (sessionLookup.error) {
    throw new Error("ryze_session_lookup_failed: falha ao consultar sessao existente");
  }

  if (!sessionLookup.id && !webhookSecretEncrypted) {
    const webhookSecret = randomBytes(32).toString("base64url");
    webhookSecretEncrypted = await encryptWebhookSecret(db, webhookSecret) ?? undefined;
    if (!webhookSecretEncrypted) {
      throw new Error("ryze_control_webhook_encrypt_failed: falha ao criptografar webhook secret");
    }
  }

  // 3. Persistência tenant-aware via módulo isolado de persistência
  await persistRyzeSession(db, {
    organizationId,
    instanceName,
    encryptedToken,
    webhookSecretEncrypted,
  });

  const { data: persistedSession, error: persistedSessionError } = await db
    .from("channel_sessions")
    .select("webhook_path_token, webhook_secret_encrypted, ryze_token_encrypted")
    .eq("organization_id", organizationId)
    .eq("provider", "ryze")
    .eq("ryze_instance_name", instanceName)
    .is("archived_at", null)
    .maybeSingle();
  if (persistedSessionError || !persistedSession) {
    if (process.env.NODE_ENV === "production") throw new Error("ryze_webhook_session_readback_failed");
    return { instanceName, isNew };
  }
  const webhookSecret = await decryptWebhookSecret(db, String(persistedSession.webhook_secret_encrypted));
  const persistedInstanceToken = tokenInstance ?? (await decryptWebhookSecret(db, String(persistedSession.ryze_token_encrypted)));
  if (typeof persistedSession.webhook_path_token !== "string" || !webhookSecret || !persistedInstanceToken) throw new Error("ryze_webhook_credentials_missing");
  await configureRyzeWebhook({ instanceName, instanceToken: persistedInstanceToken, webhookPathToken: persistedSession.webhook_path_token, webhookSecret, baseUrl });

  return { instanceName, isNew };
}
