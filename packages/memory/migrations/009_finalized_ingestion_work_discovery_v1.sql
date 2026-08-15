-- Child-level due-work discovery for the memory ingestion coordinator.
-- Pending, due retryable, expired processing, and unleased reconcile rows
-- can be selected without scanning terminal history.
create index if not exists finalized_ingestion_events_due_work_idx
  on finalized_ingestion_events (status, next_attempt_at, lease_expires_at, created_at)
  where status in ('pending', 'retryable_failed', 'processing', 'reconcile_required');
