-- Cloud photo reconciler support (2026-09-25).
--
-- Background: every capture commits the FULL row (including its raw, resized photo bytes) into
-- manifold_live_rows / capture_live_rows as JSONB - a reliable network write. A SEPARATE step
-- then uploads those bytes to Drive and writes the resulting link into the Google Sheet + back
-- into the row's _photoLink/photoLinks. That second step used to run only on the capturing
-- phone and could silently fail when the phone's localStorage was full, leaving the photo bytes
-- safe in the cloud but never linked into the Sheet. The in-app reconciler (any Manager/Owner
-- login) drains these stragglers by re-driving the upload from the cloud copy.
--
-- This function is the reconciler's cheap "what still needs a link?" lookup: it returns ONLY
-- lightweight descriptors (no base64), so the reconciler can find pending rows across every day
-- without pulling megabytes of photo data on each pass. The reconciler then fetches one row's
-- bytes at a time by id, uploads, and writes the link back (which sets _photoLink/photoLinks on
-- the row, so the next call to this function no longer returns it).
--
-- Read-only, invoker rights (the existing permissive RLS on both tables already lets any
-- authenticated user select them - no SECURITY DEFINER needed). Additive and reversible
-- (DROP FUNCTION pending_photo_uploads()).
CREATE OR REPLACE FUNCTION pending_photo_uploads()
RETURNS TABLE (
  tbl text,
  id uuid,
  row_id text,
  kind text,
  branch text,
  date text,
  photo_field text,
  photo_count int
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    'manifold_live_rows'::text AS tbl,
    m.id,
    m.row_id,
    'manifold'::text AS kind,
    m.branch,
    m.date,
    'photo'::text AS photo_field,
    jsonb_array_length(m.row->'photo') AS photo_count
  FROM manifold_live_rows m
  WHERE m.row ? 'photo'
    AND jsonb_typeof(m.row->'photo') = 'array'
    AND jsonb_array_length(m.row->'photo') > 0
    AND COALESCE(m.row->>'_photoLink','') = ''

  UNION ALL

  SELECT
    'capture_live_rows'::text AS tbl,
    c.id,
    c.row_id,
    c.kind,
    c.branch,
    c.date,
    CASE
      WHEN c.row ? 'photo'         AND jsonb_typeof(c.row->'photo')='array'         AND jsonb_array_length(c.row->'photo')>0         THEN 'photo'
      WHEN c.row ? 'supplierPhoto' AND jsonb_typeof(c.row->'supplierPhoto')='array' AND jsonb_array_length(c.row->'supplierPhoto')>0 THEN 'supplierPhoto'
      WHEN c.row ? 'photos'        AND jsonb_typeof(c.row->'photos')='array'        AND jsonb_array_length(c.row->'photos')>0        THEN 'photos'
    END AS photo_field,
    GREATEST(
      CASE WHEN c.row ? 'photo'         AND jsonb_typeof(c.row->'photo')='array'         THEN jsonb_array_length(c.row->'photo')         ELSE 0 END,
      CASE WHEN c.row ? 'supplierPhoto' AND jsonb_typeof(c.row->'supplierPhoto')='array' THEN jsonb_array_length(c.row->'supplierPhoto') ELSE 0 END,
      CASE WHEN c.row ? 'photos'        AND jsonb_typeof(c.row->'photos')='array'        THEN jsonb_array_length(c.row->'photos')        ELSE 0 END
    ) AS photo_count
  FROM capture_live_rows c
  WHERE (
      (c.row ? 'photo'         AND jsonb_typeof(c.row->'photo')='array'         AND jsonb_array_length(c.row->'photo')>0)
   OR (c.row ? 'supplierPhoto' AND jsonb_typeof(c.row->'supplierPhoto')='array' AND jsonb_array_length(c.row->'supplierPhoto')>0)
   OR (c.row ? 'photos'        AND jsonb_typeof(c.row->'photos')='array'        AND jsonb_array_length(c.row->'photos')>0)
  )
    AND COALESCE(c.row->>'_photoLink','') = ''
    AND COALESCE(c.row->>'photoLinks','') = '';
$$;

GRANT EXECUTE ON FUNCTION pending_photo_uploads() TO authenticated;
