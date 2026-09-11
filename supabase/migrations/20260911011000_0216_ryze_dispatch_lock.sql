-- F4 Ryze forward-fix: serialize dispatch ownership before emit_event.
create or replace function public.fn_emit_ryze_dispatch_once(
  p_org uuid,
  p_session uuid,
  p_message uuid,
  p_conversation uuid,
  p_contact uuid,
  p_request uuid,
  p_payload jsonb,
  p_metadata jsonb
)
returns table (outcome text, event_id uuid)
language plpgsql security definer set search_path = public
as $$
declare v_event uuid; v_rows integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(
    p_org::text || ':' || p_session::text || ':' || p_message::text || ':ai_agent.dispatch_requested', 0
  ));
  select d.event_id into v_event
    from public.ryze_message_dispatches as d
   where d.organization_id=p_org and d.channel_session_id=p_session and d.message_id=p_message
     and d.event_type='ai_agent.dispatch_requested';
  if v_event is not null then return query select 'already_processed'::text, v_event; return; end if;
  v_event := public.emit_event('ai_agent.dispatch_requested', 'message', p_message,
    coalesce(p_payload, '{}'::jsonb),
    coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object('request_id', p_request), p_org);
  insert into public.ryze_message_dispatches
    (organization_id, channel_session_id, message_id, event_type, event_id)
  values (p_org, p_session, p_message, 'ai_agent.dispatch_requested', v_event)
  on conflict (organization_id, channel_session_id, message_id) do nothing;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    select d.event_id into v_event from public.ryze_message_dispatches as d
     where d.organization_id=p_org and d.channel_session_id=p_session and d.message_id=p_message;
    return query select 'already_processed'::text, v_event; return;
  end if;
  return query select 'processed'::text, v_event;
end;
$$;
revoke all on function public.fn_emit_ryze_dispatch_once(uuid, uuid, uuid, uuid, uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.fn_emit_ryze_dispatch_once(uuid, uuid, uuid, uuid, uuid, uuid, jsonb, jsonb) to service_role;
