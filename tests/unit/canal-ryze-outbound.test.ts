import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/automation/outbound-ip", () => ({
  assertDestinoResolvidoSeguro: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/automation/outbound-url", () => ({
  assertSafeOutboundUrl: vi.fn(),
}));

import { assertDestinoResolvidoSeguro } from "@/lib/automation/outbound-ip";
import { assertSafeOutboundUrl } from "@/lib/automation/outbound-url";
import { ryzeAdapter, sanitizeRyzeError } from "@/lib/channels/adapters/ryze";
import { resolveRyzeCreds } from "@/lib/channels/ryze/credentials";
import { listRyzeInstances, provisionRyzeInstance, getRyzeAccountToken } from "@/lib/channels/ryze/control-plane";
import type { OutboundEnvelope } from "@/lib/channels/types";

describe("adapter outbound ryze & control plane (F3)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(assertDestinoResolvidoSeguro).mockResolvedValue(undefined);
    vi.mocked(assertSafeOutboundUrl).mockReturnValue(undefined);
  });

  describe("resolveRecipient", () => {
    it("resolve grupo quando isGroup e groupChatId fornecido", () => {
      const recipient = ryzeAdapter.resolveRecipient({
        isGroup: true,
        groupChatId: "123456789@g.us",
        phoneNumber: null,
        waIdentity: null,
      });
      expect(recipient).toBe("123456789@g.us");
    });

    it("resolve telefone formatando apenas dígitos", () => {
      const recipient = ryzeAdapter.resolveRecipient({
        isGroup: false,
        groupChatId: null,
        phoneNumber: "+55 (11) 99999-8888",
        waIdentity: null,
      });
      expect(recipient).toBe("5511999998888");
    });

    it("resolve waIdentity com prefixo phone:", () => {
      const recipient = ryzeAdapter.resolveRecipient({
        isGroup: false,
        groupChatId: null,
        phoneNumber: null,
        waIdentity: "phone:+5511999997777",
      });
      expect(recipient).toBe("5511999997777");
    });

    it("retorna null se nenhum destinatario valido for informado", () => {
      const recipient = ryzeAdapter.resolveRecipient({
        isGroup: false,
        groupChatId: null,
        phoneNumber: null,
        waIdentity: null,
      });
      expect(recipient).toBeNull();
    });
  });

  describe("resolveRyzeCreds (isolamento por tenant)", () => {
    it("isola por organizationId e ryze_instance_name", async () => {
      const mockMaybeSingle = vi.fn().mockResolvedValue({
        data: {
          ryze_instance_name: "instancia_org_a",
          ryze_token_encrypted: Buffer.from("token_cifrado"),
        },
        error: null,
      });

      const fakeDb = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        maybeSingle: mockMaybeSingle,
        rpc: vi.fn().mockResolvedValue({ data: "token_descriptografado", error: null }),
      } as any;

      const creds = await resolveRyzeCreds(fakeDb, {
        organizationId: "org-uuid-111",
        instanceName: "instancia_org_a",
      });

      expect(fakeDb.from).toHaveBeenCalledWith("channel_sessions");
      expect(fakeDb.eq).toHaveBeenCalledWith("organization_id", "org-uuid-111");
      expect(fakeDb.eq).toHaveBeenCalledWith("provider", "ryze");
      expect(fakeDb.eq).toHaveBeenCalledWith("ryze_instance_name", "instancia_org_a");
      expect(creds).not.toBeNull();
      expect(creds?.tokenInstance).toBe("token_descriptografado");
    });

    it("retorna null se a org errada tentar ler credencial de outra org (cross-tenant)", async () => {
      const fakeDb = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      } as any;

      const creds = await resolveRyzeCreds(fakeDb, {
        organizationId: "org-uuid-vitima",
        instanceName: "instancia_alheia",
      });

      expect(creds).toBeNull();
    });
  });

  describe("control plane & provisionamento", () => {
    it("obtem account token do runtime sem imprimir", () => {
      process.env.RYZE_ACCOUNT_TOKEN = "secret_acc_token_123";
      const token = getRyzeAccountToken();
      expect(token).toBe("secret_acc_token_123");
    });

    it("listRyzeInstances chama endpoint de listagem com token no header", async () => {
      process.env.RYZE_ACCOUNT_TOKEN = "acc_token_xyz";
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          instances: [{ id: "1", name: "instancia_1", token: "tok_1" }],
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const instances = await listRyzeInstances();
      expect(instances).toHaveLength(1);
      expect(instances[0]?.name).toBe("instancia_1");
      expect(mockFetch).toHaveBeenCalledWith(
        "https://ryzeapi.cloud/api/instance/list",
        expect.objectContaining({
          headers: expect.objectContaining({ token: "acc_token_xyz" }),
        })
      );
    });

    it("recusa CREATE quando a instancia ja existe no plano de controle mas nao possui token", async () => {
      process.env.RYZE_ACCOUNT_TOKEN = "acc_token_xyz";
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          instances: [{ id: "1", name: "vivo1203" }], // sem token
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const fakeDb = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      } as any;

      await expect(
        provisionRyzeInstance({
          organizationId: "org-100",
          instanceName: "vivo1203",
          db: fakeDb,
        })
      ).rejects.toThrow("ryze_existing_instance_token_unavailable");

      // Garantir zero chamadas ao POST /api/instance/create
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).not.toHaveBeenCalledWith("https://ryzeapi.cloud/api/instance/create", expect.anything());
    });

    it("falha fechado com erro explicito se encryptWebhookSecret retornar null (zero DB writes)", async () => {
      process.env.RYZE_ACCOUNT_TOKEN = "acc_token_xyz";
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          instances: [{ id: "1", name: "instancia_test", token: "tok_test" }],
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const fakeInsert = vi.fn();
      const fakeUpdate = vi.fn();
      const fakeDb = {
        from: vi.fn().mockReturnThis(),
        insert: fakeInsert,
        update: fakeUpdate,
        rpc: vi.fn().mockResolvedValue({ data: null, error: "encrypt_failed" }), // falha na criptografia
      } as any;

      await expect(
        provisionRyzeInstance({
          organizationId: "org-100",
          instanceName: "instancia_test",
          db: fakeDb,
        })
      ).rejects.toThrow("ryze_control_encrypt_failed");

      expect(fakeInsert).not.toHaveBeenCalled();
      expect(fakeUpdate).not.toHaveBeenCalled();
    });

    it("provisiona uma nova instancia inexistente com sucesso", async () => {
      process.env.RYZE_ACCOUNT_TOKEN = "acc_token_xyz";
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ success: true, instances: [] }), // sem instâncias
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ success: true, instance: { name: "nova_instancia", token: "tok_new" } }),
        });
      vi.stubGlobal("fetch", mockFetch);

      const fakeInsert = vi.fn().mockResolvedValue({ data: null, error: null });
      const fakeDb = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        insert: fakeInsert,
        rpc: vi.fn().mockResolvedValue({ data: "\\x636970686572", error: null }),
      } as any;

      const result = await provisionRyzeInstance({
        organizationId: "org-100",
        instanceName: "nova_instancia",
        db: fakeDb,
      });

      expect(result.isNew).toBe(true);
      expect(result.instanceName).toBe("nova_instancia");
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch).toHaveBeenNthCalledWith(2, "https://ryzeapi.cloud/api/instance/create", expect.anything());
      expect(fakeInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          organization_id: "org-100",
          provider: "ryze",
          ryze_instance_name: "nova_instancia",
        })
      );
    });
  });

  describe("send (envio de mensagem & SSRF & sanitizacao)", () => {
    it("passa SOMENTE o hostname (ryzeapi.cloud) ao guard DNS assertDestinoResolvidoSeguro", async () => {
      const fakeDb = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: {
            ryze_instance_name: "instancia_a",
            ryze_token_encrypted: Buffer.from("enc_token"),
          },
          error: null,
        }),
        rpc: vi.fn().mockResolvedValue({ data: "my_ryze_token", error: null }),
      } as any;

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: { messageId: "ryze_msg_999" } }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const envelope: OutboundEnvelope = {
        organizationId: "org-100",
        sessionRef: "instancia_a",
        to: "5511999998888",
        kind: "text",
        body: "Ola Ryze!",
        db: fakeDb,
      } as any;

      await ryzeAdapter.send(envelope);

      expect(assertSafeOutboundUrl).toHaveBeenCalledWith("https://ryzeapi.cloud/");
      expect(assertDestinoResolvidoSeguro).toHaveBeenCalledWith("ryzeapi.cloud");
      expect(assertDestinoResolvidoSeguro).not.toHaveBeenCalledWith("https://ryzeapi.cloud");
    });

    it("sanitiza mensagens de erro adversarias impedindo vazamento de token", () => {
      const syntheticToken = "SECRET_TOKEN_RYZE_999";
      const rawError = { code: "AUTH_ERROR", error: `Invalid token supplied: ${syntheticToken}` };

      const sanitized = sanitizeRyzeError(400, rawError, syntheticToken);

      expect(sanitized).not.toContain(syntheticToken);
      expect(sanitized).toContain("[REDACTED]");
    });

    it("mapeia erros HTTP conforme matriz de erros (401, 403, 404, 429, 500, 503)", async () => {
      const fakeDb = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: {
            ryze_instance_name: "instancia_a",
            ryze_token_encrypted: Buffer.from("enc_token"),
          },
          error: null,
        }),
        rpc: vi.fn().mockResolvedValue({ data: "token", error: null }),
      } as any;

      const envelope: OutboundEnvelope = {
        organizationId: "org-100",
        sessionRef: "instancia_a",
        to: "5511999998888",
        kind: "text",
        body: "teste",
        db: fakeDb,
      } as any;

      // 401
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }));
      await expect(ryzeAdapter.send(envelope)).rejects.toThrow("ryze_auth_failed: 401 invalid token");

      // 403
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({}) }));
      await expect(ryzeAdapter.send(envelope)).rejects.toThrow("ryze_permission_denied: 403 instance mismatch");

      // 404
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }));
      await expect(ryzeAdapter.send(envelope)).rejects.toThrow("ryze_instance_not_found: 404 instance not found");

      // 429
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) }));
      await expect(ryzeAdapter.send(envelope)).rejects.toThrow("ryze_rate_limited: 429 rate limit");

      // 500
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }));
      await expect(ryzeAdapter.send(envelope)).rejects.toThrow("ryze_instance_disconnected: HTTP 500");

      // 503
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }));
      await expect(ryzeAdapter.send(envelope)).rejects.toThrow("ryze_instance_disconnected: HTTP 503");
    });
  });
});
