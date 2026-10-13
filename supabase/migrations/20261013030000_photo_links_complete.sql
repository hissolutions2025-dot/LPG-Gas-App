-- Missing photo links (2026-10-13).
--
-- 7 Helderberg Manifold lines (10-30 Sep) had 2 photos but only 1 Drive link. All 7 "missing"
-- photos were in Drive the whole time: the app gives up on an upload after 25 s, but the upload
-- carried on and finished on Google's side (one took 31 s), so the file was saved while its link
-- was never recorded. The app then treated "1 of 2 links" as done, so nothing retried it and the
-- photo recovery ignored the row (it only looked for rows with no link at all).
--
-- 1. pending_photo_uploads: a row is pending while it has fewer links than photos, not only
--    when it has none.
-- 2. snapshot_photo_pass 'link' mode: the live row's latest link replaces the closed day's copy of
--    it (it used to fill only an empty link), so a completed or corrected link reaches the
--    closed day too.

create or replace function public.snapshot_photo_pass(snap jsonb, mode text, rid text default null, fields jsonb default null)
returns jsonb language sql immutable parallel safe as $$
  select case when snap is null or jsonb_typeof(snap) <> 'object' then snap else
    (select coalesce(jsonb_object_agg(s.k,
       case when jsonb_typeof(s.v) = 'array' then
         (select coalesce(jsonb_agg(
            case
              when mode = 'link' and jsonb_typeof(x) = 'object' and x->>'_rid' = rid then
                case when public.photo_line_is_backed_up(x || fields) then public.strip_photo_bytes(x || fields) else x || fields end
              when mode = 'drop' and public.photo_line_is_backed_up(x) then public.strip_photo_bytes(x)
              else x
            end order by t.ord), '[]'::jsonb)
          from jsonb_array_elements(s.v) with ordinality t(x, ord))
       else s.v end), '{}'::jsonb)
     from jsonb_each(snap) s(k, v))
  end
$$;

create or replace function public.pending_photo_uploads()
returns table (tbl text, id uuid, row_id text, kind text, branch text, date text, photo_field text, photo_count int)
language sql stable as $$
  select 'manifold_live_rows'::text, m.id, m.row_id, 'manifold'::text, m.branch, m.date, 'photo'::text,
         jsonb_array_length(m.row->'photo')
  from public.manifold_live_rows m
  where jsonb_typeof(m.row->'photo') = 'array'
    and jsonb_array_length(m.row->'photo') > regexp_count(coalesce(m.row->>'_photoLink',''), 'https?://')

  union all

  select 'capture_live_rows'::text, c.id, c.row_id, c.kind, c.branch, c.date, p.field, p.n
  from public.capture_live_rows c
  cross join lateral (
    select f.field, jsonb_array_length(c.row->f.field) n
    from (values ('photo'), ('supplierPhoto'), ('photos')) f(field)
    where jsonb_typeof(c.row->f.field) = 'array' and jsonb_array_length(c.row->f.field) > 0
    order by jsonb_array_length(c.row->f.field) desc
    limit 1
  ) p
  where p.n > regexp_count(coalesce(nullif(c.row->>'_photoLink',''), c.row->>'photoLinks', ''), 'https?://');
$$;

grant execute on function public.pending_photo_uploads() to authenticated;
