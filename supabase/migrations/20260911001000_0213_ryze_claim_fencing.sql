alter table public.ryze_webhook_events add column if not exists claim_token uuid;
drop function if exists public.fn_claim_ryze_webhook_event(uuid, uuid, text, text);
create or replace function public.fn_claim_ryze_webhook_event(p_org uuid,p_session uuid,p_event text,p_event_type text)
returns table(outcome text, claim_token uuid)
language plpgsql security definer set search_path = public
as $$
declare v_token uuid := gen_random_uuid(); v_state text; v_rows integer;
begin
  insert into public.ryze_webhook_events (organization_id,channel_session_id,event_id,event_type,state,attempts,locked_until,claim_token)
  values (p_org,p_session,p_event,p_event_type,'processing',1,now()+interval '5 minutes',v_token)
  on conflict (organization_id,channel_session_id,event_id) do update set state='processing',attempts=public.ryze_webhook_events.attempts+1,locked_until=now()+interval '5 minutes',claim_token=v_token,last_error_code=null
  where public.ryze_webhook_events.state='failed' or (public.ryze_webhook_events.state='processing' and public.ryze_webhook_events.locked_until<=now())
  returning public.ryze_webhook_events.claim_token into claim_token;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    select state into v_state from public.ryze_webhook_events where organization_id=p_org and channel_session_id=p_session and event_id=p_event;
    if v_state='processed' then return query select 'already_processed'::text,null::uuid; else return query select 'busy'::text,null::uuid; end if;
    return;
  end if;
  return query select 'claimed'::text,claim_token;
end;
$$;
create or replace function public.fn_finish_ryze_webhook_event(p_org uuid,p_session uuid,p_event text,p_claim_token uuid,p_state text,p_error_code text default null)
returns boolean language plpgsql security definer set search_path = public
as $$
declare v_ok boolean;
begin
 update public.ryze_webhook_events set state=p_state,completed_at=case when p_state='processed' then now() else null end,locked_until=now(),last_error_code=p_error_code
 where organization_id=p_org and channel_session_id=p_session and event_id=p_event and claim_token=p_claim_token and state='processing'
 returning true into v_ok;
 return coalesce(v_ok,false);
end;
$$;
revoke all on function public.fn_claim_ryze_webhook_event(uuid,uuid,text,text) from public,anon,authenticated;
revoke all on function public.fn_finish_ryze_webhook_event(uuid,uuid,text,uuid,text,text) from public,anon,authenticated;
grant execute on function public.fn_claim_ryze_webhook_event(uuid,uuid,text,text) to service_role;
grant execute on function public.fn_finish_ryze_webhook_event(uuid,uuid,text,uuid,text,text) to service_role;
