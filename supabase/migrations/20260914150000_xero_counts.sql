-- Manual Xero stock-count entry for the Date-Range Stock Balance report's "All branches
-- (combined)" view - per branch-scope+date-range+size, so a Manager/Owner can type in
-- whatever Xero reports for that period and the report shows it alongside the captured
-- Closing figure with a Diff, same "captured vs external, flag the gap" pattern Daily Sales'
-- Captured/Estimated columns already use. branch_scope is 'Helderberg'/'Kleinmond'/'All' -
-- text, not a foreign key, since 'All' isn't a real branch.
CREATE TABLE IF NOT EXISTS xero_counts (
  branch_scope text not null,
  start_date text not null,
  end_date text not null,
  size text not null,
  qty numeric not null default 0,
  entered_by uuid references profiles(id),
  entered_by_name_snapshot text,
  entered_at timestamptz not null default now(),
  primary key (branch_scope, start_date, end_date, size)
);
ALTER TABLE xero_counts ENABLE ROW LEVEL SECURITY;
CREATE POLICY xero_counts_select ON xero_counts FOR SELECT TO authenticated USING (true);
CREATE POLICY xero_counts_insert ON xero_counts FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY xero_counts_update ON xero_counts FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
