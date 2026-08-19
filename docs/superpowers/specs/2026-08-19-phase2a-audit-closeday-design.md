# LPG-Gas-App: Phase 2a — Audit Log + Close Day Reliability — Design

## Why this phase

A full read-through of the app (2026-08-19) found one root cause behind most of the
"we lost function" reports since going live: almost every device-local screen (Audit
Log, Count History, same-day corrections, Branch Setup, Count Times) only knows what
*that specific device* has done. Nothing reads back a shared, live truth. On top of
that, `closeDay()` wipes local data based on a fire-and-forget send to Google Sheets
(`mode:'no-cors'`) that the app can never actually confirm succeeded — a real risk of
silently losing a day's data.

This phase fixes the two highest-stakes instances of that problem — the Audit Log and
Close Day — by moving them onto Supabase (the same database already used for
accounts), which every device can read the same live truth from. It's the first of
several planned phases (see "Later phases" below); the rest of the app's capture data
stays on its current Google Sheets + local-storage setup until its own phase.

## Scope of this phase

**In scope:**
- A new `audit_log` table, replacing the current localStorage-only audit trail
- A new `day_closes` table, replacing the current localStorage-only closed-day record
- Close Day made reliable: no local data is cleared until the close is confirmed saved
- Offline-safe Close Day: if there's no signal, the day still closes locally, is
  tagged "waiting to sync," and syncs automatically once signal returns
- As a natural side effect of `day_closes` holding the full day snapshot: Count
  History (viewing a past closed day, its PDF, and the 48-hour correction window)
  becomes readable from any device, not just the one that closed it
- Bundled while this code is already being touched:
  - Fix the "double password" prompt on Close Day's authoriser step and on
    signature-box unlocking (same fix already shipped for same-day corrections:
    someone who already qualifies gets one password prompt, not a name-then-password
    pair)
  - Stop storing the Close Day high-risk second password in plain readable text

**Explicitly out of scope for this phase** (see "Later phases"):
- Migrating the daily capture screens (Stock Count, Manifold, Refill, Private,
  Received, Residual) off Google Sheets/local storage
- Migrating Faulty Cylinders, Seal Register, Suppliers, Branch Setup, Count Times
- A reliable Google Sheets mirror of Supabase data (kept as-is: the existing
  best-effort `syncPush` continues alongside, unchanged, for the user's own records)
- Any of this app's *existing* history (past closed days, past audit entries) — that
  data stays exactly where it is today (Google Sheets / whichever device has it
  locally); nothing about it changes or migrates

## Decisions made during design

- **Refresh-on-open, not live updates.** Screens load current data when opened, the
  same pattern Manage Users already uses. No real-time subscriptions — not needed for
  this use case, and it avoids extra ongoing cost/complexity.
- **Offline Close Day: queue and retry, don't block.** Chosen over blocking Close Day
  entirely when there's no signal, because branches genuinely lose signal sometimes.
  See "Close Day" section below for the queueing design.
- **No device/IP tracking.** Considered and explicitly rejected: POPIA protects the
  employee regardless of who owns the device, adding it would require a documented
  purpose + staff disclosure + retention policy (an HR/legal step, not a code change)
  before it could be built responsibly, and its actual investigative value is low
  next to what's already captured (a password-verified login identifies the person
  far better than an IP address identifies a shared branch tablet).

## Data model

### `audit_log`

One row per logged event.

- `id`, `ts` (server-set, not client-set — see "Integrity" below)
- `user_id` (references `profiles`), `user_name_snapshot`, `role_snapshot` — name/role
  captured at the time, so a later rename/role-change doesn't rewrite history
- `branch`
- `action` (short label, e.g. `"Login"`, `"User created"`, `"Seal voided"`)
- `detail` (free text)
- `before` / `after` (jsonb, nullable — same before/after-value pattern as today)
- `outcome` (`success` | `failure`) — see "Log failures too" below
- `risk` (`routine` | `high`) — unused for alerting today, ready for it later without
  a schema change. High-risk actions (seal voids, corrections, manifold overrides,
  failed authorisation attempts, Close Day) get tagged `high` from day one; everything
  else defaults to `routine`.

**Row Level Security:**
- Insert: any signed-in user may insert a row for themselves (`user_id = auth.uid()`)
- Select: only a user with the `audit` permission (Owner, or anyone granted it)
- **No update policy, no delete policy — full stop.** Under RLS, no policy means no
  one can update or delete a row through the app, including the Owner. This is the
  core "investigation-grade" property: once written, an entry cannot be altered or
  removed by anyone, by design, at the database level.

### `day_closes`

One row per branch per date.

- `id`, `branch`, `date` — **unique on (`branch`, `date`)**, so it's impossible to
  create two conflicting closed-day records for the same branch+day even if two
  devices attempt it
- `closed_by`, `closed_at`, `authoriser_name`, `authoriser_level`
- `store_snapshot` (jsonb) — the full day's captured data (count/manifold/refill/
  private/received), the same shape as today's local closed-day record
- `signatures` (jsonb — operator + manager signature images, who signed each)
- `manifold_balance` (jsonb — the reconciliation result, including override reason if
  any)
- `corrections` (jsonb array) — grows as 48-hour-window corrections get logged against
  this closed day
- `sync_status` (`synced` | `pending`) — see "Close Day" below

**Row Level Security:**
- Insert: any signed-in user with the `closeday` permission
- Update: restricted to appending a correction (`corrections`) within the 48-hour
  window, by someone with the `edit`/adjust permission — never touches the original
  snapshot or signatures
- Select: anyone with the `history` permission
- No delete policy.

## Audit log: closing the trust gaps

Beyond the schema above, three behavioural changes make this hold up as an
investigation record, not just an activity feed:

1. **Failures are logged too**, not only successes. A wrong password entered against
   another user's name, a failed authorisation attempt on a correction, a failed
   Close Day authorisation — all get an `outcome:'failure'` entry. Today none of this
   is logged at all.
2. **Server-writes-its-own-log for user management.** The `manage-user` Edge Function
   already knows exactly what it did (created/edited/deleted which user, by whom).
   It writes its own `audit_log` row using its service-role connection, rather than
   trusting the phone to separately report "I just did X" after the fact — closing the
   gap where a modified client could skip or fake that report. Every other action in
   the app (captures, corrections, etc.) still logs from the client, same as today —
   that's the best available option for anything that doesn't already pass through a
   server function, and is an acceptable trust level for routine, low-risk actions.
3. **Search by date range**, not one day at a time — filter by user, branch, and
   action across weeks or months, not click-through-each-day as today.

## Close Day: reliability and offline behaviour

Today: `closeDay()` fires a `no-cors` request to Google Sheets (whose result the app
can never actually inspect) and unconditionally wipes local data immediately after,
regardless of whether that request truly landed.

New behaviour:

1. Close Day attempts a real, confirmable write to `day_closes` in Supabase.
2. **Signal is available and the write succeeds** → behaves like today from the
   user's perspective, just now backed by a real confirmation instead of an
   assumption. Local working data clears as normal.
3. **No signal, or the write fails** → the day still closes locally (so the next
   day's capture can start clean) and is kept, fully intact, tagged
   `sync_status:'pending'` in a small local queue — nothing is cleared or guessed at.
4. The app retries automatically in the background: on reconnect, and on every app
   open, until Supabase confirms the write.
5. A persistent, visible **"N day(s) waiting to sync"** indicator stays on screen
   (landing page and Count History) for as long as anything is pending — so it's never
   silently uncertain whether a close actually went through.
6. Once confirmed, the local pending copy is cleared and the record behaves like any
   other closed day: viewable, correctable within its 48-hour window, and downloadable
   as a PDF from any device.
7. The Google Sheets push (existing `syncPush('DayClose', ...)`) continues to fire
   alongside, unchanged, best-effort — it is no longer what gates whether local data
   clears.

Edge cases this design accounts for:
- Two devices attempting to close the same branch+day (e.g. a retry after a signal
  drop) — the `(branch, date)` uniqueness rule on `day_closes` rejects the duplicate
  safely; only the first successful write is kept.
- A correction logged against a day that's still `pending` (not yet reached Supabase)
  — the correction is applied to the local pending copy and travels with it when it
  finally syncs.

## Bundled fixes (same code, same pass)

- **Close Day authoriser prompt** and **signature-box unlock**: both currently ask
  for a name via a plain, unlabelled `prompt()`, then that name's password — the exact
  pattern that produced the "Ruben08081@" bug already fixed for same-day corrections.
  Both get the same fix: someone who already qualifies (e.g. an Owner authorising
  their own Close Day) gets a single password prompt; the two-step "someone else must
  step in" flow is preserved for when the person acting doesn't themselves qualify.
- **High-risk second password**: currently stored in plain, readable text in
  `localStorage` (`gs_highrisk_pw`). Moved to verification via the same secure method
  already used for every other password in the app (Supabase Auth), instead of being
  stored in a form anyone with brief device access could read directly.

## Rollout

Same approach as the accounts migration: built and tested in an isolated copy of the
app first, verified against a live Supabase test cycle, then a live pilot before it
reaches the rest of the staff. Nothing about *existing* history changes — this only
governs audit entries and closed days from the cutover point forward.

## Later phases (not this spec)

- **2b** — daily capture screens (Stock Count, Manifold, Refill, Private, Received,
  Residual) onto Supabase, so same-day corrections and "already committed" work from
  any device
- **2c** — Faulty Cylinders, Seal Register, Suppliers, Branch Setup, Count Times
- **2e** — a reliable, confirmed Google Sheets mirror of Supabase data (the existing
  best-effort push stays as-is until then)
- **Phase 3 — Visual refresh** (placeholder, not yet designed) — a dedicated
  cosmetic pass (colors, spacing, typography, polish) once the data-layer phases
  above are done and the screens underneath have stopped shifting. Lower risk than
  the phases above since it's CSS-first work on top of the app's existing shared
  classes and design tokens, but needs care wherever JavaScript reads those same
  class names to represent state (e.g. `.cCell.pending`, `.csize.done`) — those
  dependencies must be traced before anything gets renamed. Deliberately sequenced
  last so it isn't touching screens that Phase 2's remaining steps will still be
  changing underneath it. Not scoped or brainstormed yet — revisit when Phase 2 is
  further along.

## Success criteria

- Owner can open Audit Log on any device and see every event from every device,
  including failed attempts, filterable by date range/user/branch
- No audit entry can be edited or deleted by anyone, through the app or directly
  observable as a database-level guarantee
- Closing a day with no signal never loses data — it queues, retries, and shows a
  clear "waiting to sync" state until confirmed
- A closed day (and its PDF, and 48-hour correction window) is viewable from any
  device, not just the one that closed it
- Close Day's authoriser step and signature unlock ask for one password when the
  person already qualifies
- The high-risk second password is never stored in a form readable by opening the
  browser's local storage
