-- Daily Sales gains a Private Refill (in-house) kg capture field - previously a read-only
-- auto-computed display with no way for the Manager to see it as an editable field or
-- correct it. Additive column, existing `lines` shape/readers untouched.
ALTER TABLE daily_sales ADD COLUMN IF NOT EXISTS private_refill_kg numeric;
