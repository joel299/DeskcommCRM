import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { ingestRyzeInbound } from "@/lib/channels/ryze/ingest";

const efeitos = vi.hoisted(() => ({ aplicar: vi.fn() }));
vi.mock("@/lib/channels/pos-entrada", () => ({ aplicarEfeitosPosEntrada: efeitos.aplicar }));

type QueryResult = { data: unknown; error: { code?: string; message: string } | null };

function adminFake(options: {
  insert?: QueryResult;
  status?: QueryResult;
  outgoing?: QueryResult;
  eventDuplicateAfterFirst?: boolean;
  finishError?: boolean;
} = {}) {
  let eventClaims = 0;
  const calls: Array<{ op: string; table?: string; values?: unknown }> = [];
  const rpc = vi.fn(async (name: string) => {
    calls.push({ op: name });
    if (name === "fn_upsert_wa_contact") return { data: "contact-1", error: null };
    if (name === "fn_upsert_wa_conversation") return { data: "conversation-1", error: null };
    if (name === "fn_claim_ryze_webhook_event") {
      eventClaims += 1;
      return options.eventDuplicateAfterFirst && eventClaims > 1
        ? { data: [{ outcome: "already_processed", claim_token: null }], error: null }
        : { data: [{ outcome: "claimed", claim_token: `claim-${eventClaims}` }], error: null };
    }
    if (name === "fn_claim_ryze_message_effects") return options.insert?.error?.code === "23505"
      ? { data: [{ outcome: "already_processed", claim_token: null }], error: null }
      : { data: [{ outcome: "claimed", claim_token: "effect-claim-1" }], error: null };
    if (name === "fn_fail_ryze_message_effects") return { data: true, error: null };
    if (name === "fn_finish_ryze_message_effects") return { data: true, error: null };
    if (name === "fn_finish_ryze_webhook_event") return options.finishError
      ? { data: false, error: null }
      : { data: true, error: null };
    return { data: null, error: null };
  });
  const from = vi.fn((table: string) => {
    const builder = {
      insert(values: unknown) {
        calls.push({ op: "insert", table, values });
        return {
          select: () => ({ maybeSingle: async () => {
            if (table === "ryze_webhook_events") {
              eventClaims += 1;
              return options.eventDuplicateAfterFirst && eventClaims > 1
                ? { data: null, error: { code: "23505", message: "duplicate event" } }
                : { data: null, error: null };
            }
            return options.insert ?? { data: { id: "message-1" }, error: null };
          } }),
        };
      },
      update(values: unknown) {
        calls.push({ op: "update", table, values });
        return builder;
      },
      eq() { return builder; },
      not(operator: string, column: string, value: string) {
        calls.push({ op: "not", values: { operator, column, value } });
        return builder;
      },
      select() { return builder; },
      then(resolve: (value: QueryResult) => unknown) {
        return Promise.resolve(options.status ?? options.outgoing ?? { data: [{ id: "message-1" }], error: null }).then(resolve);
      },
      maybeSingle: async () => {
        if (table === "ryze_webhook_events" && options.eventDuplicateAfterFirst && eventClaims > 1) {
          return { data: { state: "processed", locked_until: new Date(Date.now() + 60_000).toISOString() }, error: null };
        }
        if (table === "messages" && options.insert?.error?.code === "23505") {
          return { data: { id: "message-1", conversation_id: "conversation-1", contact_id: "contact-1", body: "Olá" }, error: null };
        }
        return { data: null, error: null };
      },
    };
    return builder;
  });
  return { admin: { rpc, from } as unknown as SupabaseClient, calls };
}

const base = {
  organizationId: "org-1",
  channelSessionId: "session-1",
};

function envelope(direction: "incoming" | "outgoing", extra: Record<string, unknown> = {}) {
  return {
    event: "message.exchange" as const,
    data: {
      id: "event-1",
      message: {
        id: "message-external-1",
        direction,
        text: "Olá",
        remoteJid: "5511999999999@c.us",
        ...extra,
      },
    },
  };
}

describe("Ryze ingestão F4", () => {
  it("insere incoming, marca conversa e aciona efeitos uma vez", async () => {
    efeitos.aplicar.mockClear();
    const { admin, calls } = adminFake();
    const result = await ingestRyzeInbound(admin, { ...base, envelope: envelope("incoming") });

    expect(result).toEqual({ status: "ingested", conversationId: "conversation-1", messageId: "message-1" });
    expect(calls.filter((call) => call.op === "fn_upsert_wa_contact")).toHaveLength(1);
    expect(calls.filter((call) => call.op === "fn_upsert_wa_conversation")).toHaveLength(1);
    expect(calls.filter((call) => call.op === "fn_claim_ryze_message_effects")).toHaveLength(1);
    expect(efeitos.aplicar).toHaveBeenCalledTimes(1);
  });

  it("trata 23505 como duplicate e não aciona efeitos", async () => {
    efeitos.aplicar.mockClear();
    const { admin } = adminFake({ insert: { data: null, error: { code: "23505", message: "duplicate" } } });
    const result = await ingestRyzeInbound(admin, { ...base, envelope: envelope("incoming") });

    expect(result).toEqual({ status: "duplicate", conversationId: "conversation-1" });
    expect(efeitos.aplicar).toHaveBeenCalledTimes(0);
  });

  it("outgoing reconcilia mensagem existente sem criar contato, conversa ou IA", async () => {
    efeitos.aplicar.mockClear();
    const { admin, calls } = adminFake({ outgoing: { data: [{ id: "message-1" }], error: null } });
    const result = await ingestRyzeInbound(admin, { ...base, envelope: envelope("outgoing", { status: "sent" }) });

    expect(result).toEqual({ status: "reconciled", messageId: "message-1" });
    expect(calls.some((call) => call.op === "fn_upsert_wa_contact")).toBe(false);
    expect(calls.some((call) => call.op === "fn_upsert_wa_conversation")).toBe(false);
    expect(efeitos.aplicar).not.toHaveBeenCalled();
  });

  it("status atualiza somente mensagem existente e ignora mensagem desconhecida", async () => {
    efeitos.aplicar.mockClear();
    const { admin, calls } = adminFake({ status: { data: [], error: null } });
    const result = await ingestRyzeInbound(admin, {
      ...base,
      envelope: {
        event: "message.status",
        data: { id: "delivery-1", message: { id: "message-external-1", status: "read" } },
      },
    });

    expect(result).toEqual({ status: "ignored", reason: "mensagem_desconhecida" });
    expect(calls.some((call) => call.op === "insert" && call.table === "messages")).toBe(false);
    expect(calls.some((call) => call.op === "fn_upsert_wa_contact")).toBe(false);
    expect(efeitos.aplicar).not.toHaveBeenCalled();
  });

  it("deduplica reentrega pelo mesmo data.id e executa efeitos uma vez", async () => {
    efeitos.aplicar.mockClear();
    const { admin, calls } = adminFake({ eventDuplicateAfterFirst: true });
    const first = await ingestRyzeInbound(admin, { ...base, envelope: envelope("incoming") });
    const second = await ingestRyzeInbound(admin, { ...base, envelope: envelope("incoming") });

    expect(first.status).toBe("ingested");
    expect(second.status).toBe("duplicate");
    expect(efeitos.aplicar).toHaveBeenCalledTimes(1);
    expect(calls.filter((call) => call.op === "insert" && call.table === "messages")).toHaveLength(1);
  });

  it("claim atômico permite somente um worker concorrente", async () => {
    efeitos.aplicar.mockClear();
    const { admin } = adminFake({ eventDuplicateAfterFirst: true });
    const results = await Promise.all([
      ingestRyzeInbound(admin, { ...base, envelope: envelope("incoming") }),
      ingestRyzeInbound(admin, { ...base, envelope: envelope("incoming") }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["duplicate", "ingested"]);
    expect(efeitos.aplicar).toHaveBeenCalledTimes(1);
  });

  it("não ignora falha de fencing na finalização", async () => {
    const { admin } = adminFake({ finishError: true });
    await expect(ingestRyzeInbound(admin, { ...base, envelope: envelope("incoming") }))
      .rejects.toThrow("ryze_event_finish_failed");
  });
  it("echo outgoing protege estados terminais e failed contra regressão", async () => {
    const { admin, calls } = adminFake({ outgoing: { data: [{ id: "message-1" }], error: null } });
    await ingestRyzeInbound(admin, { ...base, envelope: envelope("outgoing", { status: "sent" }) });

    const filtro = calls.find((call) => call.op === "not")?.values as { value: string };
    expect(filtro.value).toContain("delivered");
    expect(filtro.value).toContain("read");
    expect(filtro.value).toContain("failed");
  });

  it("incoming sem remoteJid/from não usa o destinatário to como identidade", async () => {
    const { admin } = adminFake();
    const result = await ingestRyzeInbound(admin, {
      ...base,
      envelope: envelope("incoming", { remoteJid: undefined, from: undefined, to: "5511888888888" }),
    });
    expect(result).toEqual({ status: "ignored", reason: "incoming_sem_identidade_ou_external_id" });
  });
});
