# Manifold Remote Override Approval — Design

## Why this phase

Live testing surfaced the real operational cost of the zero-trust override rule built
earlier today: when an overfilled (or otherwise out-of-range) cylinder reading is genuinely
correct, only a Manager or Owner PHYSICALLY PRESENT at the branch can authorize saving it —
they must type their own password on the device doing the capture. When no Manager or Owner
is on-site (a very normal situation for a small branch), there is no passthrough at all. The
operator is stuck.

This isn't a bug in the override logic itself — self-approval by the operator is correctly
never allowed, and that's the right call. The actual gap is narrower: authorization
currently has no remote path. This phase adds one, reusing the live cross-device Manifold
data pipeline just shipped, which is exactly the foundation this needs.

This also directly extends the earlier-queued "Manager-override screen redesign / real-time
notification" idea from this same session, and its Pending Overrides screen is deliberately
built as a first, narrow seed of the larger "Manager Action Hub" concept also raised earlier
— not the Hub itself, just built so the Hub can absorb it later without a rewrite.

## Scope of this phase

**In scope:**
- All three existing on-the-spot Manager/Owner authorization points — hard-ceiling overfill,
  flagged-band overfill, and declaring a used/partial cylinder — gain a remote path.
- At the point authorization is needed, the operator chooses: a Manager/Owner is physically
  present (today's exact existing flow, completely unchanged) OR submit for remote approval
  (new: the row saves immediately, flagged pending, operator continues working).
- A new standalone Manager/Owner-facing screen listing pending items across their branches,
  with Approve/Reject actions.
- Rejecting flags the row for the operator to recheck via the existing same-day Adjust tool
  — the Manager never types a replacement number themselves for a cylinder they didn't weigh.
- Close Day is blocked for a branch with any still-pending item, mirroring the exact
  mechanism already used for opening-count mismatches.

**Explicitly out of scope:** true push notifications (a Manager only sees pending items the
next time they open the app themselves, not an alert while the app is closed) — deferred;
the full "Manager Action Hub" (this phase builds one narrow queue, not a consolidated
everything-a-Manager-does screen); changing anything about the existing physical-presence
flow itself, which remains byte-for-byte the same option it is today.

## Decisions made during design

- **Next-open pending list, not true push notifications** — confirmed explicitly: solves the
  actual reported problem (remote approval, no password-sharing, no physical-presence
  requirement) without a new push-notification subsystem.
- **All three authorization points, not just hard-ceiling** — confirmed explicitly: same
  underlying problem applies to all three, one consistent mechanism covers them all.
- **Save immediately, resolve later — never blocks the operator** — confirmed explicitly.
  Close Day is the actual gate, not the individual capture flow, mirroring the existing
  opening-count-mismatch pattern rather than inventing a new blocking mechanism.
- **Rejection routes to operator recheck, not a Manager-entered replacement value** —
  confirmed explicitly: the Manager wasn't the one who weighed the cylinder, so they
  shouldn't be the one typing its corrected number either.
- **A new standalone screen, not a section bolted onto Count History** — confirmed
  explicitly, and deliberately framed as the first piece of the larger Action Hub idea
  rather than a one-off.

## Data model

New Supabase table, `manifold_pending_overrides`:

```
id              uuid primary key default gen_random_uuid()
branch          text not null
date            text not null
cyl             text not null
kind            text not null   -- 'HARD_CEILING' | 'FLAGGED_BAND' | 'USED_PARTIAL'
row_rid         text not null   -- the Manifold row's own existing _rid, links this pending
                                 -- entry back to the actual saved row
gas_left        numeric         -- snapshot of the reading, for display without re-deriving it
cap             numeric         -- snapshot of the nominal cap used at the time
submitted_by    uuid references profiles(id)
submitted_by_name_snapshot text
submitted_at    timestamptz default now()
status          text not null default 'PENDING'  -- 'PENDING' | 'APPROVED' | 'REJECTED'
resolved_by     uuid references profiles(id)
resolved_by_name_snapshot text
resolved_at     timestamptz
resolution_note text
```

RLS: SELECT open to any signed-in user (a Manager/Owner needs to read across branches they
have access to; an operator seeing their own pending items is also fine). INSERT open to any
signed-in user (matches every other write path's trust model in this app — who can actually
reach this point is already gated client-side). UPDATE restricted to
`profiles.level in ('Manager','Owner')` — the one place in this feature that genuinely needs
a database-level role check, since resolving is the security-relevant action itself.

The Manifold row being authorized also gains one new field, `_overrideStatus`
(`'PENDING'|'APPROVED'|'REJECTED'`), stamped at save time and updated when a Manager/Owner
resolves the corresponding `manifold_pending_overrides` entry — this is what the row-level
UI (Review, History, the same-day Adjust picker) actually reads to show its own status,
while the pending-overrides table is the Manager-facing worklist pointing at it.

## Capture-time flow

At each of the three existing trigger points, after the existing "is this reading actually
correct?" confirm (already built, unchanged — Cancel returns to recheck, OK proceeds), add
one more `confirm()`: *"Is a Manager or Owner here right now to authorise this? OK = they'll
enter their password now. Cancel = submit for remote approval and continue."*

- **OK** — today's exact existing flow, completely unchanged: `manifoldWeightOverride()`
  prompts for a physically-present Manager/Owner's password + reason, row saves once
  authorized.
- **Cancel** — the row saves immediately via the same `_addLineFinishAfterCap` path the
  approved case already uses, stamped `_overrideStatus:'PENDING'` and (for hard-ceiling
  specifically) also `_tareFlag`-style visibility markers reused where they already exist. A
  matching row is written to `manifold_pending_overrides`. The operator is never blocked —
  they continue to the next cylinder immediately.

## Pending Overrides screen

New standalone screen, reachable from the home/landing area for any Manager or Owner,
listing pending items across every branch they have access to (fetched live, same pattern as
everywhere else in this feature). Each item shows: branch, cylinder, kind, the reading vs.
the normal range, who submitted it, when. Two actions per item:

- **Approve** — requires the Manager/Owner's own password (the same `_selfReauth` signing
  convention already used for every other Manager/Owner action in this app, not a new
  mechanism) plus an optional note. Sets `status:'APPROVED'` on the pending-overrides row and
  `_overrideStatus:'APPROVED'` on the Manifold row.
- **Reject** — same password requirement, but the note is REQUIRED (mirrors every other
  reject/override-reason requirement already in this app). Sets `status:'REJECTED'` with the
  note, and `_overrideStatus:'REJECTED'` on the Manifold row.

## Rejection handling

A rejected row is never silently deleted or auto-corrected. Next time that slot is opened
for capture, the existing same-day Adjust tool surfaces it (a rejected item is functionally
identical to any other same-day correction target) with the Manager's rejection note visible
as context, so the operator can recheck and correct it themselves — the person who actually
weighs the cylinder is the one who corrects its number, never the remote Manager.

## Close Day gate

A branch cannot close while it has ANY `PENDING` item (`manifold_pending_overrides`,
`status==='PENDING'`, that branch/date) — mirroring the exact existing block-Close-Day
pattern already built for opening-count mismatches, not a new mechanism. Approved and
rejected items don't block Close Day (a rejected item still needs the operator's own
recheck/correction to actually happen, but that's a same-day Adjust action, not a Close Day
gate — consistent with every other same-day correction in this app never gating Close Day on
its own).

## Success criteria

- An operator with no Manager/Owner physically present can still save an out-of-range
  reading and keep working — never stuck.
- A Manager/Owner opening the app anywhere sees every pending item across their branches and
  can approve or reject it with their own password, never needing to share it or be on-site.
- A rejected item correctly surfaces to the operator via the existing same-day Adjust tool
  with the rejection reason visible, and the Manager is never the one entering a replacement
  weight for a cylinder they didn't personally handle.
- Close Day is correctly blocked for a branch with any still-pending item, and correctly
  unblocked the moment every pending item for that branch/day is resolved either way.
- The existing physical-presence override flow is completely unaffected — choosing "a
  Manager/Owner is here now" behaves identically to today, in every one of the three
  authorization points.
