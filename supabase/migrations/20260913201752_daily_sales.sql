-- Daily Sales/Returns - closes the "no point-of-sale record" gap the single-day report and
-- Date-Range Stock Balance both explicitly flag today. One row per branch+date, the whole
-- day's per-size tally committed/replaced atomically (Manager fills the grid, hits Commit
-- once - not a per-transaction log, see docs/superpowers/plans/2026-09-13-daily-sales-and-
-- last-close-fix.md for the design discussion).
CREATE TABLE IF NOT EXISTS daily_sales (
  branch text not null,
  date text not null,                -- 'YYYY-MM-DD', same convention as stock_counts.date
  lines jsonb not null,               -- [{size, sold, returned}, ...] - shells only, no brand
  entered_by uuid references profiles(id),
  entered_by_name_snapshot text,
  entered_at timestamptz not null default now(),
  primary key (branch, date)
);
CREATE INDEX IF NOT EXISTS daily_sales_branch_date_idx ON daily_sales (branch, date);
ALTER TABLE daily_sales ENABLE ROW LEVEL SECURITY;
CREATE POLICY daily_sales_select ON daily_sales FOR SELECT TO authenticated USING (true);
CREATE POLICY daily_sales_insert ON daily_sales FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY daily_sales_update ON daily_sales FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
