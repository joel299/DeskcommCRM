import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ChannelConnectionError } from "./connect-waha";
import { logger } from "@/lib/logger";
import { listRyzeInstances, lookupRyzeSession, provisionRyzeInstance } from "./ryze/control-plane";

function instanceNameFor(input: { organizationId: string; idempotencyKey: string }): string {
  const digest = createHash("sha256").update(`${input.organizationId}:${input.idempotencyKey}`).digest("hex").slice(0, 24);
  return `deskcomm-${input.organizationId.slice(0, 8)}-${digest}`;
}

function mapStatus(status?: string): "STARTING" | "SCAN_QR_CODE" | "WORKING" | "STOPPED" | "FAILED" {
  const s = String(status ?? "").toLowerCase();
  if (["connected", "working"].includes(s)) return "WORKING";
  if (["scan_qr_code", "scan qr code", "qr", "disconnected", "connecting", "qr_code_generated"].includes(s)) return "SCAN_QR_CODE";
  if (s === "stopped") return "STOPPED";
  if (s === "failed") return "FAILED";
  return "STARTING";
}

export async function connectRyzeChannel(
  db: SupabaseClient,
  input: { organizationId: string; idempotencyKey: string; displayName?: string },
): Promise<{ channel: Record<string, unknown>; replay: boolean; instanceName: string; isNew: boolean }> {
  if (!/^[0-9a-f-]{36}$/i.test(input.idempotencyKey)) throw new ChannelConnectionError("idempotency_key_required", 422);
  const instanceName = instanceNameFor(input);
  const existing = await lookupRyzeSession(db, input.organizationId, instanceName);
  if (existing.error) throw new ChannelConnectionError("connection_reservation_failed", 503);
  if (existing.id) {
    const { data } = await db.from("channel_sessions").select("*").eq("id", existing.id).eq("organization_id", input.organizationId).single();
    if (!data) throw new ChannelConnectionError("connection_reservation_missing", 410);
    return { channel: data as Record<string, unknown>, replay: true, instanceName, isNew: false };
  }
  try {
    const provisioned = await provisionRyzeInstance({ organizationId: input.organizationId, instanceName, db });
    const instances = await listRyzeInstances();
    const remote = instances.find((item) => item.name === instanceName);
    const { data, error } = await db.from("channel_sessions").select("*").eq("organization_id", input.organizationId).eq("provider", "ryze").eq("ryze_instance_name", instanceName).maybeSingle();
    if (error || !data) throw new Error("ryze_session_persistence_missing");
    const updated = await db.from("channel_sessions").update({ display_name: input.displayName ?? null, status: mapStatus(remote?.status), status_reason: null, last_status_change_at: new Date().toISOString() }).eq("id", data.id).eq("organization_id", input.organizationId).select("*").single();
    if (updated.error || !updated.data) throw new Error("ryze_session_status_sync_failed");
    return { channel: updated.data as Record<string, unknown>, replay: false, instanceName, isNew: provisioned.isNew };
  } catch (cause) {
    if (cause instanceof ChannelConnectionError) throw cause;
    const message = cause instanceof Error ? cause.message : "";
    logger.error("[channels.ryze] connection failed", { code: message.split(":")[0] || "unknown", organization_id: input.organizationId, instance_name: instanceName });
    const mapped = message.includes("ryze_control_plane_auth_failed") ? { code: "ryze_auth_failed", status: 401 } : message.includes("ryze_account_token_missing") ? { code: "ryze_not_configured", status: 503 } : { code: "ryze_connection_failed", status: 502 };
    throw new ChannelConnectionError(mapped.code, mapped.status, { provider: "ryze" });
  }
}
