-- F4 Ryze: deduplicação persistente por evento de webhook.
create table if not exists public.ryze_webhook_events (
  organization_id uuid not null,
  channel_session_id uuid not null,
  event_id text not null,
  event_type text not null,
  created_at timestamptz not null default now(),
  primary key (organization_id, channel_session_id, event_id)
);

create index if not exists idx_ryze_webhook_events_created_at
  on public.ryze_webhook_events (created_at desc);
