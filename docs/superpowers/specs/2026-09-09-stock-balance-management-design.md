# Stock Balance Management (Verified Counts, Branch Transfers, Date-Range Balance) — Design

## Background

Daily stock balancing already works, and the app already tolerates small day-to-day
discrepancies (captured with a reason, not blocked). That's correct behaviour for a
single day — but uncorrected daily noise compounds into real, invisible loss over a
week/month/quarter/year, and the app currently has no way to see or check for that.

The only trusted counter-check against blind spots today is the physical weekly/monthly
stock take done by someone with nothing to gain from the numbers being wrong (an
"Auditor," counting jointly with the Operator, both signing off). That process happens
today, but nothing about it reaches the app — its result never gets compared against
what the app's own daily-captured data says stock should be.

Separately, cylinders already move between Helderberg and Kleinmond informally, with no
capture in the app at all. Any date-range balance would misread every transfer as a
phantom sale at the sending branch and a phantom unexplained surplus at the receiving
branch unless transfers are captured and factored into the same math from day one.

## Goal

Give Managers/Owners a way to balance stock over **any date range they pick** —
week, month, quarter, year, or custom — using all the detail the app already captures
daily, PLUS two new trusted inputs that don't exist in the app yet:

1. **Verified Stock Takes** — joint Auditor+Operator counts, full detail, dual-signed,
   triggerable on any date (not locked to a fixed weekly/monthly schedule).
2. **Branch Transfers** — cylinder movements between Helderberg and Kleinmond, with
   dispatch/receipt/approval sign-off, so they net out of the balance correctly instead
   of looking like sales or surpluses.

## Scope

This spec covers all three pieces together, because the range balance's math needs
transfers and verified checkpoints designed in from the start (see "Why one spec"
below). They ship as **three separate implementation plans/phases** so each can be
built, tested, and deployed independently:

- **Phase 1** — Auditor role + Verified Stock Take capture
- **Phase 2** — Branch Transfers (dispatch → receipt → manager approval)
- **Phase 3** — Date-Range Stock Balance report (ties Phase 1 + 2 + existing daily data
  together)

Out of scope for this round: replacing the daily Operator Opening/Closing flow
(confirmed: Verified Stock Takes run *alongside* the normal daily count, never instead
of it); transfers of Manifold installations themselves (only cylinder stock moves
between branches — the manifold rig itself does not).

(Solo/independent counts — originally scoped out, now back in as a supported mode
alongside joint counts; see Phase 1 below.)

## Why one spec, three plans

The Date-Range Balance report (Phase 3) computes an "estimated sold" figure the same
way the existing daily report does:

```
Opening + Received + Refilled − Closing − Faulty = Estimated Sold
```

A branch transfer is neither a sale nor a delivery from a supplier — without a
dedicated line for it, a transfer-out would inflate "estimated sold" at the sending
branch, and a transfer-in would make the receiving branch's Closing count look like an
unexplained surplus relative to what it received/sold. Verified checkpoints similarly
only mean anything if the range report knows how to slot them into the same timeline
as daily data. Both need to be accounted for in the aggregation formula from the start,
even though the three pieces are built and shipped independently.

## Data Model

All three new pieces get their own tables — nothing about the existing
`stock_counts` / `manifold_live_rows` / `capture_live_rows` / `day_closes` tables or
their read/write code changes. This keeps regression risk at zero for the daily flow
that's already live in production.

### `verified_stock_takes` (new table)

One row per joint Auditor+Operator count.

| column | type | notes |
|---|---|---|
| `id` | uuid, pk | |
| `branch` | text, not null | |
| `date` | text, not null | `YYYY-MM-DD`, same convention as `stock_counts.date` |
| `count` | jsonb, not null | array of `{size, brand, state, qty, note}` — same per-line shape as a `store.count` row, minus `countType` (the table itself is the type; there's no Opening/Closing distinction for a verified take, it's one point-in-time count) |
| `manifold` | jsonb, not null | array of `{cyl, brand, gasType, scale, tare, gasLeft, cylState, notes}` — same per-slot shape as a `store.manifold` row, minus `stage` (one point-in-time weigh-in, not a sequence) |
| `mode` | text, not null | `'joint'` or `'solo'` — see Phase 1 |
| `auditor_id` | uuid, references `profiles(id)` | |
| `auditor_name_snapshot` | text | |
| `auditor_sig` | text | data URL, same signature-pad format `sigData.sigOp` already uses |
| `operator_id` | uuid, references `profiles(id)`, nullable | null when `mode='solo'` — no operator involved in a solo count |
| `operator_name_snapshot` | text, nullable | |
| `operator_sig` | text, nullable | data URL |
| `committed_at` | timestamptz, default now() | |

RLS: same permissive pattern as `stock_counts` — `select`/`insert` for any authenticated
user (role gating is enforced client-side via `userPerms()`/tile visibility, matching
every other capture type in this app today).

### `stock_transfers` (new table)

One row per transfer.

| column | type | notes |
|---|---|---|
| `id` | uuid, pk | |
| `from_branch` | text, not null | |
| `to_branch` | text, not null | |
| `items` | jsonb, not null | array of `{size, brand, state, qtyDispatched, qtyReceived, note}` — `qtyReceived` starts null, filled in at receipt; a receipt shortfall (`qtyReceived < qtyDispatched`) is allowed and logged with a reason on that line, same tolerance-with-audit-trail convention as Stock Received today |
| `status` | text, not null | `'pending_receipt'` → `'received'` → `'approved'` (or `'cancelled'`) |
| `dispatch_operator_id` / `_name_snapshot` / `_sig` | | signed at dispatch |
| `dispatch_at` | timestamptz | |
| `receive_operator_id` / `_name_snapshot` / `_sig` | | signed at receipt |
| `receive_at` | timestamptz, nullable | |
| `manager_id` / `_name_snapshot` / `_sig` | | signed at approval |
| `approved_at` | timestamptz, nullable | |
| `note` | text | |

RLS: same permissive pattern as above.

### Auditor role

New value in the existing role system (`Operator` / `Manager` / `Owner` today, gains
`Auditor`). An Auditor:
- Sees exactly one tile on login: **Verified Stock Take**. Every other tile (Refill,
  Private, Received, Manifold, History, Admin, etc.) is hidden the same way
  role-gated tiles already are today (`perm(...)` checks in `renderLandingHeader`).
- Cannot touch `stock_counts`, `manifold_live_rows`, `capture_live_rows`, or any
  existing capture flow — enforced simply by having nothing else to navigate to, not
  by new RLS (consistent with how this app enforces role scope everywhere else: UI
  gating, not per-role database policies).
- Added to Manage Users' role dropdown and `userPerms()`'s role table alongside the
  existing three roles.

## Phase 1 — Auditor role + Verified Stock Take

**New screen**, reusing existing components rather than rebuilding them:
- The count grid: same component `openCount`/`cRenderGrid` already render for the
  daily Stock Count screen — full size × brand × Full/Empty grid, same input
  behaviour.
- The Manifold weigh-in: same component the daily Manifold capture screen uses — same
  slot list, same scale/tare/gas-left fields.
- Signing: reuses the existing signature-pad component (`initSigPad`, same canvas +
  clear/lock pattern Day Close already uses) — one pad for the Auditor, one for the
  on-duty Operator. Commit is blocked until both are signed, same hard gate Day Close
  already enforces for Operator+Manager.

**Flow:**
1. Auditor logs in → lands directly on Verified Stock Take (only tile available).
2. Picks branch + date (defaults to today; any date is explicitly allowed, per your
   "we want the option for any date as well").
3. Picks **mode**:
   - **Joint** — Auditor and the on-duty Operator count together, one agreed number.
     Both sign before commit (same hard gate Day Close already enforces).
   - **Solo** — Auditor counts alone, Operator not involved at all. Only the
     Auditor signs. This is the original "independent, no stake in the outcome"
     check — the count is never shown the Operator's own recorded figures while
     counting (same blindness guarantee the daily Opening count already has against
     the previous Closing).
4. Counts the full grid + weighs the Manifold, same as a normal daily count.
5. One atomic insert into `verified_stock_takes` (`operator_*` columns null for
   solo). Nothing is written to any existing table.
6. Immediate feedback: a toast comparing this Verified count's totals (per size, and
   Manifold total) against that same date's Operator-recorded Closing count, if one
   exists yet for that date — surfaces same-day drift immediately rather than only
   showing up later in a Phase 3 range report. (If Closing hasn't been captured yet
   for that date, the toast says so instead of comparing against nothing.) For a
   solo take this comparison is the whole point — it's the one mode genuinely
   checking the Operator's own numbers against an outside count, rather than
   producing them together.

**Also syncs to Google Sheets**, same dual-write convention every other capture type in
this app already follows (`syncPush` alongside the Supabase write) — new `VerifiedTakes`
tab, columns mirroring the table above (flattened: one row per count line and one
per manifold slot, same pattern `syncRowsCount`/`syncRowsManifold` already use).

## Phase 2 — Branch Transfers

**New tile**, visible to Operators at both branches (this is a normal operational
action, not manager-only — the manager step is an approval gate, not a restriction on
who can initiate).

**Flow:**
1. **Dispatch** — sending-branch Operator opens "Stock Transfer," picks destination
   branch, adds line items (size/brand/state/qty — same picker pattern Stock Received
   uses), optionally a note/photo, signs. Row inserted with `status='pending_receipt'`.
2. **Receipt** — receiving-branch Operator sees a "Transfers Awaiting Receipt" list
   (badge on their Home tile, same convention as other pending-item badges already in
   the app). Opens one, confirms actual quantity received per line (pre-filled with
   the dispatched quantity, editable) — a shortfall is allowed, requires a reason,
   logged on that line, does not block. Signs. `status='received'`.
3. **Manager approval** — a Manager/Owner at either branch sees pending-approval
   transfers (same badge convention) and signs off, closing the loop. `status='approved'`.
   **Gate:** if a transfer touched a branch that day and hasn't reached `'approved'`
   yet, that branch's Close Day is blocked with the same hard-stop pattern the
   existing unpaired-manifold-swap check already uses ("go resolve it first").

**Also syncs to Google Sheets** — new `Transfers` tab, same dual-write convention,
one row per line item with both branches, all three signers, and status.

**Balance math impact:** a `qtyReceived` transfer counts as **stock-in** at
`to_branch` and **stock-out** at `from_branch` on their respective dates — factored
into Phase 3's aggregation as its own line, separate from Received (supplier
deliveries) and separate from Estimated Sold, so neither branch's numbers get
distorted by a transfer.

## Phase 3 — Date-Range Stock Balance

**New Manager/Owner-only screen.** Branch picker + date range picker (presets: This
Week / This Month / This Quarter / This Year / Custom start–end via calendar).

**Aggregation**, generalizing the exact math `buildCountDocAsync` already does for one
day, across every day in the picked range:

```
Opening (range start)
+ Received (summed across range)
+ Refilled (summed across range)
+ Transfers In (summed across range)
− Transfers Out (summed across range)
− Faulty (summed across range)
= Estimated Sold
vs.
Closing (range end)
```

- **Opening (range start)** = the Operator's Opening count on the range's first day
  (falls back to the previous day's Closing via the existing `day_closes` lookup if
  the range starts mid-stream).
- **Closing (range end)** = the Operator's Closing count on the range's last day.
- Manifold gets the same treatment: Opening (range start) vs Closing (range end) vs
  Diff, in the same compressed one-table-with-totals shape already shipped for the
  single-day report.
- **Verified checkpoints** (Phase 1) that fall inside the picked range are shown as
  inline markers on the timeline — each one showing "App's own running figure as of
  this date" vs "Verified count" vs the difference — so drift is pinned to a specific
  window, not buried in one range-wide total.

**Data source:** built client-side by fetching each day's `day_closes` snapshot plus
each day's `capture_live_rows`/`manifold_live_rows`/`stock_counts` rows across the
range and summing in the browser — same approach the single-day report already uses,
just looped across more days. Acceptable for week/month/quarter ranges; if a full-year
roll-up turns out to be slow once there's a year of real data, moving the summing into
a Postgres function/view is a clean later optimization, not a redesign (flagged in the
brainstorming session, deliberately deferred).

## Error Handling / Edge Cases

- **No Verified checkpoint in range** — the range report still works, it just has no
  inline markers; not an error state.
- **Verified take on a date with no Operator Closing yet** — the same-day comparison
  toast (Phase 1) explicitly says "nothing to compare yet" rather than treating a
  missing Closing as zero (same non-negotiable convention the existing prev-close
  comparison already follows, to avoid ever flagging a false 100% "loss").
  Phase 3's range report likewise never invents a phantom Opening/Closing — falls back
  to "no baseline" messaging exactly like the existing single-day report does today.
- **Transfer shortfall** — never blocks receipt; always requires and logs a reason,
  same as every other tolerance-with-reason pattern in this app.
- **Transfer stuck pending approval across a day boundary** — blocks Close Day for
  whichever branch(es) it touched, with a clear message pointing at the Transfers
  screen (mirrors the existing unpaired-manifold-swap block's wording style).
- **Auditor account used for anything but Verified Stock Take** — prevented by having
  no other tile to navigate to; no separate enforcement needed.

## Testing

- Node syntax check (`node --check`) after every edit, same convention used all
  session.
- Each phase verified against real Supabase data pulled via `supabase db query
  --linked`, fed through a stubbed `sb.from`/`apiPost` harness in the browser preview,
  same technique used throughout this session — before any deploy.
- Phase 3's range math specifically verified against a known multi-day stretch of real
  data (reconstructing the expected Estimated Sold / Manifold Diff by hand from the
  underlying daily rows, then confirming the aggregator produces the same numbers).
- Transfer shortfall and Verified-vs-Closing "no baseline yet" paths both explicitly
  tested, not just the happy path — both are places this app has previously shipped a
  bug by defaulting a missing baseline to zero.

## Rollout

**Build order: Phase 2 (Transfers) first.** The three phases are independent of each
other to build, but not equally urgent. Branch transfers are already happening
informally today, uncaptured — every day that passes before Transfers ships is another
day of movements that will permanently corrupt any date range Phase 3 later tries to
balance (no way to reconstruct them after the fact). Verified Takes and the Balance
report don't have that same cost of delay — shipping them a week later just means one
fewer checkpoint or no report yet, not silently-lost data. So:

1. **Phase 2** (Branch Transfers) — ships first, stops the data gap from growing.
2. **Phase 1** (Auditor + Verified Stock Take) — no dependency on Phase 2, ships and
   is useful standalone (same-day comparison toast already delivers value).
3. **Phase 3** (Date-Range Balance) — depends on both; the aggregation formula needs
   Transfers and Verified Takes to already exist and have real data flowing in before
   it's meaningfully testable end-to-end.

### Build-time safety: Owner-only until each phase is verified live

Today's session found a real bug where a deploy disrupted an Operator's live capture
mid-shift (the service-worker auto-reload issue, fixed separately). Building three new
screens/flows over several deploys carries the same risk if any of it is visible to
staff before it's proven solid. So during development:

- Every new tile/screen from all three phases (Verified Stock Take, Stock Transfer,
  Date-Range Balance) is gated to **`role==='Owner'` only**, regardless of that
  phase's eventual target role — Owner can see and exercise the full Transfer
  dispatch→receipt→approval cycle, the full Auditor joint/solo count flow, and the
  Balance report, all from their own login, without needing a real Auditor account or
  a second device to test with.
- Every existing Operator/Manager tile and flow is completely unchanged and untouched
  by any of this — staff see zero difference in the app during the whole build.
- Once a phase is verified working end-to-end (real data, no regressions), its
  permission gate is relaxed to its real target audience in its own small follow-up
  change: Verified Stock Take opens up to the real Auditor role, Stock Transfer opens
  up to Operators at both branches, Date-Range Balance stays Manager/Owner (already
  its intended audience).
