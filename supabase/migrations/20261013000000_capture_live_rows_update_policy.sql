-- capture_live_rows (live copy of Received / Refill / Private Refill / Residual Gas lines) had
-- INSERT and SELECT policies but no UPDATE policy. With RLS on, every update - the photo queue
-- writing a line's photo links, the photo-recovery pass, same-day corrections - silently changed
-- nothing and returned no error. Lines never got their photo links in the app, so the recovery
-- pass found the same ~113 lines "missing photos" at every Manager/Owner sign-in and uploaded
-- them to Drive again each time (hundreds of duplicate photos).
-- Same rule as manifold_live_rows_update and the rest of the app: any signed-in user.
drop policy if exists "capture_live_rows_update" on public.capture_live_rows;
create policy "capture_live_rows_update"
  on public.capture_live_rows for update to public
  using (auth.uid() is not null) with check (auth.uid() is not null);
