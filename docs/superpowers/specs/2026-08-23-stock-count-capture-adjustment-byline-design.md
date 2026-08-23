# Stock Count: capture/adjustment byline — Design

## Why

The Phase 2b pilot (Stock Count on Supabase) makes committed counts visible and
correctable across devices, but the app never shows *who* captured a line or *when*,
nor what a correction actually changed. That information already exists (every
`stock_counts` row carries `updated_by_name_snapshot`/`updated_at`; every correction
already computes old→new at the moment it's applied) — it's just never surfaced in
the app itself, only in Audit Log and the Adjustments sheet.

## Scope

**In scope:** Stock Count only — the Adjust picker and the grid's detail view.

**Explicitly out of scope:** Received, Refill, Private, Manifold's own same-day
adjustment tools. Same underlying data shape applies to all of them (each already
knows operator/timestamp and old/new values at correction time), so this is expected
to extend cleanly later — deliberately deferred to prove the pattern on one section
first.

## Data model change

One new nullable column on `stock_counts`: `corrected_from numeric`. `null` for a
normal capture. Set to the pre-correction quantity only when a correction is applied.
A later normal recount (not a correction) rebuilds the row from scratch and naturally
clears it — this is what "most recent correction only" means in practice: the field
answers "was this line's current value the result of a manager's correction, and if
so, what was it before?", not a running history.

## Wiring

`corrApplyCountGroup()` (Stock Count's grouped correction-apply function) already
computes `oldVal`/`newVal` for each changed field, in memory, right before calling
`line.set(newVal)`. At that exact point, it also stamps `line.row._correctedFrom =
oldVal` — no extra network round-trip, no extra fetch. That flows through the
existing `_stockCountToSharedRow`/`_stockCountFromSharedRow` translation (both gain a
`corrected_from` mapping) exactly like every other field already does, and rides
along on the existing `_stockCountsUpsert` call `onApply` already makes.

`cOpenDetail()`'s pre-load of committed lines (used both by the grid's detail view
and indirectly by the correction picker, since both ultimately read from
`store.count`) currently only carries `brand`/`qty`/`note` forward from a committed
row — it will also carry `_operator`/`_time`/`_correctedFrom` so the byline has data
to render.

## Display

One shared helper, `_stockCountByline(l)`, returns the text to show under a brand
line:
- If `l._correctedFrom` is set: `"Adjusted by <operator> · <time>: <from> → <qty>"`
- Else if `l._operator`/`l._time` are set: `"Captured by <operator> · <time>"`
- Else (a fresh, uncommitted draft line): nothing shown

Used in two places:
- **Adjust picker** (`corrStepCountGroupEdit`): under each brand's input, in the same
  card as the value being corrected.
- **Grid detail view** (`cRenderDetail`'s brand cards): under each brand line,
  alongside the existing "already committed" tag.

Visible to any signed-in user viewing either screen — not gated behind a permission
check, matching a byline rather than a restricted audit record (the actual
tamper-proof audit trail remains Audit Log, unaffected and unchanged by this).

## Rollout

Small enough to implement directly with careful self-review (syntax check + live
browser verification), rather than the full separate-plan-and-subagent process used
for the pilot itself. Ships straight to `main`/production once verified, same as
tonight's other fixes.

## Success criteria

- Opening a committed Stock Count line (grid detail view or Adjust picker) shows who
  captured it and when.
- After a correction, that same line shows who corrected it, when, and the value it
  changed from → to, in both places.
- A later plain recount of that line reverts the display back to "Captured by..."
  (no stale correction text left over).
