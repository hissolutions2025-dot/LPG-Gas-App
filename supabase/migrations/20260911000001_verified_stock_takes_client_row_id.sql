-- Task 1 code review caught a real defect before it reached Task 4: `id` is a
-- server-generated uuid PK, but the plan's _pushVerifiedTake was written to preset
-- `id` with a client-generated string ('vst_...') - that insert would fail on a
-- uuid type cast against real Postgres. Fixing it the same way Branch Transfers'
-- stock_transfers.row_id was added as a follow-up (see
-- 20260910000001_stock_transfers_row_id_unique.sql): a separate client_row_id text
-- column, generated client-side, used for idempotent-retry detection (so a queued
-- insert that actually landed but whose response was lost doesn't get duplicated on
-- retry) and as the Sheets TakeId - `id` itself stays server-generated and untouched.
ALTER TABLE verified_stock_takes ADD COLUMN IF NOT EXISTS client_row_id text;
CREATE UNIQUE INDEX IF NOT EXISTS verified_stock_takes_client_row_id_unique
  ON verified_stock_takes (client_row_id) WHERE client_row_id IS NOT NULL;
