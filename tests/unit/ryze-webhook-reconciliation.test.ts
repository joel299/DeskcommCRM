import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/webhooks/secrets", () => ({
  decryptWebhookSecret: vi.fn(async () => "webhook-secret-123456"),
  encryptWebhookSecret: vi.fn(),
}));
vi.mock("@/lib/automation/outbound-ip", () => ({ assertDestinoResolvidoSeguro: vi.fn() }));
vi.mock("@/lib/automation/outbound-url", () => ({ assertSafeOutboundUrl: vi.fn() }));
vi.mock("@/lib/channels/ryze/credentials", () => ({
  resolveRyzeCreds: vi.fn(async () => ({ tokenInstance: "instance-token" })),
}));

import { reconcileRyzeWebhook } from "@/lib/channels/ryze/control-plane";

function dbFixture() {
  const query = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({
      data: {
        id: "session-1",
        webhook_path_token: "path-token",
        webhook_secret_encrypted: "\\xsecret",
      },
      error: null,
    }),
  };
  return { from: vi.fn(() => query) } as never;
}

describe("Ryze webhook reconciliation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.NEXT_PUBLIC_APP_URL = "https://deskcomm-ryze.example";
    process.env.RYZE_API_BASE_URL = "https://ryzeapi.cloud";
  });

  it("reuses the session, disables active duplicates, configures the exact contract and validates read-back", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({
        success: true,
        webhooks: [
          { label: "default", enabled: true },
          { label: "legacy", enabled: true },
        ],
      }) })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ success: true }) })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ success: true }) })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({
        success: true,
        webhook: {
          label: "default",
          enabled: true,
          url: "https://deskcomm-ryze.example/api/v1/webhooks/channel/path-token",
          authorization: "Bearer webhook-secret-123456",
          byEvents: false,
          events: ["message.exchange"],
          mediaBase64: false,
        },
      }) });
    vi.stubGlobal("fetch", fetchMock);

    await reconcileRyzeWebhook(dbFixture(), {
      organizationId: "org-1",
      instanceName: "deskcomm-instance",
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ label: "legacy", enabled: false }));
    expect(JSON.parse(fetchMock.mock.calls[2]?.[1]?.body as string)).toEqual({
      label: "default",
      enabled: true,
      url: "https://deskcomm-ryze.example/api/v1/webhooks/channel/path-token",
      authorization: "Bearer webhook-secret-123456",
      byEvents: false,
      events: ["message.exchange"],
      mediaBase64: false,
    });
    expect(fetchMock.mock.calls[3]?.[0]).toContain("?label=default");
  });

  it("falha quando o read-back diverge do contrato literal", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ success: true, webhooks: [] }) })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ success: true }) })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({
        success: true,
        webhook: {
          label: "default",
          enabled: true,
          url: "https://deskcomm-ryze.example/api/v1/webhooks/channel/path-token",
          authorization: "Bearer \"webhook-secret-123456\"",
          byEvents: false,
          events: ["message.exchange"],
          mediaBase64: false,
        },
      }) }));

    await expect(reconcileRyzeWebhook(dbFixture(), {
      organizationId: "org-1",
      instanceName: "deskcomm-instance",
    })).rejects.toThrow("ryze_webhook_readback_mismatch");
  });
});
