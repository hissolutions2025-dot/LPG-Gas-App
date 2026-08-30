# Manifold Configurable Tolerances — Design

## Why this phase

The Manifold flow now has five separately-tuned numeric rules, all currently hardcoded the
same way for every branch: flagged-band (0.1kg), hard-ceiling (0.2kg), underfill (0.2kg,
Added-only), leftover-gas-on-removal (0.2kg, Removed-only), and tare-mismatch (zero-tolerance,
Closing/Removed). Different branches run different equipment and risk tolerance — a
one-size-fits-all number doesn't fit everyone. This phase makes those five rules editable per
branch from the existing Admin → Manifold Slots screen, alongside the slot-count control
already there.

## Scope of this phase

**In scope:**
- Every rule gets an on/off toggle, not just a number — a branch can turn a check off entirely
  rather than just loosening it.
- LPG and Propane get fully separate tolerance sets for flagged/ceiling/underfill/leftover — not
  shared.
- Tare-mismatch stays a single toggle, not split by gas type, and carries no kg value — a
  cylinder's tare is stamped on the cylinder itself and is a fixed fact, not something that
  tolerates a range. Zero-tolerance whenever on; simply skipped when off.
- Nominal capacity (48kg/45kg) stays hardcoded — not part of this phase.
- Editable from the same "Manifold Slots" Admin tab, same Owner-only access as slot count
  already has. No new permission.

**Explicitly out of scope:** any change to the permission system, `PERM_KEYS`, or Manage Users
screen. No change to `manifold_settings`'s existing Supabase RLS policy (already Owner-only,
already correct for this phase). No change to which checks exist or when they fire — this phase
only makes their numbers and on/off state configurable, not their behavior or trigger points.

## Decisions made during design

- **Every rule gets `{enabled, kg}`, except tare-mismatch which gets `{enabled}` only** —
  confirmed explicitly: tare tolerance doesn't make sense as a range since the correct value is
  printed on the cylinder.
- **LPG and Propane never share a tolerance set** — confirmed explicitly, applies to all four
  gas-type-specific rules.
- **Owner-only, matching the existing slot-count gate** — confirmed explicitly, after discussing
  and rejecting a new grantable permission for this phase. No `PERM_KEYS` entry, no Manage Users
  change, no RLS change — the existing Owner-only tab gate and Owner-only RLS UPDATE policy
  already cover this correctly with zero changes needed.

## Data model

One new JSONB column, `tolerances`, on the existing `manifold_settings` table (same table,
same row-per-branch shape slot count already uses):

```json
{
  "lpg": {
    "flagged":   {"enabled": true, "kg": 0.1},
    "ceiling":   {"enabled": true, "kg": 0.2},
    "underfill": {"enabled": true, "kg": 0.2},
    "leftover":  {"enabled": true, "kg": 0.2}
  },
  "propane": {
    "flagged":   {"enabled": true, "kg": 0.1},
    "ceiling":   {"enabled": true, "kg": 0.2},
    "underfill": {"enabled": true, "kg": 0.2},
    "leftover":  {"enabled": true, "kg": 0.2}
  },
  "tare_mismatch": {"enabled": true}
}
```

A branch with no `tolerances` value yet (column default `null`, or a row that predates this
feature) falls back to the values shown above — today's existing hardcoded behavior, unchanged.

## Admin UI

New "Weight tolerances" section on the Manifold Slots Admin tab, directly below the existing
slot-count field. Two columns, LPG and Propane, one row per rule (Flagged, Ceiling, Underfill,
Leftover on removal) — each row a toggle plus a kg input, input disabled when its toggle is off.
Below the two columns, one more row: Tare mismatch, toggle only, no input. A single Save applies
all of it at once, same pattern as slot count's own save.

## Runtime

Same live-fetch-with-fallback pattern slot count already uses: fetched once when Manifold
capture opens or the branch switches, cached for the session, falling back to the hardcoded
defaults above while loading or if the branch has never been configured. Every place that
currently reads a hardcoded tolerance number — the live in-screen warnings (`popCalc`) and the
actual save-time flag/audit-log gate (`_addLineFinish`) — reads from this same cached value, so
the live warning and the save-time decision can never disagree with each other.

## Success criteria

- Changing a branch's tolerance values and saving is reflected immediately in that branch's
  Manifold capture screens — both the live warning and the save-time flag.
- Turning a rule off for a branch means that check no longer fires at all for that branch, not
  just with a very loose number.
- LPG and Propane can be configured completely independently for a branch.
- A branch that has never touched this screen behaves exactly as it does today — no regression.
- Tare-mismatch has no kg field anywhere in the UI or data model — only a toggle.
