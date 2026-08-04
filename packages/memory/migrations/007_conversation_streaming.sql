alter table conversation_messages drop constraint if exists conversation_messages_status_check;
alter table conversation_messages add constraint conversation_messages_status_check
  check (status in ('streaming', 'completed', 'failed', 'cancelled'));
