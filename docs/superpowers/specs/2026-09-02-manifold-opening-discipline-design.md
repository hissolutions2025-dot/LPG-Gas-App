# Manifold Opening Discipline — Design

## Why this phase

Manifold's Opening stage currently has no cross-day link to yesterday's Closing at all — an
operator can type any Brand/Gas Type/Scale/Tare for any slot, in any order, with no check
against what was actually recorded when that slot was closed out the day before. Stock
Count already solves the equivalent problem for cylinder counts (`_fetchLiveExpectedOpening`/
`cExpectedFor`/`cIsFlagged` — a live, zero-tolerance flag against yesterday's Closing
quantities). Manifold needs the same discipline, adapted to its own shape: a physical slot
holding one specific cylinder, not a size/brand/state tally.

Two business reasons drove this, both stated directly:
- **Operational discipline** — Opening must be captured in the same order every day (Cyl 1,
  then Cyl 2, then Cyl 3...), with no skipping ahead, so operators build a consistent habit
  rather than working the slots in whatever order is momentarily convenient.
- **Leak detection** — a cylinder valve not fully closed overnight loses gas silently. The
  only way to catch that is a genuine, blind re-weigh every morning, compared against what
  was recorded at yesterday's close. If the app pre-filled or carried forward yesterday's
  numbers, the operator would never actually re-weigh, and a real leak would go completely
  undetected.

This is why the design explicitly rejected the earlier, entirely different design of the same
underlying idea (a locked, pre-filled Opening screen) — that shape is right for Manifold's
existing SAME-DAY lock (no legitimate reason to re-weigh Opening twice in one day) but wrong
for the CROSS-DAY case, where a fresh, blind re-weigh is the entire point.

## Scope of this phase

**In scope:**
- Opening's Brand, Gas Type, Scale, and Tare fields stay exactly as they are today — fully
  open, manually entered, no pre-fill, no lock, no visibility into yesterday's Closing figures
  while entering.
- A live, per-field flag as the operator types, comparing against yesterday's Closing for
  that exact slot: Brand differs, Gas Type differs, Tare differs, or the computed Gas Left
  differs — all zero-tolerance (any difference at all flags it, not a tolerance band).
  Visually identical to the existing tare-mismatch warning already built for Removed/Closing
  (amber border + short message under the field) — the same idiom, applied to more fields and
  a different stage.
- Saving with a flag still showing is always allowed (never blocks Save) — same as every
  other flag-not-block pattern already in this app. The row is stamped, shown with a marker
  in History/Count Doc, and audit-logged — mirroring the existing tare-mismatch precedent
  exactly, not inventing a new mechanism.
- Sequential order lock: a slot's Opening tile is disabled (greyed, not tappable) until every
  slot before it (Cyl 1 before Cyl 2, Cyl 2 before Cyl 3, and so on, in the branch's own slot
  order) has an Opening reading — draft or committed, same "has it been touched today" check
  the existing same-day-lock already uses. Hard-blocked, no override — explicitly confirmed:
  discipline over flexibility here.
- Scoped to Opening only. Added/Closing/Removed are completely unaffected — no order lock, no
  new flags, byte-for-byte unchanged.

**Explicitly out of scope:** any pre-fill or lock of the Opening fields themselves (the
opposite of what's being built here); Stock Count (already has its own live, equivalent
system — `_fetchLiveExpectedOpening`/`cExpectedFor`/`cIsFlagged` — confirmed working, nothing
to change); a tolerance band on any of the four compared fields (zero tolerance across the
board, confirmed explicitly); an escape hatch on the order lock (confirmed explicitly - hard
block only).

## Decisions made during design

- **Blind entry, not pre-fill** — confirmed explicitly, twice, after an initial
  misunderstanding: the whole point is a genuine re-weigh, not a locked view of yesterday's
  numbers. This directly drove rejecting the earlier design and starting over.
- **Zero tolerance on every compared field** — confirmed explicitly: Brand and Gas Type are
  categorical (either match or they don't, no tolerance concept applies to them anyway);
  Scale/Tare/Gas Left get treated the same way as the existing tare-mismatch check already
  does (any difference at all, compared after rounding to 2 decimals per this app's existing
  scale/tare-comparison convention, not raw floating-point equality).
- **Flag, never block** — confirmed explicitly: "just like the tare weight and overfilled
  messages" - the existing live-warning idiom, not a new hard-stop mechanism.
- **Hard-blocked sequential order, no override** — confirmed explicitly: "operator subjected
  to discipline [rather] than confusion trying to figure out what fits where."
- **Stock Count needs no work** — confirmed via direct code inspection during this
  conversation: `_fetchLiveExpectedOpening`/`cExpectedFor`/`cIsFlagged` already provide the
  equivalent live, zero-tolerance flagging for Count's own Opening-vs-previous-Closing check.

## Data model

Reuses `_manifoldPrevClose`/`_fetchManifoldPrevClose(br)` (already built for the Removed-step
baseline chain's tier 3), extended to also capture `scale` and `gasLeft` from yesterday's
Closing row (currently only `brand`/`gasType`/`tare` are stored) — needed so the live Gas
Left comparison has yesterday's figure to compare against, without a second live Supabase
query duplicating the same `day_closes` lookup the Removed-step baseline already performs.

## Live per-field flags (during Opening entry)

As the operator types, for a slot where `_getManifoldPrevClose(capBranch,item)` resolves
(same "no baseline, no check" graceful fallback already used everywhere else in this feature
set — a slot with no prior close simply isn't checked, exactly like today):

- **Brand** differs from yesterday's Closing brand → flag.
- **Gas Type** differs → flag.
- **Tare** differs (rounded to 2dp) → flag — same rule, same rounding convention, same visual
  treatment the existing Removed/Closing tare-mismatch check already uses.
- **Gas Left** (computed live from Scale − Tare) differs from yesterday's Closing Gas Left
  (rounded to 2dp) → flag.

Each flagged field gets its own short message under it (mirroring the existing tare-mismatch
message shape: "⚠ Doesn't match yesterday's close — expected X"). Multiple fields can be
flagged simultaneously and independently - a wrong Brand and a leaking cylinder are two
different problems, both worth surfacing.

## Save-time stamping

If any field is still flagged when the row is saved: the row is stamped (a flag field,
mirroring the existing `_tareFlag` convention exactly - a same-shaped field per compared
attribute, e.g. `_openingBrandFlag`/`_openingGasTypeFlag`/`_openingTareFlag`/
`_openingGasLeftFlag`, or a single combined flag naming which fields differed - decided during
planning, not a design-level distinction), an audit log entry is written naming exactly which
field(s) differed and by how much, and History/Count Doc show a marker on the row - the exact
same downstream surfacing the tare-mismatch flag already has, not a new display mechanism.

## Sequential order lock

On the Manifold capture grid, while viewing the Opening stage: a slot's tile is rendered
disabled (matching the existing deactivated-tile visual treatment already used for a
branch/user without access to that item) whenever any EARLIER slot (by the branch's own slot
order, Cyl 1 through Cyl N) does not yet have an Opening reading today - draft or committed,
the same "has it been touched" check `_manifoldOpeningAlreadyCaptured` already performs for
the same-day lock. Tapping a disabled tile does nothing (or shows a short toast naming which
slot needs to be done first) - no override, no escape hatch. The very first slot (Cyl 1) is
never locked by this rule, since there is no earlier slot to wait on.

This lock is independent of, and stacks with, the existing same-day lock: a slot already
captured today still shows its own already-captured lock screen when tapped; the NEW order
lock only applies to a slot that hasn't been captured yet and is waiting on an earlier one.

## Success criteria

- Opening fields are never pre-filled or locked from yesterday's data - every entry is a
  genuine, fresh, blind capture.
- A slot whose freshly-entered Brand, Gas Type, Tare, or computed Gas Left differs at all from
  yesterday's Closing shows a live, per-field warning before Save, and the same information
  survives into History/Count Doc/Audit Log if saved anyway.
- Cyl 2 (and every later slot) cannot be opened for capture until every slot before it has an
  Opening reading today - no way to skip ahead, by accident or on purpose.
- A slot with no prior Closing data (first-ever use, or a branch with no history for that
  slot) behaves exactly as it does today - no flags, no false positives.
- Every other Manifold feature already shipped this session (tolerances, same-day Opening
  lock, tare-mismatch on Removed/Closing, live cross-device data, remote override approval)
  is completely unaffected.
