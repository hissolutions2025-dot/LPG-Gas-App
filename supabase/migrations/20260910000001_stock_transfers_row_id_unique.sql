-- row_id is the lookup key transferUpdate (Apps Script, Task 2) and the dispatch
-- retry queue (_transferFlush, Task 3) both depend on - without uniqueness, a
-- retried-but-already-succeeded dispatch push (same failure shape already seen this
-- session with manifold_live_rows) could leave two rows sharing a row_id, and a
-- later .eq('row_id', ...)-style update would silently touch both instead of one.
-- Flagged by code review on Task 1; closing it now before Tasks 3/6/7 build logic
-- that depends on this column being unique. Partial (WHERE row_id IS NOT NULL) since
-- the column itself stays nullable - only non-null values need to be unique.
CREATE UNIQUE INDEX IF NOT EXISTS stock_transfers_row_id_unique
  ON stock_transfers (row_id) WHERE row_id IS NOT NULL;
