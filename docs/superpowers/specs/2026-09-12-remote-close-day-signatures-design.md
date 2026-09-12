# Remote Close Day Signatures — Design

## Background

Close Day (`closeDay()` in `index.html`, reached from Count History's "Today" pane) requires two signatures before it will run — an Operator signature and a Manager signature — plus a separate Manager/Owner password re-authorization at the moment the "Close day" button is actually pressed.

Today, both signatures are drawn on **the same physical device**: `sigData = {sigOp:'', sigMgr:''}` is a plain in-memory JS object, populated by drawing on one of two `<canvas>` pads (`sigOp`/`sigMgr`) inside the History screen. Each pad unlocks with that person's own password (or an Owner override) via `unlockSig()`, but there is no way for the Operator and Manager to each sign from their own device — whoever isn't physically present has to hand their phone to the other person, or have their password borrowed on someone else's device.

This causes a real problem in daily use: the Operator and Manager are often not in the same place at Close Day time.

## Goal

Let the Operator and Manager each sign off from their own device, independently, at whatever time suits them. Each person's signing screen shows live whether the other side has already signed. The Operator's remote signature is real authorization — not a placeholder — so a Manager (or Owner) can open Close Day on their own device, see "Operator ✓ signed," sign their own box, and close the day without ever needing the Operator's device or password.

**Unchanged:** only `perm('closeday')` (Manager or Owner) can execute Close Day itself. Signing and authorizing-the-close stay the two separate concepts they already are today (`sigData`/`sigSignedBy` vs. `store._closeAuth`) — this design only changes *how a signature gets collected*, not who is allowed to press the final button.

## Architecture

### Data model

New table `day_close_signatures` — one row per (branch, date, role), replaced on re-sign:

```sql
CREATE TABLE IF NOT EXISTS day_close_signatures (
  branch text not null,
  date text not null,               -- 'YYYY-MM-DD', same convention as stock_counts.date
  role text not null check (role in ('Operator','Manager')),
  signer_name text not null,
  signer_level text not null,       -- the actual level of whoever signed (may be 'Owner' on an override)
  signature_png text not null,      -- data URL, same format sigData already produces
  signed_at timestamptz not null default now(),
  primary key (branch, date, role)
);
ALTER TABLE day_close_signatures ENABLE ROW LEVEL SECURITY;
CREATE POLICY day_close_signatures_select ON day_close_signatures FOR SELECT TO authenticated USING (true);
CREATE POLICY day_close_signatures_upsert ON day_close_signatures FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY day_close_signatures_update ON day_close_signatures FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
```

Signature stored as a plain base64 data URL column, not a Storage bucket — matches how the existing Close Day snapshot already embeds `signatures.op`/`signatures.mgr` as base64 (`_closeDaySend`'s `record.signatures`). RLS follows this project's established convention (`verified_stock_takes`, `stock_transfers`): broad access to any authenticated session, role enforcement happens client-side via `perm()`/`unlockSig()`'s own qualification checks, exactly as it already does for every other write in this app.

Primary key on `(branch, date, role)` means signing again is a plain upsert — no separate "clear" step needed server-side (the existing `sigClear()` UI can just clear the LOCAL canvas preview; the remote row is only overwritten when the person actually draws and submits a new signature).

### Signing flow

Stays inside Count History's existing sign-off block (`.sigBlock`, `#sigOp`/`#sigMgr` canvases) — no new tile, no new rollout gate. Operator and Manager both already reach History from the Home screen today.

`unlockSig(id)` keeps its exact current password-qualification logic untouched (`sigQualifies`, `_selfReauth`, `_borrowAuth`, Owner-can-sign-either-box override) — only what happens *after* a stroke is drawn changes: instead of `sigData[id]=cv.toDataURL(...)` being the end of the story, drawing now also upserts `{branch, date, role: (id==='sigOp'?'Operator':'Manager'), signer_name: sigSignedBy[id], signer_level, signature_png: sigData[id]}` to `day_close_signatures`. Signing from Device A or Device B runs the identical code path — there is nothing device-specific in the implementation; "remote" simply falls out of the signature now living in Supabase instead of a local variable.

### Live status

Every time the History "Today" pane renders (same trigger as today's existing `histBody`/badge refresh) and on an explicit refresh action, fetch both rows for `{branch, date: today}` from `day_close_signatures`. Render each box's status from the fetch result:

- No row for that role → "not yet signed" (current unlock-to-sign UI, unchanged)
- Row exists → "✓ signed by `<signer_name>` at `<HH:MM>`" (mirrors the existing Pending Overrides list's own "submitted by X at HH:MM" wording), with the signature image itself still viewable in the pad (drawn from the fetched `signature_png` on load, same as `sigData[id]` already does today when resuming a session per `_bootApp`'s comment at line ~8966).

Poll-on-open, not a live subscription — this app has no real-time channels anywhere (`manifold_live_rows`, `capture_live_rows`, `manifold_pending_overrides` are all poll-on-navigate), and this stays consistent with that.

### Close Day integration

`closeDay()`'s two hard gates:
```javascript
if(!sigData.sigOp){toast('Operator signature box must be signed first',true);return;}
if(!sigData.sigMgr){toast('Manager signature box must be signed first',true);return;}
```
switch from reading the local `sigData` object to reading the freshly-fetched remote rows (same one-shot refetch-then-recurse shape `closeDay()` already uses for `_fetchManifoldPendingOverrides()` and `_fetchUnapprovedTransfersTouching()` a few lines below — refetch `day_close_signatures` once, then re-enter `closeDay()` with a skip flag, so a stale local cache can never let a close proceed past a signature another device only just submitted).

`store._closeAuth` (the separate Manager/Owner password challenge for the act of pressing "Close day") and the final snapshot's `signatures:{op,mgr,signedByOp,signedByMgr}` fields are unchanged in shape — they're populated from the fetched remote rows instead of local `sigData`/`sigSignedBy`, but the DayClose record written to the sheet and the local `history` snapshot look identical to today's.

### Edge cases

- **Owner override** — Owner's password can still sign either box; the row's `signer_name` reads e.g. "Jan Botha (Owner override)", matching `unlockSig()`'s existing `signer` string construction exactly.
- **Re-signing** — drawing again after a signature already exists (e.g. correcting a mistake) upserts and replaces the row; `signed_at` moves forward. No history of prior signature attempts is kept (matches today's behavior — `sigClear()` already discards the old value outright).
- **Day already closed** — once `_closeDaySend()` has run, the `DayClose` record's own snapshot is the permanent record; `day_close_signatures` rows for that branch+date become irrelevant going forward (not deleted, just superseded — same as `stock_counts`/`capture_live_rows` rows aren't deleted after a close today).
- **Owner's "Clear Stock Take" tool** (the existing per-area admin reset, `storeKeyByArea`/`sheetTabByArea` in the clear-day admin flow) only ever clears the LOCAL cached record (`rec.store`, `rec._cleared`) — it has never deleted anything from the backend for any table (the backend only supports appending, never deleting, per this project's established limitation), and `day_close_signatures` follows that same rule: a "reopen" via this tool does not clear old signature rows. If a day is genuinely recounted and re-closed after this admin reset, an Operator/Manager who signs again simply upserts a fresh row (new `signed_at`), which is what the Close Day gate actually reads — the stale prior signature's data is silently superseded and never surfaces to the new close, so this needs no special handling.
- **Multi-branch** — a Manager who works both branches sees each branch's own signature status independently, scoped by `branch` exactly like every other per-branch table in this app.
- **Offline signing** — out of scope for this round. Every other remote-write feature in this app (`manifold_pending_overrides`, `stock_transfers`, `verified_stock_takes`) requires connectivity at the moment of the write; this follows the same convention. If the signer has no connection, the upsert fails and they see the existing generic Supabase-error toast — same as any other write in the app failing offline today.

## Out of scope for this round

- Changing who is allowed to sign (Operator/Manager/Owner-override qualification stays exactly as `unlockSig()` already enforces it).
- Changing what "Close Day" itself requires beyond signature sourcing (all existing hard gates — unresolved mismatches, unpaired Manifold swaps, Day Completeness, pending Manifold overrides, unapproved Transfers, Manifold balance — are untouched).
- A dedicated "sign here" tile/screen separate from Count History.
- Real-time push notification when the other party signs (poll-on-open only, per the app's existing convention).
