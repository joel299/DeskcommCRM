alter table public.ryze_webhook_events
  add column if not exists claim_token uuid;

create or replace function public.fn_claim_ryze_webhook_event(
  p_org uuid,
  p_session uuid,
  p_event text,
  p_event_type text
)
returns table (claimed boolean, claim_token uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token uuid := gen_random_uuid();
begin
  insert into public.ryze_webhook_events (
    organization_id, channel_session_id, event_id, event_type,
    state, attempts, locked_until, claim_token
  ) values (
    p_org, p_session, p_event, p_event_type,
    'processing', 1, now() + interval '5 minutes', v_token
  )
  on conflict (organization_id, channel_session_id, event_id)
  do update set
    state = 'processing',
    attempts = public.ryze_webhook_events.attempts + 1,
    locked_until = now() + interval '5 minutes',
    claim_token = v_token,
    last_error_code = null
  where public.ryze_webhook_events.state = 'failed'
     or (public.ryze_webhook_events.state = 'processing' and public.ryze_webhook_events.locked_until <= now())
  returning true, public.ryze_webhook_events.claim_token
  into claimed, claim_token;

  if not found then
    return query select false, null::uuid;
  end if;
  return next;
end;
$$;

create or replace function public.fn_finish_ryze_webhook_event(
  p_org uuid,
  p_session uuid,
  p_event text,
  p_claim_token uuid,
  p_state text,
  p_error_code text default null
)
returns boolean
language sql
security definer
set search_path = public
as $$
  update public.ryze_webhook_events
     set state = p_state,
         completed_at = case when p_state = 'processed' then now() else null end,
         locked_until = now(),
         last_error_code = p_error_code
   where organization_id = p_org
     and channel_session_id = p_session
     and event_id = p_event
     and claim_token = p_claim_token
     and state = 'processing'
  returning true;
$$;

revoke all on function public.fn_claim_ryze_webhook_event(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.fn_finish_ryze_webhook_event(uuid, uuid, text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.fn_claim_ryze_webhook_event(uuid, uuid, text, text) to service_role;
grant execute on function public.fn_finish_ryze_webhook_event(uuid, uuid, text, uuid, text, text) to service_role;
