import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/automation/outbound-ip", () => ({
  assertDestinoResolvidoSeguro: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/automation/outbound-url", () => ({
  assertSafeOutboundUrl: vi.fn(),
}));

import { ryzeAdapter } from "@/lib/channels/adapters/ryze";
import { resolveRyzeCreds } from "@/lib/channels/ryze/credentials";
import type { OutboundEnvelope } from "@/lib/channels/types";

describe("adapter outbound ryze (F3)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
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

  describe("send (envio de mensagem)", () => {
    it("envia texto com token no header e replyTo", async () => {
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
        recipient: {
          isGroup: false,
          groupChatId: null,
          phoneNumber: "+5511999998888",
          waIdentity: null,
        },
        kind: "text",
        body: "Ola Ryze!",
        replyToExternalId: "parent_msg_123",
        db: fakeDb,
      } as any;

      const result = await ryzeAdapter.send(envelope);

      expect(result.externalId).toBe("ryze_msg_999");
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/message/text/instancia_a"),
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            token: "my_ryze_token",
            "Content-Type": "application/json",
          }),
          body: JSON.stringify({
            number: "5511999998888",
            message: "Ola Ryze!",
            replyTo: "parent_msg_123",
          }),
        })
      );
    });

    it("envia midia de imagem e audio voice note com parametro isVoice", async () => {
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
        json: async () => ({ success: true, data: { messageId: "audio_msg_123" } }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const envelope: OutboundEnvelope = {
        organizationId: "org-100",
        sessionRef: "instancia_a",
        to: "5511999998888",
        recipient: {
          isGroup: false,
          groupChatId: null,
          phoneNumber: "+5511999998888",
          waIdentity: null,
        },
        kind: "audio",
        media: { url: "https://example.com/audio.opus", mimeType: "audio/ogg" },
        db: fakeDb,
      } as any;

      const result = await ryzeAdapter.send(envelope);

      expect(result.externalId).toBe("audio_msg_123");
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/message/media/instancia_a"),
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            number: "5511999998888",
            type: "audio",
            mediaUrl: "https://example.com/audio.opus",
            caption: "",
            isVoice: true,
          }),
        })
      );
    });

    it("mapeia erro HTTP 401 para ryze_auth_failed", async () => {
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
        rpc: vi.fn().mockResolvedValue({ data: "bad_token", error: null }),
      } as any;

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));

      const envelope: OutboundEnvelope = {
        organizationId: "org-100",
        sessionRef: "instancia_a",
        to: "5511999998888",
        kind: "text",
        body: "teste",
        db: fakeDb,
      } as any;

      await expect(ryzeAdapter.send(envelope)).rejects.toThrow("ryze_auth_failed: 401 invalid token");
    });

    it("falha explicitamente quando tipo de midia nao for suportado", async () => {
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
        recipient: {
          isGroup: false,
          groupChatId: null,
          phoneNumber: "+5511999998888",
          waIdentity: null,
        },
        kind: "sticker" as any,
        media: { url: "https://example.com/sticker.webp", mimeType: "image/webp" },
        db: fakeDb,
      } as any;

      await expect(ryzeAdapter.send(envelope)).rejects.toThrow("ryze_sticker_not_supported");
    });
  });
});
