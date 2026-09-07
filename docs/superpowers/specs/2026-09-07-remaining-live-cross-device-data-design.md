# Remaining Live Cross-Device Data — Design

## Why this phase

`2026-08-31-manifold-live-cross-device-data-design.md` built the fetch-on-open live mirror
for Manifold only, deliberately deferring the other five capture types until needed. That
need has now arrived from two directions: a live bug report (a Stock Count committed on one
device didn't appear on another until an unrelated screen happened to refresh it — fixed
separately this session by adding the missing fetch-on-open call, no new table needed since
`stock_counts` already existed) and a second, worse gap — Stock Received has **no Supabase
table at all**, so a delivery captured on the operator's phone is invisible everywhere else
(Count History's Stock Received panel, the Close Day report) until Sheets sync, which nothing
ever reads back. Auditing the rest surfaced the same gap in Refill, Private Refill, Residual
Gas, and — most seriously — the Seal Register's duplicate-seal check, which currently
validates a scanned seal against `localStorage` only: two devices can accept the *same* seal
number as valid, since neither knows what the other has used today. Branch Setup and Count
Times (pure config, Owner-edited) have the same local-only gap but far lower stakes.

This phase closes all of it in one pass, reusing the exact pattern already proven for
Manifold.

## Scope of this phase

**In scope:**
- Stock Received, Refill, Private Refill, Residual Gas: every committed row becomes visible
  to any device, fetch-on-open, same as Manifold.
- Seal Register: the active/queued roll config AND the used-seal history both become a real
  shared table — critically, the used-seal check gets a server-side uniqueness guarantee, not
  just a mirrored read, so a duplicate seal is rejected even if two devices scan it within
  moments of each other.
- Branch Setup + Count Times: config becomes a shared table, fetched on Admin tab open,
  written straight through on save (Owner-edited, low frequency — no draft/commit split
  needed).
- Close Day report / Count History panels for every one of these sections: no code change
  needed beyond the fetch-on-open — they already read local `store`, same closing argument as
  Manifold's write-up.

**Explicitly out of scope (same as Manifold's phase):**
- True real-time push — confirmed again this round, refresh-on-open only.
- In-progress/uncommitted drafts staying cross-device — only committed data.
- An Adjust/correction updating the mirror row itself — same accepted limitation as Manifold
  and Received's existing 48-hour tool: a corrected value lives in the Adjustments log, not
  the mirror, until this is revisited.

## Decisions made during design

- **Refresh-on-open, not true real-time push** — confirmed explicitly (same as Manifold).
- **All five remaining sections in one phase, not one at a time** — confirmed explicitly;
  Manifold proved the pattern, no reason left to defer the rest piecemeal.
- **One generic `capture_live_rows` table for Received/Refill/Private/Residual, not four
  near-identical tables** — these four all share the exact same "additive event, full row as
  JSONB, fetch by branch+date" shape `manifold_live_rows` already established; a `kind` column
  distinguishes them instead of four copies of the same table. (Manifold keeps its own table
  as-is — untouched, no migration risk to something already working.)
- **Seal Register gets bespoke tables, not the generic pattern** — `seal_used` needs a real
  `UNIQUE(roll_id, seal)` constraint so the *database* rejects a duplicate, not just a client
  read that might be racing another device's write. This is a genuine behavior upgrade, not
  just visibility — worth calling out since it's the one place this phase changes what gets
  accepted, not just what gets seen.
- **Branch Setup / Count Times share one small `app_config` key-value table** — two rows, no
  per-branch/date row explosion; these are settings, not events.

## Data model

### `capture_live_rows` (Received, Refill, Private, Residual)

```
id            uuid primary key default gen_random_uuid()
kind          text        -- 'received' | 'refill' | 'private' | 'residual'
row_id        text        -- existing client-generated _rid, already stamped on every row
branch        text
date          text
row           jsonb        -- the full committed row object, as-is
committed_by  uuid references profiles(id)
committed_at  timestamptz default now()
```
Indexed on `(kind, branch, date)`. RLS: SELECT + INSERT open to any signed-in user (matches
`manifold_live_rows`). No UPDATE/DELETE.

### `seal_rolls`

```
id            text primary key   -- existing client-generated roll id (newRollId())
branch        text
brand         text
start_no      integer
end_no        integer
status        text        -- Active | Queued | Depleted | Closed
warn_at       integer default 20
created_by    uuid references profiles(id)
created_at    timestamptz default now()
closed_by     uuid references profiles(id)
closed_at     timestamptz
close_reason  text
```
RLS: SELECT open to any signed-in user; INSERT/UPDATE restricted to Owner/Manager (matches
existing client-side `branch_setup`/Admin gating intent — enforced server-side here since this
table is genuinely security-relevant, unlike the read-mostly mirrors above).

### `seal_used`

```
id            uuid primary key default gen_random_uuid()
roll_id       text references seal_rolls(id)
branch        text
seal_no       integer
used_by       uuid references profiles(id)
used_at       timestamptz default now()
unique (roll_id, seal_no)
```
RLS: SELECT open to any signed-in user; INSERT open to any signed-in user whose capture
permissions already gate reaching a refill commit client-side (matches the trust model every
other write in this app already uses) — the `UNIQUE` constraint is what actually does the
work here, not the RLS policy. A duplicate INSERT fails with a Postgres conflict, which the
client reads as an authoritative "already used," same message the local check gives today.

### `app_config`

```
key           text primary key   -- 'branch_setup' | 'count_cutoff'
value         jsonb
updated_by    uuid references profiles(id)
updated_at    timestamptz default now()
```
RLS: SELECT open to any signed-in user; UPDATE/INSERT restricted to Owner/Manager.

## Write path

Same shape as Manifold's: at the exact point each capture-commit function already builds its
Sheet-push rows, add a parallel insert into the relevant table. On failure, queue to a
localStorage array and flush opportunistically (generalizing `_manifoldLiveQueue`/
`_manifoldLiveFlush` into a small reusable pair parameterized by table name + payload, rather
than copy-pasting four near-identical queues). The existing Sheet push is untouched in every
case.

Seal Register keeps `sealValidate` synchronous — same refresh-on-open shape as everything
else in this phase, not a special case: `seal_used` (and `seal_rolls`) are fetched into the
local `gs_seal_used`/`gs_seal_rolls` cache when the Refill screen opens or its branch changes,
exactly like Manifold's `_fetchManifoldLiveRows`. `sealValidate`'s existing local-array check
then sees cross-device history too, with no change to its own logic or call site.

The actual authoritative guarantee lives at commit time, not add-line time (same gap that
already exists locally today between adding a line and `sealRecordUse` running at commit —
not something this phase makes worse). `sealRecordUse`'s `seal_used` insert is the one write
in this whole phase that is allowed to fail meaningfully: if two devices raced and both
captured the same seal since their last refresh, the second commit's insert hits the
`UNIQUE(roll_id, seal_no)` conflict. That specific row is un-marked `_committed` and left in
the draft with a toast naming the duplicate, rather than silently queued-and-retried like
every other table in this phase — a queued-but-not-yet-applied duplicate check is worse than
no check. Every other row in the same commit (different seals) is unaffected.

## Read path

New fetch-on-open calls, one per section's own capture-grid open + branch-switch + relevant
Count History panel, mirroring `_refreshSharedCounts`/`_fetchManifoldLiveRows` exactly:
- `openReceived()` / `rSetBranch()`
- Refill's and Private's open/branch-switch (`openCap('refill'/'private',...)`, its branch
  switch)
- `residualSubmit`'s screen open equivalent
- Seal Register: fetches both `seal_rolls` and `seal_used` for the current branch on the
  Refill screen open/branch-switch (`openCap('refill',...)`, `capSetBranch`) — where
  `sealValidate` actually runs — *and* on the Admin Seal Register tab open/branch switch,
  where the roll config is managed
- Branch Setup / Count Times admin tab open — fetches `app_config`, replacing the local
  `bcfg`/`count_cutoff_cfg` blob wholesale (Owner-edited settings, last-write-wins is fine)

Each replaces only that section's local slice for the branch+date being viewed, exactly like
Manifold's read path — every other section/branch/date already in local `store` is untouched.

## Known limitation (carried forward, explicitly accepted)

Same as Manifold: an Adjust/correction updates the correcting device's local store and the
Adjustments log, not the mirror row. A third device sees the pre-correction value until it
also checks Adjustments. Not addressed this phase.

## Success criteria

- A Received/Refill/Private/Residual row committed on Device A appears in `store` on Device B
  the next time B opens that section (or Count History) for the same branch+day.
- A seal already used on Device A is rejected as a duplicate on Device B even seconds later,
  via the server-side `UNIQUE` constraint — not dependent on B's own local history.
- Branch Setup / Count Times changes made by the Owner on one device are visible to any other
  device the next time its Admin tab is opened.
- The Close Day report and Count History panels for every section above show real cross-device
  data, no code change beyond the fetch-on-open itself.
- Every existing Sheet push, local-first offline behavior, and already-shipped Manifold/Count
  live-sync is unaffected.
