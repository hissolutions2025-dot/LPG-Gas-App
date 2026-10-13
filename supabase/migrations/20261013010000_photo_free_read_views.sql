-- Photo-free read views (2026-10-13).
--
-- On 13 Oct 2026, Supabase blocked the project for "exceed_egress_quota": the app stopped at the
-- sign-in screen ("Could not load user list"). Cause: every capture row and every closed day stores
-- its photos as raw base64 inside the jsonb (manifold_live_rows.row, capture_live_rows.row,
-- day_closes.store_snapshot / corrected_snapshot). Ordinary screens downloaded those photos on every
-- open, even though they only needed the numbers:
--   - yesterday's whole closed day (up to 9 MB) was fetched 3-4 times per screen open for the
--     expected Opening;
--   - all of today's Manifold / Received / Refill rows were fetched again after every commit;
--   - History and reports fetched whole closed days.
-- Together those used up the monthly data allowance.
--
-- These views return the same rows with every JPEG/WebP photo replaced by a tiny camera-icon
-- placeholder. Photo arrays keep their length, so "has a photo" checks still work, and Drive links
-- (_photoLink / photoLinks) are kept, so the reports still open the real photo. The app's
-- read-only fetches use these views. Anything that writes a row back, plus the photo
-- recovery/upload paths, keeps reading the real tables, so photo bytes are never overwritten.
-- Signatures (PNG) are left alone.
--
-- security_invoker: the views use the caller's permissions, so the base tables' RLS applies
-- unchanged.

create or replace function public.strip_photo_bytes(j jsonb)
returns jsonb
language sql
immutable
parallel safe
as $$
  select case when j is null then null else
    regexp_replace(
      j::text,
      '"data:image/(jpeg|jpg|webp)[^"]*"',
      '"data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20width=%2760%27%20height=%2760%27%20viewBox=%270%200%2060%2060%27%3E%3Crect%20width=%2760%27%20height=%2760%27%20rx=%278%27%20fill=%27%23e5e7eb%27/%3E%3Crect%20x=%2714%27%20y=%2720%27%20width=%2732%27%20height=%2724%27%20rx=%275%27%20fill=%27none%27%20stroke=%27%236b7280%27%20stroke-width=%273%27/%3E%3Ccircle%20cx=%2730%27%20cy=%2732%27%20r=%277%27%20fill=%27none%27%20stroke=%27%236b7280%27%20stroke-width=%273%27/%3E%3C/svg%3E"',
      'g'
    )::jsonb
  end
$$;

create or replace view public.manifold_live_rows_lite with (security_invoker = true) as
  select id, row_id, branch, date, cyl, public.strip_photo_bytes(row) as row, committed_by, committed_at
  from public.manifold_live_rows;

create or replace view public.capture_live_rows_lite with (security_invoker = true) as
  select id, kind, row_id, branch, date, public.strip_photo_bytes(row) as row, committed_by, committed_at
  from public.capture_live_rows;

create or replace view public.day_closes_lite with (security_invoker = true) as
  select id, branch, date, closed_by, closed_at, authoriser_name, authoriser_level,
         public.strip_photo_bytes(store_snapshot) as store_snapshot,
         signatures, manifold_balance,
         public.strip_photo_bytes(corrections) as corrections,
         sync_status,
         public.strip_photo_bytes(corrected_snapshot) as corrected_snapshot
  from public.day_closes;

grant select on public.manifold_live_rows_lite, public.capture_live_rows_lite, public.day_closes_lite to authenticated;

notify pgrst, 'reload schema';
