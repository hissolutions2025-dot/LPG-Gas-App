-- Received / Refill / Private / Residual: one generic mirror table
CREATE TABLE IF NOT EXISTS capture_live_rows (
  id uuid primary key default gen_random_uuid(),
  kind text not null,             -- 'received' | 'refill' | 'private' | 'residual'
  row_id text,
  branch text not null,
  date text not null,
  row jsonb not null,
  committed_by uuid references profiles(id),
  committed_at timestamptz default now()
);
CREATE INDEX IF NOT EXISTS capture_live_rows_kind_branch_date_idx ON capture_live_rows (kind, branch, date);

ALTER TABLE capture_live_rows ENABLE ROW LEVEL SECURITY;
CREATE POLICY capture_live_rows_select ON capture_live_rows FOR SELECT TO authenticated USING (true);
CREATE POLICY capture_live_rows_insert ON capture_live_rows FOR INSERT TO authenticated WITH CHECK (true);

-- Seal Register: roll config
CREATE TABLE IF NOT EXISTS seal_rolls (
  id text primary key,
  branch text not null,
  brand text,
  start_no integer not null,
  end_no integer not null,
  status text not null,           -- Active | Queued | Depleted | Closed
  warn_at integer default 20,
  created_by uuid references profiles(id),
  created_at timestamptz default now(),
  closed_by uuid references profiles(id),
  closed_at timestamptz,
  close_reason text
);
CREATE INDEX IF NOT EXISTS seal_rolls_branch_idx ON seal_rolls (branch);

ALTER TABLE seal_rolls ENABLE ROW LEVEL SECURITY;
CREATE POLICY seal_rolls_select ON seal_rolls FOR SELECT TO authenticated USING (true);
CREATE POLICY seal_rolls_insert ON seal_rolls FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY seal_rolls_update ON seal_rolls FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY seal_rolls_delete ON seal_rolls FOR DELETE TO authenticated USING (true);

-- Seal Register: used-seal history, the real duplicate guard
CREATE TABLE IF NOT EXISTS seal_used (
  id uuid primary key default gen_random_uuid(),
  roll_id text references seal_rolls(id),
  branch text not null,
  seal_no integer not null,
  used_by uuid references profiles(id),
  used_at timestamptz default now(),
  unique (roll_id, seal_no)
);
CREATE INDEX IF NOT EXISTS seal_used_branch_idx ON seal_used (branch);

ALTER TABLE seal_used ENABLE ROW LEVEL SECURITY;
CREATE POLICY seal_used_select ON seal_used FOR SELECT TO authenticated USING (true);
CREATE POLICY seal_used_insert ON seal_used FOR INSERT TO authenticated WITH CHECK (true);

-- Branch Setup / Count Times config
CREATE TABLE IF NOT EXISTS app_config (
  key text primary key,
  value jsonb not null,
  updated_by uuid references profiles(id),
  updated_at timestamptz default now()
);

ALTER TABLE app_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY app_config_select ON app_config FOR SELECT TO authenticated USING (true);
CREATE POLICY app_config_upsert ON app_config FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY app_config_update ON app_config FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
