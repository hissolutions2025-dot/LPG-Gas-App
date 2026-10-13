-- Photos live in Drive; the database keeps only a temporary copy (2026-10-13).
--
-- Every capture stores its resized photos as base64 inside the row (manifold_live_rows.row,
-- capture_live_rows.row) and again inside the closed day's snapshots (day_closes). That copy is
-- the safety net that lets the photo reach Drive even if the phone loses signal - but nothing
-- ever removed it after the upload, so the database had grown to 280 MB of the Free plan's
-- 500 MB by 13 Oct, about 7 MB a day.
--
-- From now on a line's photo bytes are dropped (replaced by the same small camera-icon
-- placeholder the *_lite views use) as soon as the line has a Drive link for every photo it holds:
--   - live rows: when the link is first written (photo queue or photo recovery) - trigger below;
--   - closed days: on insert for lines that already have their link; and when a live row gets its
--     link later, the link is copied into that line of the closed day and the bytes dropped there
--     too (so History/reports show the real photo link instead of the placeholder).
-- A line that has fewer links than photos (a photo that never made it to Drive) keeps its bytes,
-- so the photo recovery can still upload it.

-- The line's Drive link(s), whichever field its capture type uses.
create or replace function public.photo_link_of(e jsonb)
returns text language sql immutable parallel safe as $$
  select coalesce(nullif(e->>'_photoLink',''), nullif(e->>'photoLinks',''),
                  nullif(e->>'PhotoLinks',''), nullif(e->>'PhotoLink',''))
$$;

-- True when the line still holds photo bytes and has a Drive link for every one of them.
create or replace function public.photo_line_is_backed_up(e jsonb)
returns boolean language sql immutable parallel safe as $$
  select e is not null
     and regexp_count(e::text, '"data:image/(jpeg|jpg|webp);base64,') > 0
     and public.photo_link_of(e) is not null
     and regexp_count(public.photo_link_of(e), 'https?://') >= regexp_count(e::text, '"data:image/(jpeg|jpg|webp);base64,')
$$;

-- Applies f(line) to every line of every list in a day_closes snapshot ({count:[...],manifold:[...],...}).
-- mode 'drop': drop bytes of backed-up lines. mode 'link': give line rid the link fields, then drop.
create or replace function public.snapshot_photo_pass(snap jsonb, mode text, rid text default null, fields jsonb default null)
returns jsonb language sql immutable parallel safe as $$
  select case when snap is null or jsonb_typeof(snap) <> 'object' then snap else
    (select coalesce(jsonb_object_agg(s.k,
       case when jsonb_typeof(s.v) = 'array' then
         (select coalesce(jsonb_agg(
            case
              when mode = 'link' and x->>'_rid' = rid and public.photo_link_of(x) is null then
                case when public.photo_line_is_backed_up(x || fields) then public.strip_photo_bytes(x || fields) else x || fields end
              when mode = 'drop' and public.photo_line_is_backed_up(x) then public.strip_photo_bytes(x)
              else x
            end order by t.ord), '[]'::jsonb)
          from jsonb_array_elements(s.v) with ordinality t(x, ord))
       else s.v end), '{}'::jsonb)
     from jsonb_each(snap) s(k, v))
  end
$$;

-- Live rows: drop the bytes when the row is inserted with, or first given, its Drive link.
create or replace function public.live_row_drop_backed_up_photos()
returns trigger language plpgsql as $$
begin
  if (tg_op = 'INSERT' or public.photo_link_of(new.row) is distinct from public.photo_link_of(old.row))
     and public.photo_line_is_backed_up(new.row) then
    new.row := public.strip_photo_bytes(new.row);
  end if;
  return new;
end $$;

drop trigger if exists live_row_drop_backed_up_photos on public.manifold_live_rows;
create trigger live_row_drop_backed_up_photos before insert or update of row on public.manifold_live_rows
  for each row execute function public.live_row_drop_backed_up_photos();
drop trigger if exists live_row_drop_backed_up_photos on public.capture_live_rows;
create trigger live_row_drop_backed_up_photos before insert or update of row on public.capture_live_rows
  for each row execute function public.live_row_drop_backed_up_photos();

-- Live row just got its link: copy it into the same line of that day's closed record (if the day
-- is closed) and drop the bytes there. security definer: closed days are otherwise only editable
-- by managers within 48 hours, and this is a photo-link fix, not a business correction.
create or replace function public.day_close_attach_photo_link()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_fields jsonb;
begin
  if new.row_id is null or public.photo_link_of(new.row) is null
     or public.photo_link_of(new.row) is not distinct from public.photo_link_of(old.row) then
    return null;
  end if;
  v_fields := jsonb_strip_nulls(jsonb_build_object(
    '_photoLink', nullif(new.row->>'_photoLink',''), 'photoLinks', nullif(new.row->>'photoLinks','')));
  -- Never let this fail the live row's own update (that is the photo link being saved).
  begin
    update public.day_closes d
       set store_snapshot = public.snapshot_photo_pass(d.store_snapshot, 'link', new.row_id, v_fields),
           corrected_snapshot = public.snapshot_photo_pass(d.corrected_snapshot, 'link', new.row_id, v_fields)
     where d.branch = new.branch and d.date = new.date
       and (strpos(d.store_snapshot::text, new.row_id) > 0 or strpos(coalesce(d.corrected_snapshot::text,''), new.row_id) > 0);
  exception when others then
    raise warning 'day_close_attach_photo_link % %/% %: %', tg_table_name, new.branch, new.date, new.row_id, sqlerrm;
  end;
  return null;
end $$;

-- A closed day stays immutable (enforce_day_close_immutable), but storing its photos differently is
-- not a change to the record: the guard compares snapshots with photo bytes and Drive-link fields
-- set aside, so the link pass above and the one-off cleanup get through, while any change to
-- counts, names, signatures etc. is still refused.
create or replace function public.snapshot_photo_neutral(snap jsonb)
returns jsonb language sql immutable parallel safe as $$
  select case when snap is null or jsonb_typeof(snap) <> 'object' then snap else
    public.strip_photo_bytes((select coalesce(jsonb_object_agg(s.k,
       case when jsonb_typeof(s.v) = 'array' then
         (select coalesce(jsonb_agg(case when jsonb_typeof(x) = 'object' then x - '_photoLink' - 'photoLinks' else x end order by t.ord), '[]'::jsonb)
            from jsonb_array_elements(s.v) with ordinality t(x, ord))
       else s.v end), '{}'::jsonb)
     from jsonb_each(snap) s(k, v)))
  end
$$;

create or replace function public.enforce_day_close_immutable()
returns trigger language plpgsql as $$
begin
  if (new.store_snapshot is distinct from old.store_snapshot
        and public.snapshot_photo_neutral(new.store_snapshot) is distinct from public.snapshot_photo_neutral(old.store_snapshot))
    or new.signatures is distinct from old.signatures
    or new.branch is distinct from old.branch
    or new.date is distinct from old.date
    or new.closed_by is distinct from old.closed_by
    or new.closed_at is distinct from old.closed_at
    or new.authoriser_name is distinct from old.authoriser_name
    or new.authoriser_level is distinct from old.authoriser_level
  then
    raise exception 'day_closes rows are immutable except corrections and sync_status';
  end if;
  return new;
end;
$$;

drop trigger if exists day_close_attach_photo_link on public.manifold_live_rows;
create trigger day_close_attach_photo_link after update of row on public.manifold_live_rows
  for each row execute function public.day_close_attach_photo_link();
drop trigger if exists day_close_attach_photo_link on public.capture_live_rows;
create trigger day_close_attach_photo_link after update of row on public.capture_live_rows
  for each row execute function public.day_close_attach_photo_link();

-- New closed day: drop the bytes of every line that already has its link.
create or replace function public.day_close_drop_backed_up_photos()
returns trigger language plpgsql as $$
begin
  new.store_snapshot := public.snapshot_photo_pass(new.store_snapshot, 'drop');
  new.corrected_snapshot := public.snapshot_photo_pass(new.corrected_snapshot, 'drop');
  return new;
end $$;

drop trigger if exists day_close_drop_backed_up_photos on public.day_closes;
create trigger day_close_drop_backed_up_photos before insert on public.day_closes
  for each row execute function public.day_close_drop_backed_up_photos();
