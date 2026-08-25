# Shared Opening-Mismatch Detection — Design

## Why this phase

When today's Opening count for a size/brand doesn't match what yesterday's Closing
count said it should be, the app is supposed to flag it for a Manager or Owner to
review before the day can close. Tracing the actual sequence of events (prompted by
a real question about how a Manager finds out) surfaced two real gaps:

1. **The comparison baseline only exists on one device.** "Yesterday's closing
   figures" are saved to `localStorage` only by whichever device closed the
   previous day. Any other device capturing today's Opening count has nothing to
   compare against — the mismatch check silently never runs. No error, no flag,
   nothing: a real discrepancy can pass through completely undetected.
2. **Even when a mismatch IS found, the flag itself isn't shared or durable.** It
   lives in one device's in-memory JavaScript state — not saved to local storage,
   not synced anywhere, gone on a page reload. The only signals today are a
   one-time toast at the moment of commit and a Close Day block, both of which only
   work if that same device, without reloading, is what a Manager happens to be
   looking at.

This phase makes the whole check — baseline and result — genuinely shared, so any
Manager or Owner sees it from any device, while preserving a rule the app already
enforces today: an Operator is told a count is wrong, never what the "right" number
was supposed to be.

## Scope of this phase

**In scope:** Stock Count's Opening-vs-previous-Closing mismatch check, made fully
shared (baseline + result + resolution), plus a badge notification pattern for
Manager/Owner roles.

**Explicitly out of scope, deferred to a follow-up phase:** Manifold's equivalent
check (`computeManifoldMismatches`). It shares the exact same two gaps and the same
fix shape, but — same call as Phase 2b's own pilot-first scoping — proving the
pattern on one system before extending it to the second is the safer sequence.

**Already fixed, not part of this phase's build:** as of tonight,
`adjustMismatch()` correctly re-syncs the Sheet (Counts tab for Stock Count,
Manifold tab in place for Manifold) and pushes Stock Count corrections into the
Phase 2b `stock_counts` table. That work stands on its own and this phase builds on
top of it, not around it.

## Decisions made during design

- **Derive the baseline live, don't store a second copy of it.** Rather than
  saving "expected opening" anywhere new, the baseline is read directly from
  `day_closes.store_snapshot` (already the authoritative, shared record of
  yesterday's Closing figures, synced since Phase 2a) at the moment of comparison.
  Considered storing an explicit `expected_opening` table instead — rejected
  because it creates a second copy of "yesterday's closing figures" that has to
  stay in sync with `day_closes` forever, including across 48-hour corrections to
  a closed day. Reading live avoids that entirely: a correction to yesterday's
  Closing figures is automatically reflected the next time today's Opening gets
  checked.
- **Client computes, server just stores.** Any device — on committing an Opening
  count, or on opening Count History for that branch — fetches yesterday's
  `day_closes` snapshot and diffs it against today's live `stock_counts` Opening
  rows, then upserts whatever discrepancies it finds into a new shared table.
  Considered a server-side Postgres trigger instead — more robust in principle,
  but a materially bigger and different kind of engineering effort, and a
  departure from the pattern this app has used consistently through every phase so
  far (client logic, RLS as the permission boundary). Worth reconsidering only if
  client-side reliability turns out to be a real problem in practice.
- **Badge, not push notification.** "Real time" here means "the moment a
  Manager/Owner next opens the app on any device, they see it" — the same
  refresh-on-login/reconnect badge pattern already proven for Close Day's and
  Stock Count's pending-sync indicators. True push notification (alerting a phone
  that isn't even open) would need Web Push subscription infrastructure this app
  doesn't have at all today — a separate, materially bigger project, not
  justified by what this problem actually needs.
- **The Operator/Manager visibility split is preserved exactly as it works today,
  client-side.** An Operator sees only "this count is incorrect" — never the
  previous-close figure or the counted figure. Seeing the expected number would
  let a count get quietly adjusted to match it instead of reporting what's
  genuinely on the shelf, which defeats the point of the check. This is enforced
  by what the rendering code chooses to display based on the viewer's own role,
  not by restricting what the shared table itself contains (Postgres RLS doesn't
  do column-level masking without extra views/functions, and every other
  role-based visibility rule in this app already works this way — this stays
  consistent with that, not a new mechanism).

## Data model

### `count_mismatches`

One row per size/state/brand line that doesn't match, per branch per day.

- `id`, `branch`, `date`, `size`, `state`, `brand`
- `expected` (numeric — yesterday's Closing figure), `counted` (numeric — today's
  Opening figure as committed)
- `resolved` (boolean, default false), `resolved_by`, `resolved_by_name_snapshot`,
  `resolved_at`, `corrected_to` (numeric), `resolution_reason` (text)

**Row Level Security:**
- Insert/Update: any signed-in user with Stock Count capture access (matches
  `stock_counts`' own policy — detection runs automatically as a side effect of a
  normal commit or opening Count History, not a privileged action by itself)
- Select: any signed-in user (the Operator/Manager distinction is a display-layer
  choice, not a read restriction — see decisions above)
- No delete policy, consistent with every other table this app has added

## Detection flow

Triggered from two places, both already-existing moments in the app:

1. **Right after a Stock Count Opening commit** (`_cCommitReal`, where
   `computeOpeningMismatches` already runs today).
2. **On opening Count History** for a branch, so a Manager checking in also
   catches anything a stale/offline device's commit might have missed publishing.

Each time: fetch `day_closes` for that branch + yesterday's date (falls back
gracefully offline, matching every other Phase 2b fetch — if it fails, whatever
was found last time stays as-is, nothing blocks). Diff its Closing figures against
today's live `stock_counts` Opening rows for the same branch. For every
size/state/brand where they differ, upsert a row into `count_mismatches` (keyed by
branch+date+size+state+brand, so re-running the check is always safe to repeat —
never duplicates, always reflects the current true comparison).

## Badge & display

A `mismatchPendingBadge` (and History-screen equivalent), same visual pattern as
the existing sync-pending badges, refreshed on login, reconnect, and History-open.
Reads "how many unresolved rows exist in `count_mismatches` for branches this
Manager/Owner can act on" — visible only to Manager/Owner roles, since an Operator
seeing a count of "how many mismatches" without detail would just be noise (the
one-line "your count is incorrect" toast/tile already covers what an Operator
needs to know).

Count History's existing red "Opening count incorrect" panel is unchanged in
shape — it already correctly branches on role (full table for Manager/Owner,
status-only for Operator, see `openHistory()`'s existing `isMgr` check) — it just
now reads from the shared table instead of local-only `store._openMismatch`.

## Resolution flow

`adjustMismatch()` is the existing, already-fixed-tonight resolve action —
unchanged in this phase except for where it reads/writes: instead of mutating a
local-only `store._openMismatch` entry, it updates the matching `count_mismatches`
row (`resolved`, `resolved_by`, `corrected_to`, `resolution_reason`), so the
resolution itself is visible from any device too, not just the one that resolved
it.

## Rollout

Same convention as the Phase 2b pilot: isolated worktree, task-by-task execution
with two-stage review, live verification against the real Supabase project before
merging to `main`. Given there's no official Close Day yet (the team is still
getting used to the app), live testing can use real staff accounts without risk to
real business records.

## Success criteria

- An Opening count committed on one device that doesn't match yesterday's Closing
  is visible — as a badge and in Count History — to a Manager/Owner on any other
  device, without that device needing to have been involved in the commit at all.
- An Operator viewing the same flagged line sees only that it's incorrect — never
  the previous-close or counted figures.
- Resolving a mismatch from any device with adjust permission correctly updates
  the Sheet, the shared count table, and the mismatch record itself, visible from
  any device afterward.
- The check still works correctly across a 48-hour correction to the previous
  day's Closing figures, since the baseline is always read live.
