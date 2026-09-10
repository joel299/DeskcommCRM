import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const ingest = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("@/lib/channels/ryze/ingest", () => ({
  ingestRyzeInbound: ingest.call,
}));

import { handleInboundWebhook } from "@/lib/channels/inbound";

const secret = "webhook-secret-123456";
const session = {
  id: "session-1",
  organization_id: "org-1",
  provider: "ryze",
  display_name: "Ryze",
  phone_number: null,
};
const admin = {} as SupabaseClient;

function input(rawBody: string, authorization = `Bearer ${secret}`) {
  return { session, rawBody, headers: new Headers({ authorization }), secret };
}

describe("Ryze inbound real — handler, parser e Bearer", () => {
  it("evento desconhecido retorna ignored sem chamar ingest", async () => {
    ingest.call.mockClear();
    const result = await handleInboundWebhook(admin, input(JSON.stringify({ event: "call.update", data: {} })));
    expect(result).toEqual({ ok: true, body: { status: "ignored", reason: "ryze_event_not_supported", event: "call.update" } });
    expect(ingest.call).not.toHaveBeenCalled();
  });

  it("evento suportado malformado retorna contrato inválido", async () => {
    const result = await handleInboundWebhook(admin, input(JSON.stringify({ event: "message.exchange", data: { message: {} } })));
    expect(result).toMatchObject({ ok: false, code: "contrato_violado" });
    expect(result.ok === false && result.message).not.toContain("INSTANCE");
  });

  it("Bearer inválido retorna unauthorized sem chamar ingest", async () => {
    ingest.call.mockClear();
    const result = await handleInboundWebhook(admin, input(JSON.stringify({ event: "call.update", data: {} }), "Bearer wrong-secret-123456"));
    expect(result).toEqual({ ok: false, code: "unauthorized", message: "bad_bearer" });
    expect(ingest.call).not.toHaveBeenCalled();
  });
});
