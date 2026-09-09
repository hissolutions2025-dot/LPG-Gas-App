-- Branch Transfers (Phase 2 of docs/superpowers/specs/2026-09-09-stock-balance-management-design.md)
CREATE TABLE IF NOT EXISTS stock_transfers (
  id uuid primary key default gen_random_uuid(),
  row_id text,                         -- client-generated id, mirrors dispatch_sig's Sheet RowId for transferUpdate lookups
  from_branch text not null,
  to_branch text not null,
  items jsonb not null,                -- [{size,brand,state,qtyDispatched,qtyReceived,shortfallReason,note}]
  status text not null default 'pending_receipt', -- 'pending_receipt' | 'received' | 'approved' | 'cancelled'
  note text,
  dispatch_operator_id uuid references profiles(id),
  dispatch_operator_name_snapshot text,
  dispatch_sig text,                   -- data URL
  dispatch_at timestamptz default now(),
  receive_operator_id uuid references profiles(id),
  receive_operator_name_snapshot text,
  receive_sig text,
  receive_at timestamptz,
  manager_id uuid references profiles(id),
  manager_name_snapshot text,
  manager_sig text,
  approved_at timestamptz
);
CREATE INDEX IF NOT EXISTS stock_transfers_branch_status_idx ON stock_transfers (from_branch, to_branch, status);
CREATE INDEX IF NOT EXISTS stock_transfers_dispatch_at_idx ON stock_transfers (dispatch_at);

ALTER TABLE stock_transfers ENABLE ROW LEVEL SECURITY;
CREATE POLICY stock_transfers_select ON stock_transfers FOR SELECT TO authenticated USING (true);
CREATE POLICY stock_transfers_insert ON stock_transfers FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY stock_transfers_update ON stock_transfers FOR UPDATE TO authenticated USING (auth.uid() IS NOT NULL) WITH CHECK (auth.uid() IS NOT NULL);
