# Pending Overrides Screen Polish — Design

## Why this phase

The Pending Overrides screen (Manager/Owner only — approve or reject a Manifold reading
submitted for remote authorisation) works, but was built minimally: plain amber-bordered
cards with just gas-left/cap and who/when, `prompt()`/native browser dialogs for the reason
text, and no way to see the full reading or fix an obviously-wrong number without either
blindly approving it or rejecting it back to the operator.

## Scope of this phase

**In scope:**
- Fetch and display the full captured line (brand, gas type, scale, tare, photo) for each
  pending item, not just gas left/cap.
- Show an "expected vs actual" comparison line, framed per override kind.
- Show a same-branch/same-operator pending-item count when more than one exists, to surface
  a pattern (e.g. one operator submitting several overrides today).
- Replace `prompt()`-based reason/note entry (Approve/Reject) with the app's own `askText()`
  modal — already used by `manifoldWeightOverride()` for the same physically-present-Manager
  flow, not a new mechanism.
- Redesign the card visually: icon + colour-coded left border per kind, clearer hierarchy.
- New "Fix reading" action: deep-links into the existing same-day Adjust tool
  (`openCapAdjust()`), pre-scoped to that exact row (branch/stage/cylinder switched
  automatically), so a Manager who can tell the number's just a data-entry mistake can
  correct it in place, then Approve the corrected value — instead of blind-approving a wrong
  number or rejecting and waiting on the operator.

**Explicitly out of scope:**
- No change to the Reject flow's resolution path — the existing rejected-recheck screen
  (operator re-weighs directly from their own tile, no Manager round-trip) already covers
  the equivalent gap on that side. "Fix reading" is Approve-side only.
- No change to `_manifoldPendingOverrides` fetch scoping (branch/role visibility) — unrelated
  to this phase.
- No change to how/when an item becomes PENDING in the first place (`addLine()`'s
  HARD_CEILING/FLAGGED_BAND/USED_PARTIAL branches) — untouched.

## Data model

`manifold_pending_overrides` only carries `gas_left`/`cap` (the two numbers the original
threshold check needed) plus `row_rid` — it was never meant to duplicate the full captured
line. That line lives in `manifold_live_rows`, keyed by `row_id===row_rid`. This phase adds a
join: after fetching pending overrides, fetch the matching `manifold_live_rows` rows (by the
set of `row_rid`s currently pending) and merge `brand`/`gasType`/`scale`/`tare`/`photo` onto
each pending item in memory before rendering. A row whose live-mirror hasn't finished syncing
yet (rare, matches the same race already handled elsewhere in this feature) simply renders
without the extra detail — same graceful-degradation shape used throughout this feature set,
not a new pattern.

## Card layout

Per pending item:
- Icon + left-border colour by kind: 🔴 Hard ceiling (`--bad`), 🟠 Flagged band (`--amber`),
  🔵 Used/partial (`--navy` or similar neutral-informational tone — not a warning colour,
  since this kind isn't a threshold breach).
- Header: branch — cylinder — kind label (unchanged content, restyled).
- **Expected vs actual**:
  - Hard ceiling / Flagged band: "Expected ≤ {cap+tolerance}kg → Got {gas_left}kg"
  - Used/partial: "Declared used/partial cylinder — {gas_left}kg" (no threshold framing;
    the sign-off is on the decision to use a non-fresh cylinder, not a number)
- Full capture line: "{brand} {gasType} · Scale {scale}kg · Tare {tare}kg" (only rendered if
  the join succeeded)
- Photo thumbnail (`<img>`, same inline style already used everywhere else in this app for
  captured photos), only if `photo` is non-empty.
- Submitted-by / when (unchanged).
- Pattern note, only shown when count > 1: "N other pending item(s) from this
  operator/branch today" (computed client-side from the already-fetched
  `_manifoldPendingOverrides` array, no extra query).
- Three actions: **Approve**, **Reject**, **Fix reading**.

## Approve / Reject

Same `resolvePendingOverride(id,decision)` logic, same auth gate (Manager/Owner,
self-reauth or borrowed), same `.eq('status','PENDING')` race-guard on the update. Only the
reason/note collection changes: `askText('Reason for override' / 'Optional note', ...)`
instead of `prompt(...)`. Required-on-reject / optional-on-approve behaviour unchanged.

## Fix reading

New action button, visible on every pending card. On tap:
1. Switches `capBranch`/`toggleSel.stage` to match the item's branch/stage (same pattern
   `_goToManifoldAdded()` already uses for a stage switch), navigates into Manifold capture.
2. Opens the existing `openCapAdjust()` correction picker, pre-selected on this exact row
   (by `row_rid`) instead of the full unfiltered list — the Manager lands directly on the
   one line that needs fixing, not a fresh pick-from-everything screen.
3. Correction applies exactly as `openCapAdjust()` already does today (Manager/Owner auth +
   reason, `syncPush('Adjustments',...)`, audit log, sheet row update) — no new correction
   mechanism.
4. After closing the Adjust tool, the Manager returns to Pending Overrides with the item
   still PENDING (fixing the number doesn't itself resolve the override — a deliberate
   choice, for a clean audit trail of "this was corrected" separately from "this was
   authorised") — the Manager then taps Approve normally, now approving the corrected value.

## Success criteria

- A Manager can see everything they need (full reading + photo + expected-vs-actual) on one
  card, without navigating elsewhere first.
- Reason/note entry never shows a native browser `prompt()` again on this screen.
- A Manager who spots an obvious data-entry mistake can fix it in 2 taps (Fix reading →
  correct value) instead of rejecting and waiting on the operator, or blind-approving a wrong
  number.
- Reject's existing resolution path (operator rechecks from their own tile) is completely
  unaffected.
- Every existing safety property (race-guard on double-resolution, branch-scoped Manager
  visibility, audit logging) is preserved untouched.
