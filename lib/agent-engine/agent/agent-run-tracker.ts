import type pg from 'pg';

import type { PublishedAgentConfig } from './agent-config';
import type { JobRow } from '../queue/queue';

type RunContext = {
  organizationId: string;
  conversationId: string;
  contactId: string;
  channelSessionId: string;
  inboundMessageId: string;
  agent: PublishedAgentConfig;
};

const safeError = (error: unknown): { code: string; message: string } => {
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: message.slice(0, 80).replace(/[^a-zA-Z0-9_.-]+/g, '_') || 'agent_turn_failed',
    message: message.slice(0, 500).replace(/[\r\n]+/g, ' '),
  };
};

export async function startAgentRun(pool: pg.Pool, job: JobRow, ctx: RunContext): Promise<void> {
  await pool.query(
    `insert into ai_agent_runs
       (id, organization_id, agent_id, agent_version_id, conversation_id, contact_id,
        channel_session_id, inbound_message_id, status, is_dry_run, started_at, completed_at,
        tokens_in, tokens_out, steps_count, tool_calls, error_code, error_message)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'running', false, now(), null, 0, 0, 0, '[]'::jsonb, null, null)
     on conflict (id) do update set
       status = 'running', started_at = now(), completed_at = null,
       tokens_in = 0, tokens_out = 0, steps_count = 0, tool_calls = '[]'::jsonb,
       error_code = null, error_message = null, outbound_message_id = null`,
    [
      job.id, ctx.organizationId, ctx.agent.agentId, ctx.agent.versionId,
      ctx.conversationId, ctx.contactId, ctx.channelSessionId, ctx.inboundMessageId,
    ],
  );
}

export async function finishAgentRun(
  pool: pg.Pool,
  job: JobRow,
  outcome: { ok: true } | { ok: false; error: unknown },
): Promise<void> {
  const calls = await pool.query<{
    id: string; provider: string; model: string; purpose: string;
    input_tokens: number; output_tokens: number; cost_cents: string | number | null;
    latency_ms: number | null;
  }>(
    `select id, provider, model, purpose, input_tokens, output_tokens, cost_cents, latency_ms
       from llm_calls where job_id = $1 order by created_at asc, id asc`,
    [job.id],
  );
  const trace = calls.rows.map((call) => ({
    call_id: call.id, provider: call.provider, model: call.model, purpose: call.purpose,
    input_tokens: Number(call.input_tokens ?? 0), output_tokens: Number(call.output_tokens ?? 0),
    latency_ms: call.latency_ms === null ? null : Number(call.latency_ms),
  }));
  const inputTokens = calls.rows.reduce((sum, call) => sum + Number(call.input_tokens ?? 0), 0);
  const outputTokens = calls.rows.reduce((sum, call) => sum + Number(call.output_tokens ?? 0), 0);
  const costCents = calls.rows.reduce((sum, call) => sum + Number(call.cost_cents ?? 0), 0);
  const latencyMs = calls.rows.reduce((sum, call) => sum + Number(call.latency_ms ?? 0), 0);
  const outbound = await pool.query<{ id: string }>(
    `select id from messages
       where conversation_id = $1 and direction = 'outbound' and sent_via = 'ai'
         and sent_at >= (select started_at from ai_agent_runs where id = $2)
       order by sent_at desc, id desc limit 1`,
    [(job.payload as { conversation_id?: string }).conversation_id, job.id],
  );
  const invalidSuccess =
    outcome.ok &&
    (calls.rows.length === 0 || inputTokens <= 0 || outputTokens <= 0 || trace.length === 0);
  const error = outcome.ok
    ? invalidSuccess
      ? { code: 'empty_model_trace', message: 'agent run completed without a positive model trace' }
      : null
    : safeError(outcome.error);
  await pool.query(
    `update ai_agent_runs
        set status = $2, completed_at = now(), tokens_in = $3, tokens_out = $4,
            cost_cents = $5, latency_ms = $6, steps_count = $7, tool_calls = $8::jsonb,
            outbound_message_id = $9, error_code = $10, error_message = $11
      where id = $1`,
    [
      job.id, error === null ? 'completed' : 'failed', inputTokens, outputTokens, costCents,
      latencyMs || null, trace.length, JSON.stringify(trace), outbound.rows[0]?.id ?? null,
      error?.code ?? null, error?.message ?? null,
    ],
  );
  if (error !== null && outcome.ok) throw new Error(error.message);
}
