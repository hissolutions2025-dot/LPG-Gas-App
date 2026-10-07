-- Shift sign-offs: each person who worked a branch's day signs off their OWN work, usually when
-- they sign out at the end of their shift (or from the Close Day screen if still on site).
-- Deliberately separate from day_close_signatures (the single Operator + Manager boxes that gate
-- Close Day), so that existing gate and its remote-signature flow are untouched. Non-blocking:
-- anyone who worked but didn't sign off is recorded on the close and flagged in the audit log.
create table if not exists public.shift_signoffs (
  branch text not null,
  date text not null,
  signer_name text not null,
  signer_level text not null default '',
  signer_id uuid,
  signature_png text not null,
  signed_at timestamptz not null default now(),
  primary key (branch, date, signer_name)
);

alter table public.shift_signoffs enable row level security;

drop policy if exists "shift_signoffs select by any signed-in user" on public.shift_signoffs;
create policy "shift_signoffs select by any signed-in user"
  on public.shift_signoffs for select to public using (auth.uid() is not null);

drop policy if exists "shift_signoffs insert by any signed-in user" on public.shift_signoffs;
create policy "shift_signoffs insert by any signed-in user"
  on public.shift_signoffs for insert to public with check (auth.uid() is not null);

-- update is needed for upsert (re-signing replaces the earlier signature for that person+day)
drop policy if exists "shift_signoffs update by any signed-in user" on public.shift_signoffs;
create policy "shift_signoffs update by any signed-in user"
  on public.shift_signoffs for update to public using (auth.uid() is not null) with check (auth.uid() is not null);
