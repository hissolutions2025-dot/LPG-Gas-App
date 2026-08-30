# Manifold "Removed" Step Continuity — Design

## Why this phase

Live testing of the swap wizard surfaced a real gap: step 1 (weighing the OUTGOING cylinder)
gives the operator no reference point at all. They re-type brand and gas type from scratch even
though it's presumably the same physical cylinder that's been in that slot all along, and there's
nothing checking whether the tare they just weighed actually matches what that cylinder's tare
should be. A wrong-cylinder-weighed mistake, or a fat-fingered tare, currently sails through
silently and is only discoverable later by digging into Review.

This is also, not coincidentally, the first real slice of the "expected tare" concept the
original Manifold slot-identity design deliberately deferred to a later phase. Doing it now,
scoped tightly, is the right next step — not a detour.

## Scope of this phase

**In scope:**
- Step 1 (Removed) pre-fills Brand and Gas Type from a baseline derived from this slot's own
  recent history — locked, not editable — so the operator doesn't re-enter data that should
  already be known, and so the locked fields themselves visually confirm "this is the cylinder
  being replaced."
- A live, informational tare-mismatch check: as the operator types Tare, compare it against the
  same baseline. Any difference highlights the Tare field with a short message. Never blocks
  Save — this is a flag, not a gate.
- When a row saves with a mismatch still showing, it's marked and audit-logged, and shows up as
  a small marker in Count History and the Count Doc.
- The baseline itself is allowed to reach back to yesterday's Closing when there's no same-day
  Opening for that slot yet — reusing the existing live cross-day lookup Stock Count's own
  mismatch detection already relies on, not a new mechanism.

**Explicitly out of scope:** a dedicated resolve/tab workflow for these mismatches (that's the
bigger, still-deferred Manifold mismatch-detection phase — this is a live, in-the-moment nudge
for the operator, not a Manager-facing queue to work through). No changes to the Added-stage
underfill/used-cylinder logic, the two-tier weight validation, or the Faulty Cylinders
deep-link — all already shipped and untouched.

## Decisions made during design

- **Baseline is a 3-tier chain, most-recent-first**, each tier only consulted if the one before
  it has nothing for this slot today:
  1. An earlier swap already happened today for this slot → baseline is that swap's incoming
     (Added) row.
  2. Else, this slot has an Opening row captured today → baseline is that row.
  3. Else, yesterday's Closing for this slot (if it exists) → baseline is that.
  4. Else — no data anywhere — no baseline. No pre-fill, no lock, no mismatch check. Fields
     behave exactly as they do today.
- **Brand/Gas Type are locked (not just defaulted) whenever a baseline exists.** Confirmed
  explicitly: editable pre-fill risks an accidental overwrite, and a genuinely-wrong value
  belongs to the existing post-commit correction tool, not an inline edit mid-capture.
- **Tare tolerance is zero** — any difference at all triggers the flag, confirmed explicitly.
  Compared after rounding to 2 decimals (this app's existing convention for scale/tare
  comparisons), not raw floating-point equality, to avoid a false flag from ordinary binary
  float representation error.
- **The flag never blocks Save.** Matches the existing Gas Left live-warning's own behavior —
  visual only, informational, the operator can proceed regardless.
- **Logging reuses an existing pattern**, not a new one: Refill's out-of-sequence seal flag
  already stamps a row and shows a marker in the row's own description — this feature follows
  the same shape (a stamped field on the saved row, an audit log entry, a small marker
  downstream) rather than inventing a new logging mechanism.

## Data model

### Baseline lookup

A new function resolves the 3-tier chain above for a given branch/slot, returning
`{brand, gasType, tare}` or `null`. Tiers 1-2 read from data already loaded on-device today
(`capData`/`store.manifold`, same as everything else in the swap wizard); tier 3 reaches for
yesterday's Closing via the same live Supabase read Stock Count's `_fetchLiveExpectedOpening`
already performs (a `day_closes`/saved-day lookup) — no new backend query shape, reusing what
already exists.

### Step 1 (Removed) form behavior

- When a baseline resolves: Brand and Gas Type fields render as locked/read-only, pre-filled
  from the baseline. Scale and Tare remain blank and fully editable, as today — they're always
  freshly weighed, never pre-filled.
- When no baseline resolves: Brand and Gas Type render exactly as they do today — open,
  operator-selected, no lock.

### Live tare check

As Tare is typed (only when a baseline exists — tier 4 has nothing to compare against):
compute `enteredTare` rounded to 2 decimals, compare to `baseline.tare` (also rounded to 2
decimals). Any difference → the Tare field highlights and a short message appears underneath
("Doesn't match this slot's tare — expected Xkg"), same visual language already established for
the Gas Left live warning (highlight + small message, clears the moment the value is corrected
back to matching). No difference → no highlight, no message.

### Saving with a mismatch still showing

If the row saves while the tare mismatch is still active: the saved row is stamped (a flag
field on the row, mirroring Refill's existing `_sealFlag` convention), an audit log entry is
written recording the slot, the entered tare, and the expected tare, and Count History's
Manifold table plus the Count Doc's Manifold section both show a small marker on that row —
mirroring exactly how Refill's own out-of-sequence flag is already surfaced in those same kinds
of views.

## Success criteria

- Starting step 1 for a slot that has same-day Opening data (or, absent that, yesterday's
  Closing data) shows Brand/Gas Type already filled in and locked, with no re-entry needed.
- Typing a tare that doesn't match the resolved baseline highlights the field and shows a short
  message immediately — before Save, not after.
- Saving anyway is always possible — the flag is informational, never a hard stop.
- A flagged save is visible after the fact in both the audit log and Count History/Count Doc,
  not just in the moment it happened.
- A slot with no baseline at all behaves exactly as it does today — no regression for the
  first-ever use of a slot, or a slot at a branch that's never run Opening/Closing before.
