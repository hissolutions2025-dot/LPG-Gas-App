# LPG-Gas-App: Phase 2b Pilot — Stock Count on Supabase — Design

## Why this phase

Phase 2a fixed Audit Log and Close Day: the two highest-stakes places where every
device only knew what *it* had done locally, with nothing reading back a shared,
live truth. The rest of the app's daily capture screens (Stock Count, Manifold,
Refill, Private, Received, Residual) still have that same problem today.

Stock Count feels it the most. Its "Adjust an already-committed count" tool only
ever shows what *the device you're standing at* committed — if a count was
entered on the counting tablet and you want to correct it from the office phone,
the correction tool has no idea that count exists. This phase fixes that for
Stock Count specifically, as a deliberately-scoped pilot: prove the shared-truth
pattern against the hardest, most complex capture screen first, then extend the
same proven pattern to the other five screens as a separate follow-up phase.

## Scope of this phase

**In scope:**
- A new `stock_counts` table in Supabase, holding today's (and recent days')
  committed Stock Count lines as shared, cross-device truth
- Committing a Stock Count writes to this table (in addition to everything it
  already does locally and to Google Sheets — both unchanged)
- The "Adjust an already-committed count" tool reads from this shared table, so
  a correction made from any device sees everything committed today from any
  other device, not just itself
- Offline-safe commits: no signal at commit time never blocks the operator —
  the commit still completes locally, is queued, and syncs to Supabase
  automatically once signal returns (reusing the retry/queue machinery built
  for Close Day in Phase 2a)
- A visible "N waiting to sync" indicator for anything still queued, same
  pattern as Close Day

**Explicitly out of scope for this phase:**
- The other five capture screens (Manifold, Refill, Private, Received,
  Residual) — deliberately deferred to a follow-up rollout phase once this
  pilot is proven live
- The in-progress **draft** (what's being typed before commit) staying local
  to the device — only *committed* counts become shared; drafts are not
  synced or made visible cross-device
- Any change to the 48-hour post-Close-Day correction tool — that already
  reads/writes `day_closes.corrections` from Phase 2a, untouched by this work
- Real-time/live updates — same "refresh-on-open" decision Phase 2a made for
  Audit Log and Close Day; no Supabase Realtime subscriptions

## Decisions made during design

- **Commit is shared; draft is not.** The in-progress count stays exactly as
  it is today — local scratchpad on one device. Only a *committed* count
  becomes shared truth. This matches how Close Day already treats "closed" as
  the shared, authoritative state and avoids building real-time collaborative
  editing, which nothing about the actual problem calls for.
- **Offline-queue, not offline-block.** Same reasoning as Close Day: branches
  genuinely lose signal sometimes, and Stock Count commits happen far more
  often per day than Close Day does, so blocking the operator on a signal
  drop would be a worse regression than the bug being fixed.
- **Row-per-line table, not a per-day JSON blob.** A row per (branch, date,
  count type, state, size, brand) means two devices correcting *different*
  lines can never collide — different lines are different rows. A single
  JSON blob per day would risk one device's write clobbering another's
  unless careful merge logic were built, and would generalize poorly to the
  other five screens later (they don't all share one blob shape).
- **No delete policy — rows just accumulate.** A corrected line gets a new
  `qty` via upsert; nothing is ever removed. This sidesteps an entire class
  of "did the delete actually land on every device" problems, mirrors Phase
  2a's audit-log philosophy, and costs nothing meaningful — data volume is
  roughly 20-40 rows per branch per day.
- **No new permission gate for the shared table itself.** Insert/update/select
  on `stock_counts` uses the same permission that already gates the Stock
  Count screen. The correction tool's existing password step-up re-auth
  (`_selfReauth`/`_borrowAuth`, already built and proven in Phase 2a) remains
  the actual gate on *who* can invoke a correction — this migration only
  changes where the data lives, not the correction workflow's authorisation.

## Data model

### `stock_counts`

One row per committed line, upserted on every commit or correction.

- `id`, `branch`, `date`, `count_type` (`Opening` | `Closing`),
  `state` (`Full` | `Empty`), `size`, `brand`, `qty`, `note`
- `updated_by` (references `profiles`), `updated_by_name_snapshot`, `updated_at`
- **Unique on (`branch`, `date`, `count_type`, `state`, `size`, `brand`)** —
  this is what makes a commit or correction an upsert rather than an insert,
  mirroring today's local merge-by-line-key logic in `_cCommitReal()`

**Row Level Security:**
- Insert/Update: any signed-in user with the existing Stock Count capture
  permission, scoped to their own branch
- Select: same permission that already gates viewing the Stock Count screen
- No delete policy, no update restriction beyond the permission check above —
  unlike `day_closes`, this table represents live, still-open-day data, not
  an immutable investigation record, so it doesn't need Phase 2a's stricter
  append-only-correction constraint

## Commit flow

Three things happen on commit (only the third is new):

1. Local `store.count` updates immediately, unchanged — the committing device
   sees its own result instantly, exactly like today.
2. The Google Sheets push fires, unchanged, best-effort, alongside everything
   else — not gated by or dependent on step 3.
3. **New:** the committed lines are upserted into `stock_counts` in Supabase.
   This is what makes them visible to other devices.

Step 3's offline behavior mirrors Close Day:

- **Signal available, write succeeds** → done; other devices see it next time
  they open the Adjust tool.
- **No signal, or the write fails** → nothing blocks the operator. Steps 1-2
  still happen regardless. The Supabase upsert is added to a retry queue,
  reusing the queue/flush machinery already built for Close Day
  (`_closeDayQueueLoad`/`Save`/`Remove`/`Flush`), adapted for count commits.
  It retries automatically on reconnect and on every app open.
- Unlike Close Day (one queue entry per branch+day), Stock Count can be
  committed multiple times a day, so each queued item is its own entry
  (client-generated id) and the queue is flushed in order — a list of
  "batches of lines still waiting to sync," not a single record.
- Same visible **"N waiting to sync"** indicator pattern as Close Day.

## Correction flow

Today, "Adjust an already-committed count" reads local `store.count`, so it
only ever shows what the device in front of you committed. That's the actual
bug this pilot fixes.

New behavior: opening the Adjust tool fetches today's committed lines for
that branch from `stock_counts` (refresh-on-open, no live subscription — same
pattern as Manage Users and Audit Log), so it shows everything committed
today from any device.

- **Offline fallback:** if the fetch fails, fall back to local `store.count`
  — the tool still works with whatever the device knows, rather than
  erroring out, matching Close Day's graceful-degradation approach.
- The password re-auth flow before a correction is applied is unchanged.
- Applying a correction upserts the changed line(s) back into `stock_counts`
  (through the same offline-queue path as any other commit) and also updates
  local `store.count` and fires the Sheets sync, exactly like today.

**Known trade-off, accepted for this pilot:** two devices correcting the
*same* line at nearly the same moment is a last-write-wins race — whichever
upsert reaches Supabase last wins. This is no worse than what could happen
locally today between a draft and a commit on one device, and Close Day's own
design doesn't guard against the equivalent race either. No conflict
resolution is planned for this pilot.

## Close Day interaction & day boundaries

No special handling is needed — it falls out of the data model:

- Every row is keyed to a specific `date`, so a new day naturally starts with
  no rows to conflict with — nothing to reset or clear.
- When a day closes, its `stock_counts` rows simply stop being "live" —
  `day_closes.store_snapshot` (from Phase 2a) becomes the authoritative copy
  for that closed day, and the existing 48-hour correction tool already
  reads/writes there, untouched by this work.
- Old rows for a closed day just sit in `stock_counts`, harmless and unused,
  consistent with the "nothing gets deleted" decision above.

## Rollout

Same approach as Phase 2a: built and tested in an isolated worktree, verified
against a live Supabase test cycle, then a live pilot with the user before
being considered proven. Specific scenarios to verify before shipping:

- Commit on Device A → correction tool on Device B sees the new line
- Offline commit → queues → auto-syncs on reconnect → visible on Device B
  afterward
- Correction applied while offline → same queue/retry path
- A closed day's Adjust tool still works via the existing 48-hour flow,
  unaffected by this table

## Later phases (not this spec)

- **Phase 2b rollout** — once this pilot is proven live, apply the same
  proven `stock_counts`-style pattern to the remaining five capture screens
  (Manifold, Refill, Private, Received, Residual) — each as its own
  follow-up scoping pass, since their data shapes differ enough that a
  single shared table across all six is not assumed here
- **2c** — Faulty Cylinders, Seal Register, Suppliers, Branch Setup, Count
  Times onto Supabase
- **2e** — a reliable, confirmed Google Sheets mirror of Supabase data (the
  existing best-effort push stays as-is until then)
- **Phase 3 — Visual refresh** (placeholder, not yet designed)

## Success criteria

- A Stock Count committed on one device is visible in the "Adjust an
  already-committed count" tool on a different device, the same day,
  without needing to re-enter anything
- Committing a Stock Count with no signal never blocks the operator or loses
  data — it queues, retries automatically, and shows a clear "waiting to
  sync" state until confirmed
- The existing 48-hour post-Close-Day correction flow is unaffected
- Google Sheets sync behavior is unchanged
