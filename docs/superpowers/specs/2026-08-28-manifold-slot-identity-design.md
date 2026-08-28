# Manifold Slot Identity & Swap Tracking — Design

## Why this phase

Manifold's Opening-vs-previous-Closing mismatch detection (the next phase, matching what
Stock Count already has) needs a real baseline to compare against. Today that baseline is
naive: it compares "Cyl 1 this morning" against "Cyl 1 at yesterday's close" purely by label,
with no concept of whether it's actually the same physical cylinder.

That assumption breaks constantly in practice. The manifold's four 48kg DV donor cylinders
don't run empty together — each gets replaced independently, whenever it runs dry, with a
fresh full one swapped into the same slot. The existing "Added" capture stage records that a
swap happened, but doesn't ask which slot it's replacing, doesn't carry the new cylinder's
identity forward as that slot's baseline, and doesn't capture what was still in the outgoing
cylinder when it left. Building mismatch detection on top of that would compare the wrong
things by design, not by bug — every swap would look like an unexplained discrepancy.

This phase fixes the underlying capture/tracking gap first, so the next phase's detection
actually means something once real swaps are happening.

## Scope of this phase

**In scope:**
- A swap ("Added") explicitly asks which slot is being replaced, captures the outgoing
  cylinder's residual gas before capturing the incoming cylinder's reading, and the incoming
  cylinder becomes that slot's identity going forward.
- Tare weight as the per-reading fingerprint used to reason about slot continuity across a
  swap, within a day, or across days.
- A slot's "expected tare" is correctly threaded through the whole day — starting at that
  slot's Opening reading, updated to the incoming cylinder's tare if a swap happens, so
  Closing capture always has the right value to eventually be checked against. **The data
  threading is in scope here; the actual flag/notify/resolve UI for a mismatch is explicitly
  deferred to the next phase** (see below) — same reasoning as the cross-day case.
- Two-tier weight validation (tolerance band, Manager/Owner overridable; hard ceiling, never
  overridable) replacing today's flat, always-blocking cap — for both gas types, each
  anchored to its own nominal capacity (LPG 48kg, Propane 45kg).
- Manifold slot count becomes an Owner-configurable, per-branch setting instead of a fixed 4.

**Explicitly out of scope, deferred to the next phase:** the actual mismatch detection,
permanent tab, and resolve flow for Manifold (the Stock Count pattern, applied to Manifold) -
covering BOTH cases this phase's data threading enables: cross-day (today's Opening tare vs.
yesterday's Closing tare) and same-day (a slot's Closing tare vs. its own expected tare for
that day, see "Same-day continuity" below.) One detection mechanism, one UI, both cases -
not two separate systems. This phase is the prerequisite groundwork for that phase, not that
phase itself.

## Decisions made during design

- **A slot is a position label (Cyl 1..N), not a new tracked-cylinder entity.** Considered
  giving each physical cylinder its own persistent ID that could move between slots or be
  tracked across its whole lifecycle — rejected as more architecture than the actual need.
  The requirement, and the existing data model, are both consistently slot-based ("the added
  cyl becomes the new number 1"). What's new is that each reading at a slot carries its own
  `tare`, which is what lets the system reason about whether a swap actually happened between
  two readings, without needing a separate identity system.
- **Swap capture is two sequential steps, not one combined form.** Tapping "Added" for a slot
  first captures the outgoing cylinder's residual reading (closing out its record), then
  immediately continues into capturing the incoming cylinder's reading (today's existing
  Added-stage form). Matches the real physical sequence — you can't weigh both cylinders at
  once, since removing one is what makes room to weigh and install the other.
- **Slot count is per-branch, not global** (explicit choice) — each branch's own manifold
  hardware, upgradeable independently.
- **Validation reuses the existing override-password pattern** (the same mechanism as the
  seal-boundary override), not a new one.

## Data model

### Manifold row (`store.manifold`)

Existing shape: `{stage, cyl, brand, gasType, scale, tare, gasLeft, notes, photo, branch,
_date, _operator, _time, _rid, ...}`, with `stage` an enum currently `Opening|Added|Closing`.

- `stage` gains a fourth value, `Removed`, for the outgoing cylinder's final reading at the
  moment of a swap — parallel to `Closing` in shape (same fields: scale, tare, gasLeft), but
  mid-day and specific to the one cylinder leaving, not the whole slot's end-of-day state.
- An `Added` row (and its paired `Removed` row) both carry the slot they belong to via the
  existing `cyl` field, plus a shared `_swapId` (or equivalent) linking the two halves of one
  swap event together for audit display.
- The day's gas mass-balance calculation (`sumStage('Added')` etc.) gains a matching
  `sumStage('Removed')` bucket, so residual gas leaving in a removed cylinder is accounted
  for in the day's reconciliation instead of silently vanishing from the numbers.

### A slot's expected tare (derived live, not stored separately)

Same "derive live, don't store a redundant baseline" principle the shared opening-mismatch
work already established for Stock Count. For a given slot on a given day:

- Starts as that slot's `Opening` row's `tare`.
- If an `Added`/`Removed` swap pair exists for that slot later that same day, the expected
  tare becomes the `Added` row's `tare` instead, from that point forward.
- This is what `Closing`'s own tare should be checked against — same value if the slot was
  never swapped that day, the swapped-in cylinder's value if it was.

Nothing new is stored for this — it's computed from the day's own `Opening`/`Added`/`Removed`
rows for that slot each time it's needed, the same way the cross-day baseline is read live
from `day_closes` rather than duplicated.

### Manifold slot count setting

New Owner-configurable, per-branch setting, surfaced alongside Branch Setup/Count Times in
Admin. Determines how many slots (`CYLS`) render on the Manifold capture grid for that
branch. Existing branches default to today's fixed count (4) so nothing changes until an
Owner deliberately changes it.

**Supabase-synced, not device-local** - caught during plan-writing and confirmed here rather
than assumed: Branch Setup and Count Times, the settings this sits next to in the Admin UI,
are both device-local only (`localStorage`, no cross-device sync). That's fine for on/off
admin preferences, but slot count directly determines what the capture grid *shows* - if it
stayed device-local, an Owner changing it on their own phone wouldn't affect what an Operator's
phone renders, and they'd literally be capturing against a different number of slots. This
follows the same Supabase-synced pattern established for anything else in this app that must
render identically across devices, not the local-only pattern of its Admin-screen neighbors.

## Validation rules

Anchored to each gas type's own nominal capacity (`cap` = 48 LPG / 45 Propane, matching the
existing `gasLeftCap` code's own convention). Applies at **every stage** (Opening/Added/
Removed/Closing), not just Added — an earlier draft of this doc scoped the tolerance band to
Added only, reasoning that Opening/Closing readings are normally well below capacity so
wouldn't need it; corrected after review, since the point isn't "this stage should be near
capacity," it's "whenever ANY reading happens to land in this zone, flag it" - an operator
fat-fingering a digit can produce a near-capacity reading at any stage, and the system can't
tell that apart from a cylinder that's genuinely still near-full (e.g. a backup slot that
barely got used that day) without a person looking at it - which is exactly what the
override-with-reason step is for, regardless of which stage triggered it.

| Range (relative to `cap`) | LPG example | Propane example | Behavior |
|---|---|---|---|
| `cap − 0.1` to `cap + 0.1` | 47.9–48.1kg | 44.9–45.1kg | Normal, no flag |
| `cap + 0.1` to `cap + 0.2` | 48.1–48.2kg | 45.1–45.2kg | Flagged; Manager/Owner password + reason overrides it, same as the existing seal-boundary override |
| `cap + 0.2` and above | 48.2kg+ | 45.2kg+ | Never saved, no override — clear message shown, operator must re-weigh and correct before it can be saved at all |

All three rows apply uniformly to Opening, Added, Removed, and Closing readings alike.

Gas-left can never be negative — already true today for free (the existing "scale cannot be
less than tare" check makes this impossible), no new work needed.

## Swap capture flow

1. Operator taps "Added" (unchanged entry point).
2. App asks which slot (Cyl 1..N) is being replaced.
3. App captures the **outgoing** cylinder's current reading (scale/tare/gas left) — stamped
   `stage: 'Removed'` for that slot, closing out its record. This is the residual-gas audit
   trail point 4 of the requirements asked for.
4. App continues immediately into capturing the **incoming** cylinder's reading — the
   existing Added-stage form, validated per the two-tier rule above. On save, this becomes
   the new occupant of that slot.
5. Both readings are visible together in that slot's history (Count History / audit), linked
   as one swap event.

## Same-day continuity (confirmed requirement)

Beyond the cross-day case (this slot's Opening tare vs. yesterday's Closing tare — the
original motivation for this phase), a slot's tare must also stay consistent *within* one
day: if a slot was never swapped, its Closing tare must match its own Opening tare (same
physical cylinder, whose empty weight doesn't change regardless of how much gas is left in
it); if it was swapped, Closing's tare must match the swapped-in cylinder's tare, not the
original morning one. A mismatch either way is a real signal — the wrong cylinder was
physically weighed, a swap happened without going through the proper capture flow, or a data
entry mistake — exactly the kind of checkpoint requirement 4 (operators can manipulate
figures) was pointing at.

This phase makes sure the "expected tare" data above is correctly threaded and available for
that comparison. The comparison itself, and what happens when it doesn't match (flag, notify,
resolve), is built in the next phase alongside the cross-day case, through the same
mechanism - not duplicated as a second, separate system.

## Rollout

Same convention as every other phase this project has used: isolated worktree, task-by-task
implementation with two-stage review, live verification against the real Supabase project
before merging to `main`.

## Success criteria

- Swapping a cylinder mid-day correctly records both the outgoing cylinder's residual and the
  incoming cylinder's reading, tagged to the right slot, without operators needing to
  remember two separate manual steps outside the guided flow.
- A cylinder added between the tolerance band and the hard ceiling requires Manager/Owner
  authorization to save; at or above the hard ceiling, nothing can save it at all, and the
  operator is told clearly why.
- Manifold slot count can be changed per branch by an Owner without a code change, and
  existing branches are unaffected until changed.
- The next phase (Manifold mismatch detection) can rely on each slot's carried-forward
  identity being correct, including across a mid-day swap.
