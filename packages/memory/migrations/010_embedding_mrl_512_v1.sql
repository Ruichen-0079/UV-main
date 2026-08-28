-- P8-0C production landing for the local Qwen3-Embedding-0.6B MRL prefix.
-- The migration runner replays every SQL file, so this is target-aware and
-- stable after the column and ANN index have reached 512 dimensions.
begin;

do $$
declare
  configured_dimension integer := coalesce(
    nullif(current_setting('yuvi.memory_vector_dimensions', true), ''),
    '1536'
  )::integer;
  index_enabled text := coalesce(
    nullif(current_setting('yuvi.memory_vector_index_enabled', true), ''),
    'true'
  );
  requested_index_type text := lower(coalesce(
    nullif(current_setting('yuvi.memory_vector_index_type', true), ''),
    'hnsw'
  ));
  distance_metric text := lower(coalesce(
    nullif(current_setting('yuvi.memory_vector_distance', true), ''),
    'cosine'
  ));
  ivfflat_lists integer := coalesce(
    nullif(current_setting('yuvi.memory_vector_ivfflat_lists', true), ''),
    '100'
  )::integer;
  hnsw_definition text;
  ivfflat_definition text;
begin
  if configured_dimension <> 512 then
    raise notice 'P8-0C MRL migration skipped: configured embedding dimension is %, target is 512.',
      configured_dimension;
    return;
  end if;

  if exists (
    select 1
    from memories
    where embedding is not null
      and vector_dims(embedding) not in (512, 1024)
  ) then
    raise exception 'P8-0C MRL migration refused: memories contain an unsupported embedding dimension.';
  end if;

  if exists (
    select 1 from memories where embedding is not null and vector_dims(embedding) = 512
  ) and exists (
    select 1 from memories where embedding is not null and vector_dims(embedding) = 1024
  ) then
    raise exception 'P8-0C MRL migration refused: memories contain mixed 512 and 1024 dimensional vectors.';
  end if;

  if exists (
    select 1
    from memories
    where embedding is not null
      and vector_dims(embedding) = 1024
      and (
        vector_norm(subvector(embedding, 1, 512)) <= 0
        or vector_norm(subvector(embedding, 1, 512))::text in ('NaN', 'Infinity', '-Infinity')
      )
  ) then
    raise exception 'P8-0C MRL migration refused: an existing 1024 vector has an invalid 512 prefix norm.';
  end if;

  update memories
  set embedding = l2_normalize(subvector(embedding, 1, 512))
  where embedding is not null and vector_dims(embedding) = 1024;

  update memories
  set embedding_dimensions = 512
  where embedding is not null and embedding_dimensions is distinct from 512;

  if not exists (
    select 1
    from pg_attribute
    where attrelid = 'memories'::regclass
      and attname = 'embedding'
      and not attisdropped
      and format_type(atttypid, atttypmod) = 'vector(512)'
  ) then
    alter table memories
      alter column embedding type vector(512)
      using embedding::vector(512);
  end if;

  select indexdef into hnsw_definition
  from pg_indexes
  where schemaname = current_schema()
    and tablename = 'memories'
    and indexname = 'memories_embedding_hnsw_idx';
  if hnsw_definition is not null
     and position('vector_dims(embedding) = 512' in lower(hnsw_definition)) = 0 then
    execute 'drop index if exists memories_embedding_hnsw_idx';
    hnsw_definition := null;
  end if;

  select indexdef into ivfflat_definition
  from pg_indexes
  where schemaname = current_schema()
    and tablename = 'memories'
    and indexname = 'memories_embedding_ivfflat_idx';
  if ivfflat_definition is not null
     and position('vector_dims(embedding) = 512' in lower(ivfflat_definition)) = 0 then
    execute 'drop index if exists memories_embedding_ivfflat_idx';
    ivfflat_definition := null;
  end if;

  if index_enabled in ('false', '0', 'no', 'off') or requested_index_type = 'none' then
    execute 'drop index if exists memories_embedding_hnsw_idx';
    execute 'drop index if exists memories_embedding_ivfflat_idx';
    raise notice 'P8-0C MRL migration completed with ANN vector indexing disabled.';
    return;
  end if;

  if distance_metric <> 'cosine' then
    raise exception 'P8-0C MRL migration refused: unsupported vector distance metric %. Only cosine is supported.',
      distance_metric;
  end if;

  if requested_index_type not in ('hnsw', 'ivfflat') then
    raise exception 'P8-0C MRL migration refused: unsupported vector index type %.', requested_index_type;
  end if;

  if requested_index_type = 'hnsw' then
    execute 'drop index if exists memories_embedding_ivfflat_idx';
    if hnsw_definition is null then
      begin
        execute 'create index memories_embedding_hnsw_idx
                 on memories
                 using hnsw ((embedding::vector(512)) vector_cosine_ops)
                 where embedding is not null and vector_dims(embedding) = 512';
        raise notice 'P8-0C MRL ANN vector index ready: hnsw, dimension 512.';
      exception
        when others then
          raise notice 'P8-0C HNSW unavailable, attempting IVFFLAT fallback: %', sqlerrm;
          execute 'create index memories_embedding_ivfflat_idx
                   on memories
                   using ivfflat ((embedding::vector(512)) vector_cosine_ops)
                   with (lists = ' || greatest(ivfflat_lists, 1) || ')
                   where embedding is not null and vector_dims(embedding) = 512';
          raise notice 'P8-0C MRL ANN vector index ready: ivfflat fallback, dimension 512.';
      end;
    end if;
  else
    execute 'drop index if exists memories_embedding_hnsw_idx';
    if ivfflat_definition is null then
      execute 'create index memories_embedding_ivfflat_idx
               on memories
               using ivfflat ((embedding::vector(512)) vector_cosine_ops)
               with (lists = ' || greatest(ivfflat_lists, 1) || ')
               where embedding is not null and vector_dims(embedding) = 512';
      raise notice 'P8-0C MRL ANN vector index ready: ivfflat, dimension 512.';
    end if;
  end if;
end $$;

commit;
