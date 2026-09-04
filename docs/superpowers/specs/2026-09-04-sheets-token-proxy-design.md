# Google Sheets Sync Token Exposure — Design

## Why this phase

`syncCfg()` (`index.html`) hardcodes the Google Apps Script webapp URL and its auth token
directly in client-side source: `{url:'https://script.google.com/macros/s/.../exec',
token:"GasSales2026"}`. Anyone who views-source the deployed page gets both. Since the token
is a single shared secret (not per-user), anyone with it could POST arbitrary rows into the
business's Google Sheet directly, bypassing the app entirely. This was the top finding of the
architecture review conducted 2026-09-03.

## Scope of this phase

**In scope:** move the real URL + token server-side, behind a new Supabase Edge Function that
the client calls instead. The client stops knowing the real Sheets endpoint or token at all.

**Explicitly out of scope (confirmed with the user):** fixing `syncPush()`'s existing
fire-and-forget blind spot (it currently uses `fetch(...,{mode:'no-cors'})`, meaning the
client can never actually see whether a Sheets write succeeded or failed — only a
network-level failure is caught). That's a real, separate improvement worth doing later, but
this phase preserves the EXACT current success/failure behavior for every capture type's sync,
just routed through a proxy — nothing about when a write is retried/queued changes.

## Current call sites (all confirmed by reading the code directly)

- `syncPush(type,rows)` (`index.html:3102`) — fire-and-forget, `mode:'no-cors'`, used by every
  capture type's commit path (Count, Refill, Private, Received, Manifold, Close Day, Seal
  Register, Adjustments) via `syncRows*` shaping functions.
- `syncFlush()` (`index.html:3113`) — retries the local `gs_sync_queue` using the identical
  fetch shape as `syncPush`.
- `apiPost(action,extra)` (`index.html:3122`) — real request/response (no `no-cors`), used by
  Faulty Cylinders' backend actions and `uploadPhotoSet()`'s photo-upload calls (which need an
  actual `{ok,url}` reply, not fire-and-forget).
- `syncCfg()` (`index.html:9795`) — the single hardcoded source both of the above read from.
- `setSyncCfg()`/the "Manage Users" sync-settings UI (`saveSyncCfg`/`loadSyncCfgUI`/`testSync`)
  write to a `localStorage` key that `syncCfg()` never actually reads back — already vestigial
  today, unrelated to this fix, left untouched.

The Apps Script backend itself already routes every request on a `type` field in the body
(confirmed via `apiPost`'s own comment: sending `{action:...}` got "unknown type: undefined";
`{type:...}` works) — `syncPush` and `apiPost` already speak the same wire protocol to the
same endpoint, just with different client-side handling of the response. This means one proxy
can serve both without needing to understand or re-model the payload shape at all.

## Design

**New Supabase Edge Function**, same pattern as the existing `verify-highrisk`/`manage-user`
functions (auth-checked via `getClaims()`, secrets read via `Deno.env.get()`, never exposed to
the client):

1. Client sends the SAME body it builds today, minus the real token (which it will no longer
   know) — `{type, rows}` for `syncPush`/`syncFlush` calls, `{type, caller, ...extra}` for
   `apiPost` calls — plus `callerToken` (their own Supabase session token, same convention
   `manage-user`/`verify-highrisk` already use for auth).
2. The function verifies the caller is genuinely signed in (`getClaims()`) — no granular
   permission check beyond that, since routine data sync is triggered by every role
   (Operator/Manager/Owner) as normal, expected part of using the app, not a privileged action
   like user management.
3. The function reads the REAL Apps Script URL and token from Supabase secrets
   (`Deno.env.get('SHEETS_WEBAPP_URL')`, `Deno.env.get('SHEETS_WEBAPP_TOKEN')`) — set once via
   the Supabase dashboard, never committed to the repo.
4. Forwards the client's body (with the real token injected, overriding anything the client
   sent) to the real Apps Script URL, and returns whatever it responds with.

**Client changes** (`index.html`):
- `syncCfg()` returns the new Edge Function's URL instead of the real Google URL; no real
  token exposed anywhere in client source.
- `syncPush`/`syncFlush`/`apiPost` drop `mode:'no-cors'` (no longer needed — this is now a
  same-origin-trust call to our own Edge Function, not a cross-origin call to Google, so CORS
  is fully controllable server-side) but their SUCCESS/FAILURE HANDLING LOGIC stays byte-for-
  byte the same as today (same `.then()`/`.catch()` shape, same queue-on-failure behavior) —
  only the URL and the removed `no-cors` mode change, per the confirmed minimal-scope decision.

## Deployment sequence (order matters — wrong order breaks every capture type's sync)

1. Write and commit the new Edge Function (`supabase/functions/sheets-sync/index.ts`).
2. **Before touching `index.html`**: the user sets the two secrets
   (`SHEETS_WEBAPP_URL`/`SHEETS_WEBAPP_TOKEN`) via the Supabase dashboard, and deploys the
   function (now auto-deploys on push, since GitHub↔Supabase was connected earlier this
   session) — confirmed reachable/working on its own, independently, before any client change
   goes live.
3. Only then update `index.html`'s `syncCfg()`/`syncPush()`/`syncFlush()`/`apiPost()` to point
   at the new function.
4. Live-verify every capture type still syncs correctly (this app is in active daily business
   use — a broken sync here is a real, immediate operational problem, not a cosmetic bug).

## Success criteria

- Viewing the deployed page's source no longer reveals the real Apps Script URL or token
  anywhere.
- Every existing sync behavior (queue-on-failure, retry, Faulty Cylinders' real responses,
  photo uploads) works identically to today — this phase is a transport change only, not a
  behavior change.
- The real secret is rotatable going forward (set once via Supabase secrets, never touches
  the repo or client bundle again) without needing a new `index.html` deploy.
