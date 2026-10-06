-- LPG Equipment: supporting stock (regulators, pigtails, washers) operators use on deliveries,
-- replenished by the storeman. Tracked as an immutable movement ledger - on-hand per item+branch
-- is the sum of delta. Not part of the daily cylinder close / balancing. Catalog + reorder levels
-- live in app_config (key 'equipment_catalog'), same as stock_thresholds.
create table if not exists public.equipment_moves (
  id uuid primary key default gen_random_uuid(),
  branch text not null,
  item_id text not null,
  delta integer not null,
  kind text not null check (kind in ('opening','used','replenish','correction')),
  note text default '',
  by_user_id uuid,
  by_name_snapshot text default '',
  ts timestamptz not null default now()
);
create index if not exists equipment_moves_branch_item_idx on public.equipment_moves (branch, item_id);
create index if not exists equipment_moves_branch_ts_idx on public.equipment_moves (branch, ts desc);

alter table public.equipment_moves enable row level security;

-- Same broad "any signed-in user" convention as stock_counts (access gated client-side by the
-- app's own per-user permissions). Ledger is append-only: select + insert, no update/delete.
drop policy if exists "equipment_moves select by any signed-in user" on public.equipment_moves;
create policy "equipment_moves select by any signed-in user"
  on public.equipment_moves for select to public using (auth.uid() is not null);

drop policy if exists "equipment_moves insert by any signed-in user" on public.equipment_moves;
create policy "equipment_moves insert by any signed-in user"
  on public.equipment_moves for insert to public with check (auth.uid() is not null);
