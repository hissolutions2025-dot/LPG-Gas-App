-- User time/data usage tracking - one row per login session, aggregated per-user-per-day at
-- read time (Audit Log's new "Usage" tab). Honest scope, not a true OS-level data-usage
-- meter (that's inaccessible to any web app): active_seconds is real foreground/not-idle-
-- locked time; shell_bytes is real transferSize for this app's own index.html/sw.js
-- reloads (Resource Timing API, same-origin so fully measurable, and now tiny thanks to the
-- 2026-09-14 ETag fix); sync_call_count is a real count of Supabase requests fired this
-- session (Resource Timing entries are visible cross-origin for name/count/timing even
-- without Timing-Allow-Origin - only their byte-size fields are blocked, which is why this
-- is a call COUNT, not a Supabase byte total). connection_type is best-effort (Android
-- Chrome's Network Information API only - navigator.connection does not exist on iOS
-- Safari, so this is null there by design, not a bug).
CREATE TABLE IF NOT EXISTS usage_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id),
  user_name_snapshot text not null,
  branch text,
  date text not null,                    -- 'YYYY-MM-DD', session_start's date - same convention as daily_sales.date
  session_start timestamptz not null,
  session_end timestamptz,               -- null while the session is still live/open
  active_seconds integer not null default 0,
  shell_bytes bigint not null default 0,
  sync_call_count integer not null default 0,
  connection_type text,                  -- 'wifi'|'cellular'|'ethernet'|'none'|'unknown'|null
  updated_at timestamptz not null default now()
);
CREATE INDEX IF NOT EXISTS usage_sessions_branch_date_idx ON usage_sessions (branch, date);
CREATE INDEX IF NOT EXISTS usage_sessions_user_date_idx ON usage_sessions (user_id, date);
ALTER TABLE usage_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY usage_sessions_select ON usage_sessions FOR SELECT TO authenticated USING (true);
CREATE POLICY usage_sessions_insert ON usage_sessions FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY usage_sessions_update ON usage_sessions FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
