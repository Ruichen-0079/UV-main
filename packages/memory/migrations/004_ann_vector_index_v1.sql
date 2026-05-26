do $$
declare
  index_enabled text := coalesce(nullif(current_setting('yuvi.memory_vector_index_enabled', true), ''), 'true');
  requested_index_type text := lower(coalesce(nullif(current_setting('yuvi.memory_vector_index_type', true), ''), 'hnsw'));
  distance_metric text := lower(coalesce(nullif(current_setting('yuvi.memory_vector_distance', true), ''), 'cosine'));
  dimension integer := coalesce(nullif(current_setting('yuvi.memory_vector_dimensions', true), ''), '1536')::integer;
  ivfflat_lists integer := coalesce(nullif(current_setting('yuvi.memory_vector_ivfflat_lists', true), ''), '100')::integer;
begin
  if index_enabled in ('false', '0', 'no', 'off') or requested_index_type = 'none' then
    raise notice 'YUVI memory ANN vector index creation skipped.';
    return;
  end if;

  if distance_metric <> 'cosine' then
    raise notice 'YUVI memory ANN vector index skipped: unsupported distance metric %. Only cosine is supported in v1.', distance_metric;
    return;
  end if;

  if dimension <= 0 then
    raise notice 'YUVI memory ANN vector index skipped: invalid embedding dimension %.', dimension;
    return;
  end if;

  if requested_index_type not in ('hnsw', 'ivfflat') then
    raise notice 'YUVI memory ANN vector index skipped: unsupported index type %.', requested_index_type;
    return;
  end if;

  if requested_index_type = 'hnsw' then
    begin
      execute format(
        'create index if not exists memories_embedding_hnsw_idx
         on memories
         using hnsw ((embedding::vector(%s)) vector_cosine_ops)
         where embedding is not null and vector_dims(embedding) = %s',
        dimension,
        dimension
      );
      raise notice 'YUVI memory ANN vector index ready: hnsw, dimension %.', dimension;
      return;
    exception
      when others then
        raise notice 'YUVI memory HNSW index unavailable, attempting IVFFLAT fallback: %', sqlerrm;
    end;
  end if;

  begin
    execute format(
      'create index if not exists memories_embedding_ivfflat_idx
       on memories
       using ivfflat ((embedding::vector(%s)) vector_cosine_ops)
       with (lists = %s)
       where embedding is not null and vector_dims(embedding) = %s',
      dimension,
      greatest(ivfflat_lists, 1),
      dimension
    );
    raise notice 'YUVI memory ANN vector index ready: ivfflat, dimension %.', dimension;
  exception
    when others then
      raise notice 'YUVI memory ANN vector index skipped: IVFFLAT fallback unavailable: %', sqlerrm;
  end;
end $$;
