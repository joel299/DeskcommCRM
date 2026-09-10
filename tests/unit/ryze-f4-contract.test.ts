import { describe, expect, it } from "vitest";

import { lerEnvelopeRyze } from "@/lib/channels/ryze/envelope";
import { sanitizeRyzeWebhookBody, verifyRyzeBearer } from "@/lib/channels/ryze/webhook";

describe("Ryze F4 — autenticação, envelope e sanitização", () => {
  it("valida Bearer com comparação constant-time e rejeita formatos inválidos", () => {
    expect(verifyRyzeBearer("Bearer secret-123", "secret-123")).toBe(true);
    expect(verifyRyzeBearer("Bearer wrong-123", "secret-123")).toBe(false);
    expect(verifyRyzeBearer("Basic secret-123", "secret-123")).toBe(false);
    expect(verifyRyzeBearer("Bearer short", "secret-123")).toBe(false);
    expect(verifyRyzeBearer(null, "secret-123")).toBe(false);
  });

  it("aceita message.exchange com direction vindo exclusivamente de data.message", () => {
    const result = lerEnvelopeRyze(JSON.stringify({
      event: "message.exchange",
      data: {
        id: "evt-1",
        message: { id: "msg-1", direction: "incoming", text: "oi" },
        instanceData: { token: "INSTANCE_SECRET", baseUrl: "http://127.0.0.1:8080" },
      },
    }));

    expect(result.ok).toBe(true);
    expect(result.ok && result.envelope.data.message.direction).toBe("incoming");
  });

  it("recusa direction ausente ou valores fora de incoming/outgoing", () => {
    expect(lerEnvelopeRyze(JSON.stringify({ event: "message.exchange", data: { message: { id: "m" } } })).ok).toBe(false);
    expect(lerEnvelopeRyze(JSON.stringify({ event: "message.exchange", data: { message: { direction: "inbound" } } })).ok).toBe(false);
  });

  it("remove token e baseUrl antes de arquivar sem alterar a cópia em memória", () => {
    const raw = JSON.stringify({
      event: "message.exchange",
      data: { message: { direction: "incoming" } },
      instanceData: { token: "INSTANCE_SECRET", baseUrl: "http://127.0.0.1:8080", name: "inst" },
    });

    const sanitized = sanitizeRyzeWebhookBody(raw);
    expect(sanitized).not.toContain("INSTANCE_SECRET");
    expect(sanitized).not.toContain("127.0.0.1");
    expect(sanitized).toContain("inst");
    expect(raw).toContain("INSTANCE_SECRET");
  });

  it("não arquiva JSON inválido nem payload escalar cru", () => {
    expect(sanitizeRyzeWebhookBody("not-json")).toBe("[REDACTED_RYZE_INVALID_JSON_PAYLOAD]");
    expect(sanitizeRyzeWebhookBody("[1,2,3]")).toBe("[REDACTED_RYZE_NON_OBJECT_PAYLOAD]");
  });
});
