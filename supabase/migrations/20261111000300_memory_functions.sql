-- Memory, step 2: two functions so that several writes happen together or not at all.
--
-- save_run:  saves what the agent did for one customer message: its reply, its steps with their
--            cost, and any hand-over (which also sets the conversation to 'with_person').
-- hand_back: gives a conversation back to the agent and resolves its open hand-overs.
--
-- Both are locked like the tables: only the server key (service_role) can run them.

create function public.save_run(p jsonb) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_conversation uuid := (p ->> 'conversation_id')::uuid;
  v_message uuid := (p ->> 'message_id')::uuid;
  v_reply text := nullif(p ->> 'reply', '');
  v_handover jsonb := p -> 'handover';
  v_reply_id uuid;
begin
  if v_reply is not null then
    insert into public.messages (conversation_id, direction, sender, body)
    values (v_conversation, 'out', 'agent', v_reply)
    returning id into v_reply_id;
  end if;

  insert into public.agent_steps (
    conversation_id, message_id, position, kind, label, detail, engine, model,
    duration_ms, input_tokens, output_tokens, cost_usd, payload
  )
  select v_conversation, v_message, s.position, s.kind, s.label, s.detail, s.engine, s.model,
         s.duration_ms, s.input_tokens, s.output_tokens, s.cost_usd, coalesce(s.payload, '{}'::jsonb)
  from jsonb_to_recordset(coalesce(p -> 'steps', '[]'::jsonb)) as s (
    position smallint, kind public.step_kind, label text, detail text, engine text, model text,
    duration_ms integer, input_tokens integer, output_tokens integer, cost_usd numeric, payload jsonb
  );

  if jsonb_typeof(v_handover) = 'object' then
    insert into public.handovers (conversation_id, message_id, reason, situation)
    values (
      v_conversation, v_message, v_handover ->> 'reason',
      (v_handover ->> 'situation')::public.handover_situation
    );
    update public.conversations set status = 'with_person' where id = v_conversation;
  end if;

  update public.conversations set last_message_at = now() where id = v_conversation;
  return jsonb_build_object('reply_message_id', v_reply_id);
end;
$$;

create function public.hand_back(p_conversation_id uuid) returns void
language plpgsql
set search_path = ''
as $$
begin
  update public.handovers
     set status = 'resolved', resolved_at = now(), resolved_by = 'receptionist'
   where conversation_id = p_conversation_id and status = 'open';
  update public.conversations set status = 'bot' where id = p_conversation_id;
end;
$$;

revoke all on function public.save_run(jsonb) from public, anon, authenticated;
revoke all on function public.hand_back(uuid) from public, anon, authenticated;
grant execute on function public.save_run(jsonb) to service_role;
grant execute on function public.hand_back(uuid) to service_role;
