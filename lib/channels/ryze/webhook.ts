import { timingSafeEqual } from "node:crypto";

export function isRyzeProvider(provider: string): boolean {
  return provider === "ryze";
}


export function verifyRyzeBearer(headerValue: string | null, secret: string | null): boolean {
  if (!headerValue || !secret || !headerValue.startsWith("Bearer ")) return false;
  const received = headerValue.slice("Bearer ".length);
  const a = Buffer.from(received, "utf8");
  const b = Buffer.from(secret, "utf8");
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Remove segredos do corpo antes de qualquer persistência forense.
 * O corpo original permanece apenas em memória para autenticação/ingestão.
 */
export function sanitizeRyzeWebhookBody(rawBody: string): string {
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return "[REDACTED_RYZE_NON_OBJECT_PAYLOAD]";
    }

    const root = structuredClone(parsed) as Record<string, unknown>;
    const instanceData = root.instanceData;
    if (instanceData && typeof instanceData === "object" && !Array.isArray(instanceData)) {
      delete (instanceData as Record<string, unknown>).token;
      delete (instanceData as Record<string, unknown>).baseUrl;
    }
    return JSON.stringify(root);
  } catch {
    return "[REDACTED_RYZE_INVALID_JSON_PAYLOAD]";
  }
}
