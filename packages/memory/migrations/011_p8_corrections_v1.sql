-- P8-1E durable explicit correction authority.
-- The semantic payload is canonical JSON; stored_at is operational metadata only.
create table if not exists p8_corrections (
  record_version text not null check (length(record_version) between 1 and 40),
  correction_reference text primary key check (length(correction_reference) between 1 and 160),
  character_instance_id text not null check (length(character_instance_id) between 1 and 160),
  persona_profile_id text not null check (length(persona_profile_id) between 1 and 160),
  subject_scope_id text null check (subject_scope_id is null or length(subject_scope_id) between 1 and 160),
  scope_reference text not null check (length(scope_reference) between 1 and 160),
  target_kind text not null check (target_kind in ('INTERPRETATION', 'AUTHORED_INVARIANT')),
  interpretation_reference text null check (
    interpretation_reference is null or length(interpretation_reference) between 1 and 160
  ),
  invariant_target text null check (invariant_target is null or invariant_target in ('identity', 'persona')),
  invariant_key text null check (invariant_key is null or length(invariant_key) between 1 and 160),
  action text not null check (action in ('REVISE', 'RETRACT')),
  replacement_meaning text null check (
    replacement_meaning is null or length(replacement_meaning) between 1 and 500
  ),
  provenance_source text not null check (provenance_source = 'EXPLICIT_USER_CORRECTION'),
  provenance_reference text not null check (length(provenance_reference) between 1 and 160),
  supplied_at text null check (supplied_at is null or length(supplied_at) between 1 and 100),
  supersedes_correction_reference text null check (
    supersedes_correction_reference is null
    or length(supersedes_correction_reference) between 1 and 160
  ),
  superseded_evidence_references text[] not null default '{}',
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  stored_at timestamptz not null default now(),
  constraint p8_corrections_target_shape check (
    (
      target_kind = 'INTERPRETATION'
      and interpretation_reference is not null
      and invariant_target is null
      and invariant_key is null
    )
    or (
      target_kind = 'AUTHORED_INVARIANT'
      and interpretation_reference is null
      and invariant_target is not null
      and invariant_key is not null
    )
  ),
  constraint p8_corrections_action_shape check (
    (action = 'REVISE' and replacement_meaning is not null)
    or (action = 'RETRACT' and replacement_meaning is null)
  ),
  constraint p8_corrections_no_self_lineage check (
    supersedes_correction_reference is null
    or supersedes_correction_reference <> correction_reference
  )
);

create index if not exists p8_corrections_address_scope_idx
  on p8_corrections (
    character_instance_id,
    persona_profile_id,
    subject_scope_id,
    scope_reference,
    correction_reference
  );
