-- Remote Close Day Signatures (docs/superpowers/specs/2026-09-12-remote-close-day-signatures-design.md)
-- One row per (branch, date, role) - upserted on (re)sign, replacing this project's prior
-- same-device-only sigData object as the source of truth for "has this box been signed."
CREATE TABLE IF NOT EXISTS day_close_signatures (
  branch text not null,
  date text not null,               -- 'YYYY-MM-DD', same convention as stock_counts.date
  role text not null check (role in ('Operator','Manager')),
  signer_name text not null,
  signer_level text not null,       -- the actual level of whoever signed (may be 'Owner' on an override)
  signature_png text not null,      -- data URL, same format sigData already produces
  signed_at timestamptz not null default now(),
  primary key (branch, date, role)
);
ALTER TABLE day_close_signatures ENABLE ROW LEVEL SECURITY;
CREATE POLICY day_close_signatures_select ON day_close_signatures FOR SELECT TO authenticated USING (true);
CREATE POLICY day_close_signatures_insert ON day_close_signatures FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY day_close_signatures_update ON day_close_signatures FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
