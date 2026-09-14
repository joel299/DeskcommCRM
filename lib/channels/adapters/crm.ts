import type pg from 'pg';

import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelCost,
  ChannelSendInput,
  ChannelSendResult,
  ChannelSessionHealth,
} from '../../agent-engine/channel-adapter';
import { sinalizarDigitando } from '@/lib/messaging/presenca';
import { CrmTransportError, type CrmEdgeConfig } from '../../agent-engine/edge/crm/mcp-client';
import { sendTurnMessage, SendToolError } from '../../agent-engine/edge/crm/send-message';

/** Adapter do agent-engine para o canal persistido na sessão (Ryze em produção). */
export class CrmChannelAdapter implements ChannelAdapter {
  readonly channel = 'crm_session';
  private readonly db: pg.Pool;
  private readonly crmCfg: CrmEdgeConfig;

  constructor(db: pg.Pool, crmCfg: CrmEdgeConfig) {
    this.db = db;
    this.crmCfg = crmCfg;
  }

  async send(input: ChannelSendInput): Promise<ChannelSendResult> {
    try {
      const outcome = await sendTurnMessage(this.db, this.crmCfg, input);
      switch (outcome.kind) {
        case 'sent': return { kind: 'sent', idempotencyKey: outcome.idempotencyKey, messageId: outcome.crmMessageId };
        case 'already_sent': return { kind: 'already_sent', idempotencyKey: outcome.idempotencyKey, messageId: outcome.crmMessageId };
        case 'queued': return { kind: 'queued', idempotencyKey: outcome.idempotencyKey, messageId: outcome.crmMessageId };
        case 'blocked': return { kind: 'blocked', idempotencyKey: outcome.idempotencyKey };
        case 'failed': return { kind: 'failed', idempotencyKey: outcome.idempotencyKey, messageId: outcome.crmMessageId };
      }
    } catch (err) {
      if (err instanceof CrmTransportError || err instanceof SendToolError) {
        return { kind: 'unavailable', reason: err.name };
      }
      throw err;
    }
  }

  async signalTyping(input: { tenantId: string; conversationId: string }): Promise<void> {
    await sinalizarDigitando(this.crmCfg.supabase, {
      organizationId: input.tenantId,
      conversationId: input.conversationId,
    });
  }

  async sessionHealth(channelSessionId: string): Promise<ChannelSessionHealth> {
    const { rows } = await this.db.query<{ status: string; updated_at: string | null }>(
      `select status, updated_at::text from channel_sessions
       where id = $1 and archived_at is null`,
      [channelSessionId],
    );
    const row = rows[0];
    if (!row) return { healthy: false, status: 'unknown', since: null };
    return {
      healthy: row.status === 'WORKING',
      status: row.status,
      since: row.updated_at ? new Date(row.updated_at).getTime() : null,
    };
  }

  capabilities(): ChannelCapabilities {
    return { freeformAnytime: true, serviceWindowHours: null };
  }

  costPerMessage(): ChannelCost {
    return { perMessageUsdCents: 0, model: 'flat' };
  }
}
