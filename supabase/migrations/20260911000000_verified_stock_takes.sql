-- Verified Stock Takes (Phase 1 of docs/superpowers/specs/2026-09-09-stock-balance-management-design.md)
-- One row per joint/solo Auditor stock take. Separate table - never touches
-- stock_counts / manifold_live_rows / the daily flow.
CREATE TABLE IF NOT EXISTS verified_stock_takes (
  id uuid primary key default gen_random_uuid(),
  branch text not null,
  date text not null,                     -- 'YYYY-MM-DD', same convention as stock_counts.date
  mode text not null,                     -- 'joint' | 'solo'
  count jsonb not null,                   -- [{size,brand,state,qty,note}]
  manifold jsonb not null,                -- [{cyl,brand,gasType,scale,tare,gasLeft,cylState,notes}]
  auditor_id uuid references profiles(id),
  auditor_name_snapshot text,
  auditor_sig text,                       -- data URL
  operator_id uuid references profiles(id),          -- null when mode='solo'
  operator_name_snapshot text,                       -- null when mode='solo'
  operator_sig text,                                 -- null when mode='solo'
  committed_at timestamptz default now()
);
CREATE INDEX IF NOT EXISTS verified_stock_takes_branch_date_idx ON verified_stock_takes (branch, date);

ALTER TABLE verified_stock_takes ENABLE ROW LEVEL SECURITY;
CREATE POLICY verified_stock_takes_select ON verified_stock_takes FOR SELECT TO authenticated USING (true);
CREATE POLICY verified_stock_takes_insert ON verified_stock_takes FOR INSERT TO authenticated WITH CHECK (true);
