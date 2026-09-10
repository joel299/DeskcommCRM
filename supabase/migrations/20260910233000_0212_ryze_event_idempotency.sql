-- F4 Ryze: deduplicação persistente por evento de webhook.
create table if not exists public.ryze_webhook_events (
  organization_id uuid not null,
  channel_session_id uuid not null,
  event_id text not null,
  event_type text not null,
  state text not null default 'processing' check (state in ('processing', 'processed', 'failed')),
  attempts integer not null default 1,
  locked_until timestamptz not null default (now() + interval '5 minutes'),
  completed_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  primary key (organization_id, channel_session_id, event_id)
);

alter table public.ryze_webhook_events
  add column if not exists state text not null default 'processing',
  add column if not exists attempts integer not null default 1,
  add column if not exists locked_until timestamptz not null default (now() + interval '5 minutes'),
  add column if not exists completed_at timestamptz,
  add column if not exists last_error_code text;

alter table public.ryze_webhook_events
  drop constraint if exists ryze_webhook_events_state_check;

alter table public.ryze_webhook_events
  add constraint ryze_webhook_events_state_check check (state in ('processing', 'processed', 'failed'));

create index if not exists idx_ryze_webhook_events_created_at
  on public.ryze_webhook_events (created_at desc);
