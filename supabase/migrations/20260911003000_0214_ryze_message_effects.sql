-- F4 Ryze: boundary durável para efeitos pós-mensagem.
create table if not exists public.ryze_message_effects (
  organization_id uuid not null,
  channel_session_id uuid not null,
  message_id uuid not null,
  conversation_id uuid not null,
  contact_id uuid not null,
  state text not null default 'processing' check (state in ('processing', 'processed')),
  locked_until timestamptz not null default (now() + interval '5 minutes'),
  claim_token uuid not null,
  marked_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (organization_id, channel_session_id, message_id)
);

alter table public.ryze_message_effects enable row level security;
revoke all on table public.ryze_message_effects from public, anon, authenticated;
grant all on table public.ryze_message_effects to service_role;

create or replace function public.fn_claim_ryze_message_effects(
  p_org uuid, p_session uuid, p_message uuid, p_conversation uuid, p_contact uuid,
  p_preview text, p_at timestamptz
)
returns table (claimed boolean, claim_token uuid)
language plpgsql security definer set search_path = public
as $$
declare v_token uuid := gen_random_uuid(); v_inserted boolean; v_rows integer;
begin
  insert into public.ryze_message_effects (organization_id, channel_session_id, message_id, conversation_id, contact_id, claim_token)
  values (p_org, p_session, p_message, p_conversation, p_contact, v_token)
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    select state = 'processed' into v_inserted from public.ryze_message_effects
     where organization_id=p_org and channel_session_id=p_session and message_id=p_message;
    if v_inserted then return query select false, null::uuid; return; end if;
    update public.ryze_message_effects set state='processing', locked_until=now()+interval '5 minutes', claim_token=v_token
     where organization_id=p_org and channel_session_id=p_session and message_id=p_message
       and state='processing' and locked_until <= now();
    if not found then return query select false, null::uuid; return; end if;
  end if;
  perform public.fn_mark_conversation_message(p_conversation, 'inbound', p_preview, p_at);
  return query select true, v_token;
end;
$$;

create or replace function public.fn_finish_ryze_message_effects(
  p_org uuid, p_session uuid, p_message uuid, p_claim_token uuid
)
returns boolean language plpgsql security definer set search_path = public
as $$
declare v_ok boolean;
begin
  update public.ryze_message_effects set state='processed', completed_at=now(), locked_until=now()
   where organization_id=p_org and channel_session_id=p_session and message_id=p_message
     and claim_token=p_claim_token and state='processing'
  returning true into v_ok;
  return coalesce(v_ok, false);
end;
$$;

revoke all on function public.fn_claim_ryze_message_effects(uuid, uuid, uuid, uuid, uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function public.fn_finish_ryze_message_effects(uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_claim_ryze_message_effects(uuid, uuid, uuid, uuid, uuid, text, timestamptz) to service_role;
grant execute on function public.fn_finish_ryze_message_effects(uuid, uuid, uuid, uuid) to service_role;
