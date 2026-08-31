# Manifold Live Cross-Device Data — Design

## Why this phase

Everything captured during Manifold work (Opening/Added/Closing/Removed rows) lives ONLY in
the localStorage of the device that captured it (`loadWorkingStore()` reads exclusively from
this device's own `workKey(today,branch)`; `syncPush()` is a fire-and-forget POST to the
Google Sheet, never read back). A Manager opening the app on their own phone has zero
visibility into anything an operator committed on a different device — which is the exact,
confirmed root cause behind three separately-reported pain points this session: the "Adjust
an already-committed entry" button not appearing on a Manager's phone after changes made on
a different device, the request for real-time Manager-override notifications, and the
Manager Action Hub idea. All three need the same foundation: a way for one device's committed
Manifold data to actually reach another device.

This phase builds that foundation for Manifold only — the capture type that's actually
surfaced every one of these problems — rather than all six capture types at once. The other
five (Count, Refill, Private, Received, Residual) reuse the exact same pattern later if/when
needed.

## Scope of this phase

**In scope:**
- Every COMMITTED Manifold row (Opening/Added/Closing/Removed, once saved past the popup)
  becomes visible to any device, on demand — not just the device that captured it.
- Fetch-on-open: a device pulls the current live truth when a relevant screen opens
  (Manifold capture, Review, the Adjust picker, Count History's Manifold table) — not a
  continuously-open live connection.
- The existing Google Sheet push (accounting record of truth) is completely unchanged —
  this adds a parallel write, not a replacement.
- The existing same-day Adjust tool's own correction logic (`_openCapAdjustReal`, the picker
  build and `openCorrection` call) needs no change — once `store.manifold` is correctly
  hydrated from live data first, it already operates correctly on whatever's actually there.
  (`openCapAdjust` itself does gain a thin wrapper — the same fetch-first/busy-guard/
  staleness-check shape used for Review — but that's plumbing around the entry point, not a
  change to the correction logic itself.)

**Explicitly out of scope:** true real-time push (data appearing on an open screen without
any action) — deferred; the Manager-override-notification screen and the Action Hub
themselves — this phase only builds the data foundation they both need, not either feature;
in-progress/uncommitted drafts (`capData`) staying cross-device — only committed rows are in
scope, an in-progress capture stays private to the device doing it, which is the correct
behavior, not a gap; the other five capture types; an Adjust correction updating the mirror
row itself (see Known Limitation below).

## Decisions made during design

- **Manifold only, not all six capture types** — confirmed explicitly: prove the pattern on
  the capture type that's actually been causing problems, extend later.
- **Fetch-on-open, not true real-time push** — confirmed explicitly: simpler, no persistent
  connections to manage, still solves the actual reported problem (a Manager who wasn't
  seeing another device's data at all now sees it the moment they open the relevant screen).
- **Additive Supabase mirror, Sheet push untouched** — rejected making Supabase the sole
  source of truth (bigger, riskier, needs a new export job) and rejected a version-flag
  polling scheme (solves a "stays live while the screen is open" problem that was just
  explicitly declined as unnecessary for this phase).
- **Full row as JSONB, not a rigid per-field schema** — the row shape has already changed
  several times this session (tareFlag, residualFlag added) and will keep evolving; a JSONB
  blob plus a few indexed lookup columns avoids a schema migration every time a new field is
  added to a Manifold row.
- **An Adjust correction does not update the mirror row this phase** — accepted, matching the
  same already-documented limitation for Received's own same-day adjustment tool (the full
  picture requires checking the original row plus the Adjustments log together, not the
  original row alone).

## Data model

New Supabase table, `manifold_live_rows`:

```
id            uuid primary key default gen_random_uuid()
row_id        text        -- the existing client-generated RowId already stamped on every
                           -- committed Manifold row; makes a retried write idempotent
branch        text
date          text        -- matches the app's own `today` string format
cyl           text
row           jsonb        -- the full committed row object, as-is
committed_by  uuid references profiles(id)
committed_at  timestamptz default now()
```

Indexed on `(branch, date)` for the fetch-on-open lookup shape. RLS: SELECT open to any
signed-in user (matches `manifold_settings`'s existing policy — every operator/Manager/Owner
screen that needs this needs to read it). INSERT open to any signed-in user (matches
`syncPush`'s existing trust model — who can actually reach a commit is already gated
client-side by capture permissions, same as it is today for the Sheet push). No UPDATE/DELETE
policy this phase.

## Write path

The Manifold branch of the shared capture-commit function, at the exact point it already
builds the set of freshly-committed rows for the Sheet push, now also writes that same set
to `manifold_live_rows` (one row per committed line, `row_id` set from the row's existing
client-generated id). On failure: queued to a small localStorage array (same simple shape
`syncQueue`/`syncFlush` already use for the Sheet push, own key, since the payload shape and
target are different), flushed opportunistically on login and after the next successful
write. The existing Sheet push itself is not touched in any way — this is purely additive.

## Read path

New `_fetchManifoldLiveRows(branch, date)`: `sb.from('manifold_live_rows').select('row').eq
('branch',branch).eq('date',date)`. Called at the top of every screen that needs today's real
cross-device Manifold truth: opening Manifold capture, Review, the Adjust picker
(`openCapAdjust` for Manifold), and Count History's Manifold table. On success: replaces this
branch+date's slice of local `store.manifold` with what came back — the exact same
replace-by-scope merge `loadWorkingStore()` already performs locally, just sourced live
instead of from this device's own storage; every other branch/date already in local `store`
is untouched. On failure or while offline: silently keeps whatever's already local — never
blocks capture from working, matching every other live fetch already in this app.

## Closing the Adjust-visibility gap

Once a screen performs this fetch before rendering, `store.manifold` on any device
legitimately contains whatever another device actually committed. `openCapAdjust` already
reads and mutates live `store.manifold` — no code change needed there at all; the gap closes
purely as a consequence of `store.manifold` finally being correct.

## Known limitation (explicitly accepted this phase)

An Adjust correction updates the correcting device's local `store` and logs to the
Adjustments sheet tab, exactly as it does today — it does NOT also update the corresponding
`manifold_live_rows` mirror row. A THIRD device fetching live data after that point would see
the original committed value, not the corrected one, until/unless it also checks the
Adjustments log — identical to the already-documented, already-accepted limitation for
Received's own same-day adjustment tool. Worth revisiting only if this actually causes a
real problem in practice.

## Success criteria

- A Manifold row committed on Device A becomes visible in `store.manifold` on Device B the
  next time Device B opens Manifold capture, Review, the Adjust picker, or Count History for
  that branch+day — with no manual refresh mechanism needed beyond opening the screen.
- The "Adjust an already-committed entry" option correctly appears on Device B for a row
  Device A committed, and successfully applies a correction.
- The existing Google Sheet push is unaffected — same rows, same shape, same timing, whether
  or not the new Supabase write succeeds.
- A failed Supabase write is retried, not silently lost, and never blocks the commit itself
  from completing and pushing to the Sheet.
- A device with no network at fetch-on-open time still shows its own already-local data,
  never a blank/broken screen.
- No other capture type (Count/Refill/Private/Received/Residual) or any already-shipped
  Manifold feature (tolerances, tare-mismatch, underfill, leftover, hard-ceiling override)
  changes behavior.
