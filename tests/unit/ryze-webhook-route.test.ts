import { describe, expect, it, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  closed: [] as Array<{ status: string; validSignature: boolean | null }>,
  handled: [] as unknown[],
}));

const SECRET = "webhook-secret-123456";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: async () => SECRET }));
vi.mock("@/lib/channels/archived", () => ({
  ARCHIVED_AT: "archived_at",
  queryTolerantToMissingArchived: async () => ({
    data: {
      id: "session-1",
      organization_id: "org-1",
      provider: "ryze",
      display_name: "Ryze",
      phone_number: null,
      webhook_secret_encrypted: "ciphertext",
      archived_at: null,
    },
    error: null,
  }),
}));
vi.mock("@/lib/channels/arquivo-de-webhook", () => ({
  sanitizarCorpoDoWebhook: (_provider: string, raw: string) => raw,
  abrirArquivoDoWebhook: async () => "archive-1",
  fecharArquivoDoWebhook: async (_admin: unknown, _id: unknown, result: { status: string; validSignature: boolean | null }) => {
    state.closed.push(result);
  },
}));
vi.mock("@/lib/channels/inbound", () => ({
  acceptsInboundWebhook: () => true,
  mensagemSeguraDoInbound: (_provider: string, code: string, message: string) => code === "unauthorized" ? "webhook_unauthorized" : code === "invalid_json" ? "payload_invalid_json" : code === "contrato_violado" ? "payload_contract_invalid" : message,
  handleInboundWebhook: async (_admin: unknown, input: unknown) => {
    state.handled.push(input);
    const raw = (input as { rawBody: string }).rawBody;
    if (raw.includes("call.update")) return { ok: true, body: { status: "ignored", reason: "ryze_event_not_supported" } };
    if (raw.includes("malformed")) return { ok: false, code: "contrato_violado", message: "payload fora do contrato" };
    return { ok: false, code: "unauthorized", message: "bad_bearer" };
  },
}));

import { POST } from "@/app/api/v1/webhooks/channel/[token]/route";

const context = { params: Promise.resolve({ token: "webhook-token-1" }) } as never;
const request = (body: unknown, authorization = `Bearer ${SECRET}`) => ({
  text: async () => JSON.stringify(body),
  headers: new Headers({ authorization }),
}) as never;

beforeEach(() => {
  state.closed.length = 0;
  state.handled.length = 0;
});

describe("rota neutra — contrato HTTP Ryze", () => {
  it("evento não suportado responde 200 ignored e fecha arquivo como processed", async () => {
    const response = await POST(request({ event: "call.update", data: {} }), context);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { status: "ignored", reason: "ryze_event_not_supported" } });
    expect(state.handled).toHaveLength(1);
    expect(state.closed).toEqual([{ status: "processed", validSignature: true, erro: "ryze_event_not_supported" }]);
  });

  it("contrato suportado inválido responde 400 sem marcar assinatura inválida", async () => {
    const response = await POST(request({ event: "message.exchange", malformed: true }), context);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
    expect(state.closed).toEqual([{ status: "error", validSignature: null, erro: "payload_contract_invalid" }]);
  });

  it("Bearer inválido responde 401 e fecha arquivo com assinatura inválida", async () => {
    const response = await POST(request({ event: "message.exchange", data: {} }, "Bearer wrong-secret-123456"), context);

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "unauthorized" } });
    expect(state.closed).toEqual([{ status: "error", validSignature: false, erro: "webhook_unauthorized" }]);
  });
});
