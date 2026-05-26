alter table memories add column if not exists persona_id text null;
alter table memories add column if not exists subject_user_id text null;
alter table memories add column if not exists created_by_user_id text null;
alter table memories add column if not exists speaker_id text null;
alter table memories add column if not exists voice_profile_id text null;
alter table memories add column if not exists session_id text null;

update memories
set
  persona_id = coalesce(persona_id, metadata->>'personaId', 'default-persona'),
  subject_user_id = coalesce(subject_user_id, metadata->>'subjectUserId', 'default-user'),
  created_by_user_id = coalesce(created_by_user_id, metadata->>'createdByUserId', 'default-user'),
  speaker_id = coalesce(speaker_id, metadata->>'speakerId'),
  voice_profile_id = coalesce(voice_profile_id, metadata->>'voiceProfileId'),
  session_id = coalesce(session_id, metadata->>'sessionId')
where persona_id is null
   or subject_user_id is null
   or created_by_user_id is null
   or speaker_id is null
   or voice_profile_id is null
   or session_id is null;

alter table memories drop constraint if exists memories_subtype_check;
alter table memories add constraint memories_subtype_check
  check (
    subtype is null or subtype in (
      'preference', 'fact', 'project', 'workflow', 'event', 'milestone',
      'provider-choice', 'path', 'repo', 'command', 'troubleshooting',
      'config', 'identity', 'project-fact', 'config-decision',
      'emotional-state', 'emotional-pattern', 'health-note', 'schedule',
      'test', 'emotion', 'relationship'
    )
  );

create index if not exists memories_persona_subject_idx on memories (persona_id, subject_user_id);
create index if not exists memories_subject_user_idx on memories (subject_user_id);
create index if not exists memories_speaker_idx on memories (speaker_id);
create index if not exists memories_session_id_idx on memories (session_id);
create index if not exists memories_retention_class_idx on memories ((metadata->>'retentionClass'));
