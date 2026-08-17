# LPG-Gas-App: Migration to Supabase — Design

## Why this migration

The app currently runs on a single HTML file (client-side JavaScript), a Google Apps
Script backend, and Google Sheets as the database. That combination got the app built
fast and cheaply, and the business logic built on top of it (Stock Count, Refill,
Private Refill, Stock Received, Manifold, Faulty Cylinders, Residual Gas, Suppliers,
day-close reconciliation) is genuinely solid — hardened over a long series of real bugs
found and fixed against live use.

But three requirements the business now needs are not achievable on the current
foundation, not as a small tweak but as a structural gap:

1. **User accounts, passwords, and permissions live only in `localStorage` on whichever
   phone they were created on** (`loadUsers()`/`saveUsers()`, confirmed in code — the
   app's own login screen even says "Demo only — passwords are stored on this device in
   plain text"). A Manager changing someone's permissions on their phone does not affect
   any other phone. If a phone is lost, that person's account is gone — there is no
   "log in from another phone."
2. **There is no real per-user authorization at the data layer.** Every permission
   check ("can this person close a day / adjust a count / manage suppliers") lives only
   in client-side JavaScript, which anyone can read via browser dev tools. The backend's
   only access control is a single shared secret token embedded in that same public
   JavaScript — anyone with that string can write directly to the sheet, bypassing every
   permission check the app has.
3. **Google Sheets is not a real database**, and a large share of this session's hardest
   bugs (duplicate entries on re-commit, drafts silently lost, a same-day correction
   tool needing a hand-rolled row-id-and-column-lock system just to update one existing
   row) trace directly back to Sheets/Apps Script only supporting appending new rows,
   never updating one in place.

The business also wants to keep building on this foundation ("one leg of a larger app"),
which makes fixing the foundation now, rather than later, the more valuable path.

## Constraints this design is built around

- **The owner (Freddie) is a true beginner** with code. For this phase, the working
  pattern is: I (Claude) design and build, giving clear plans/instructions to follow;
  hands-on coding lessons are explicitly deferred until the app is functionally migrated.
- **No developer or agency** — this is done through direct collaboration with Claude.
- **Small monthly budget is acceptable** (~R200–500/month) once free-tier limits are
  outgrown.
- **No downtime.** The current app stays in daily use at both branches throughout the
  migration. This must be a gradual, incremental replacement, not a rewrite-and-cutover.
- **Aesthetics/visual polish is explicitly out of scope until the backend migration and
  full testing are complete.** The current look is acknowledged as "raw" by design intent
  (functionality first) and is parked, not forgotten — see "Deferred, not scheduled"
  below.

## Platform choice: Supabase

Three options were considered:

- **Supabase** (chosen) — bundles a real relational database (Postgres), built-in user
  authentication, and Row Level Security (permission rules enforced by the database
  itself, not just hidden in app code) into one coherent, well-documented platform.
  Postgres/SQL is a widely transferable skill. Free tier comfortably covers this
  business's real scale; paid tier fits well inside the stated budget.
- **Firebase** — same bundled shape (auth + database + hosting), but its database
  (Firestore) is document/NoSQL-based with its own bespoke security-rules language,
  a less natural fit for relational data like invoices/deliveries/counts, and a less
  transferable skill than SQL.
- **Fully custom** (own server + separate database + separate auth service) — the most
  flexible long-term, but the most moving parts to hold in mind at once for someone
  starting from zero. Positioned as something to possibly grow into later, not a
  starting point.

**Future Xero/Sage integration was raised as a deciding factor and investigated
specifically**: none of the three platforms has a built-in "connect Xero" button — some
integration code is required regardless of platform. Supabase's advantage here is
**Database Webhooks** — a no-code, dashboard-configurable feature that can notify an
external URL whenever data changes. Paired with a no-code tool like Zapier or Make (which
have ready-made Xero connectors), this gives a realistic path to that integration without
writing OAuth/API code personally. Firebase can do the same shape of thing but requires
writing a Cloud Function to relay the webhook — no no-code equivalent. This reinforced
the Supabase choice rather than changing it.

## Migration philosophy: gradual, phase by phase

Each phase is independently useful on its own, not just a step toward a distant finish
line, and each is built and proven on a separate copy of the app before any real cutover
— the live app in daily use is never put at risk mid-phase.

### Phase 1 — Real accounts

**Scope:** only the login screen and the "Manage Users" screen change. Every capture
workflow (Count, Refill, Received, Manifold, etc.) is untouched in this phase and keeps
talking to Google Sheets exactly as today. This is deliberate: smallest possible blast
radius, and it fixes the single most urgent problem (centralized, recoverable accounts)
first, before anything else changes.

**Login experience decision (resolved):** keep the existing "pick your name from a list,
type a password" feel — no one needs to type an email address on a shared field phone.
Under the hood, each person gets a hidden, internally-generated email address that
Supabase's auth system uses, invisible to the user.

**Migrating existing accounts:** since accounts currently only exist per-device, each
real person (Owner, Managers, Operators) is created fresh, once, in the new system. This
happens through an actual rebuilt "Manage Users" screen (not a throwaway script), since
that screen is needed going forward regardless.

**Checkpoint before this phase starts building: revise the permission list.** Given
everything added to the app this session (the same-day Adjustment tool, RowId tracking,
etc.), the existing permission set is due for a review. The right moment to do that is
right before Phase 1 is built — not before (no reason to block on it now) and not after
(revising it once it's already encoded in Supabase's permission rules means redoing that
work). This is an explicit step in the eventual implementation plan, not an afterthought.

**Side benefit:** Supabase keeps users securely logged in across app restarts natively,
which improves on today's session behavior, not just matches it.

**Cost:** effectively free at this phase — Supabase's free tier covers far more monthly
active users than this business will ever have.

### Phase 2 — Real permissions (Row Level Security)

**What changes:** permission enforcement moves from "hidden in client-side JavaScript"
to "enforced by the database itself" (Row Level Security / RLS) — a fundamentally
stronger guarantee, since it can't be bypassed by reading page source or calling the
backend directly.

**What does NOT change:** the actual permission *model* (Operator/Manager/Owner plus the
existing granular permissions — capture, edit, close day, adjust, manage suppliers, etc.,
as revised in the Phase 1 checkpoint above) is ported as-is, not redesigned. UI-level
permission checks (hiding buttons someone can't use) are kept too — RLS is the security
backstop, not a replacement for a good user experience.

**Where this gets proven first:** on the Phase 1 "Manage Users" screen itself (e.g. "only
Owners can change someone else's role"). Proving the pattern there means Phase 3 is
repeating an already-proven approach for each new table, not inventing it from scratch
each time.

### Phase 3 — Move the capture data

**The core shift:** each capture type (Counts, Refills, Private, Received, Manifold,
Faulty, Residual, Suppliers) currently maps to an append-only Google Sheets tab. In a
real database, updating one specific row is an ordinary operation — no workaround
needed. A meaningful share of this session's hardest-won fixes (the RowId stamping
system, the protected-column setup, the whole "adjustRow" backend action) exist purely
to work around Sheets' append-only nature and become unnecessary in this form once this
phase is done. The underlying lessons (what needs disambiguating, how a correction
screen should be laid out) carry forward directly into the new implementation; the
specific workaround machinery does not need to.

**Migration order — one capture type at a time:**
1. **Refill first** — simplest structure (no toggle/stage complexity like Manifold, no
   two-sided balance check like Received), cheapest place to prove the whole pattern
   (capture screen → real table → permission rules → review screen, end to end).
2. The remaining types follow, each repeating the proven pattern.
3. **Stock Count last** — the most complex existing logic (previous-day-close
   comparison, lock-after-tries anti-fraud behavior), tackled once the pattern has been
   proven several times over on simpler cases.

**Recon/reporting sheets are explicitly handled, not an afterthought.** Daily Recon
HB/KM and the live running-summary tables are Google Sheets formulas reading the raw
data tabs directly. Throughout Phase 3, a copy of the data continues to be written to
Sheets alongside the new database, so these reports keep working completely unchanged
while the underlying source of truth moves. This is not the long-term state — see Phase
4 — but it means nothing about daily reporting breaks mid-migration.

**Photos stay on Google Drive for now** — not changing two things at once; revisited
later only if it becomes a real pain point.

**Rollout per capture type:** each type gets its own real beta period — built, tested
with real data, tried for real by the Owner/Managers — before the Sheets-based version
for that specific type is retired. Five small, low-risk cutovers, not one big one.

### Phase 4 — Decide what Google Sheets becomes

Once Phase 3 is complete, Sheets stops being written to as part of any data *entry* or
*correction* — that always goes through the app from this point on, enforced by Phase 2's
permission rules. What's undecided, and deliberately left as an open decision for when
this point is actually reached rather than forced now, is what Sheets becomes for
**reporting/viewing**:
- Keep it as a live, read-only reporting view fed by the new database (useful if the
  existing recon-sheet format is valued for its own sake, e.g. for an accountant), or
- Retire it entirely once native in-app reporting is judged a full replacement.

Either way, manually editing cells in Sheets as part of daily operations stops being how
the business operates — including Suppliers, the Faulty Cylinder register, and Seal
tracking, none of which need hand-editing in a sheet going forward.

## Deferred, not scheduled

These were explicitly raised and discussed, and are deliberately not part of this
migration's scope:

- **Aesthetics/visual redesign** — parked until the backend migration and full testing
  are complete, per explicit instruction. When it happens, it follows the same
  demo-first approach already established this session (an interactive mockup built and
  reviewed before any real app code changes).
- **Xero/Sage integration** — a real "one day" goal, investigated enough to confirm it
  doesn't change the platform choice (see above), not scheduled as part of this
  migration.
- **A frontend framework rewrite** (e.g. moving off the single large HTML file to
  something like React) — only worth doing if the current single-file approach becomes
  a genuine maintainability problem. Not decided, not scheduled. Worth noting: if this
  ever happens, it's the natural moment to also do a deeper visual redesign at the same
  time, since a framework rewrite touches every screen anyway — a reason to not do a
  heavy structural redesign immediately before a possible framework rewrite, though a
  lighter polish pass sooner is not blocked by this.
- **Hands-on coding lessons for the Owner** — explicitly deferred until the app is
  functionally migrated and stable; the current phase is plan-and-instructions-driven.

## Success criteria

- A Manager or Owner can change a user's permissions from any device, and it takes
  effect everywhere immediately — not just on the device where the change was made.
- If a phone is lost or stolen, the affected user's account still exists and can be
  logged into from a different device.
- Permission rules are enforced by the database, not just hidden by the app's UI — a
  request that shouldn't be allowed is rejected regardless of how it's made.
- No downtime or disruption to daily operations at either branch throughout the
  migration.
- Daily reconciliation reporting (Daily Recon HB/KM, running summaries) continues to
  work throughout the migration, with an explicit, deliberate decision made about its
  long-term form once Phase 3 is complete — not an accidental breakage.
