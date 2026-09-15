import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  abrirArquivoDoWebhook,
  sanitizarCorpoDoWebhook,
} from "@/lib/channels/arquivo-de-webhook";

describe("arquivo P0 do webhook Ryze", () => {
  it("não persiste segredos root/nested em raw_body nem payload_parsed", async () => {
    let persisted: Record<string, unknown> | null = null;
    const select = vi.fn().mockReturnValue({
      maybeSingle: vi.fn().mockResolvedValue({ data: { id: "archive-1" }, error: null }),
    });
    const insert = vi.fn((payload: Record<string, unknown>) => {
      persisted = payload;
      return { select };
    });
    const admin = {
      from: vi.fn().mockReturnValue({ insert }),
    } as unknown as SupabaseClient;
    const raw = JSON.stringify({
      event: "message.exchange",
      instanceData: {
        token: "ROOT_INSTANCE_SECRET",
        baseUrl: "http://127.0.0.1:8080",
        instance: "demo",
      },
      data: {
        message: { id: "msg-1", direction: "incoming" },
        instanceData: {
          token: "NESTED_INSTANCE_SECRET",
          baseUrl: "http://127.0.0.1:8081",
        },
      },
    });

    const archivedBody = sanitizarCorpoDoWebhook("ryze", raw);
    const result = await abrirArquivoDoWebhook(admin, {
      organizationId: "org-1",
      channelSessionId: "session-1",
      provider: "ryze",
      rawBody: archivedBody,
      headers: new Headers({ authorization: "Bearer WEBHOOK_SECRET", "x-request-id": "req-1" }),
    });

    expect(result).toBe("archive-1");
    expect(raw).toContain("ROOT_INSTANCE_SECRET");
    expect(raw).toContain("NESTED_INSTANCE_SECRET");
    expect(persisted).not.toBeNull();
    const saved = persisted as unknown as Record<string, unknown>;
    expect(String(saved.raw_body)).not.toContain("ROOT_INSTANCE_SECRET");
    expect(String(saved.raw_body)).not.toContain("NESTED_INSTANCE_SECRET");
    expect(String(saved.raw_body)).not.toContain("127.0.0.1");
    expect(JSON.stringify(saved.payload_parsed)).not.toContain("ROOT_INSTANCE_SECRET");
    expect(JSON.stringify(saved.payload_parsed)).not.toContain("NESTED_INSTANCE_SECRET");
    expect(JSON.stringify(saved.payload_parsed)).not.toContain("127.0.0.1");
    expect(JSON.stringify(saved.headers)).not.toContain("WEBHOOK_SECRET");
    expect(JSON.stringify(saved.headers)).toContain("req-1");
  });
});
