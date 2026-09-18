# Photo Upload Queue & Rapid-Capture Design

## Problem

On 2026-09-18, Coenie Hatting (Helderberg) repeatedly could not commit Private Refill captures. Two root causes were found and fixed same-day:

1. The Manifold-Opening prerequisite gate read stale/empty local `store.manifold` on a freshly-logged-in session instead of live data (fixed: both gates now fetch fresh manifold data first).
2. `_capCommitReal()` had no `catch` block at all — any error during commit (most likely a stalled photo upload, since `apiPost`'s underlying `fetch` has no timeout) failed completely silently. No toast, no message, the screen just never advanced. (Fixed short-term: added a catch block with a clear error toast, and a 25s timeout on each photo upload.)

Those two fixes stop the *silent* failure and the *false-block* failure. They don't fix the underlying fragility: **photo upload is still a blocking step of every commit**, awaited one photo at a time inside the same `try` block that commits the actual data. On a weak connection, an operator can still lose real time — and in the worst case, if they log out or the tab dies while an upload is stuck, uncommitted captured data (weights, quantities, notes, and the photos themselves) can be lost, forcing a full recapture. This is the "double work" the user wants eliminated for good, not just made less silent.

Separately, every capture screen currently calls `goHome()` after a successful commit, sending the operator back to the tile grid even when they have five more of the same item to capture — forcing an unnecessary Back-then-retap cycle for every single line.

## Goals

1. **Never let a photo upload block or risk losing captured data.** Committing the numeric/text data must never wait on network photo upload.
2. **Never force a redo.** A stalled or failed photo upload must not require recapturing anything — weights, quantities, notes, or the photo itself.
3. **Let an operator capture repeatedly without leaving the screen**, in the sections where that's how the work actually happens (one cylinder/delivery at a time), while leaving alone the sections where a single commit already represents the whole task.
4. **Keep the operator informed without extra taps** — a visible sense of "is my work landing" and "are my photos going up" without leaving the capture screen.
5. **Work the same way on a phone, tablet, laptop, or desktop.**

## Scope

**Photo upload queue** (decoupled from commit, background auto-retry, manual add/retry within the 48-hour correction window): Manifold, Refill, Private Refill, Received, Residual Gas.

**Stay-on-screen after commit** (no `goHome()`, form resets immediately for the next item): Manifold, Refill, Private Refill, Received.

Out of scope, deliberately unchanged:
- Faulty Cylinders, Residual Gas, Stock Transfer dispatch already stay on screen after submit — already correct, no work needed.
- Stock Count and Verified Stock Take correctly `goHome()` — each commit is the whole day's task in one action, there is no "next item" to stay ready for.
- Real Daily Sales / Estimated Stock Sales reporting, Net Cylinder Exchange, and every other report-side feature built earlier this session are untouched by this work.

## Architecture

### Today's flow (all 5 in-scope sections)

```
tap Commit
  → upload each photo, one at a time, AWAITED (no timeout until today's stopgap fix; 25s each now)
  → push data to Supabase / Sheets proxy
  → mark row committed
  → goHome() [Manifold/Refill/Private/Received only; Residual already stays]
```

Every step from "upload each photo" onward is inside one `try` block. If the upload step stalls or throws, nothing after it runs — data does not commit, in most cases the row still exists in local `store[capType]` (not literally deleted), but the operator has no confirmation of that and no way to distinguish it from data loss.

### New flow

```
tap Commit
  → push data to Supabase / Sheets proxy immediately (photos NOT awaited here)
  → mark row committed
  → for each photo on this row: enqueue {rowId, capType, branch, date, category, dataUri} into
    a local photo-upload queue (localStorage, same shape/pattern as the existing Close Day
    pending-sync queue - gs_photo_upload_queue)
  → screen stays / resets for the next item (sections in "stay-on-screen" scope) or proceeds
    as today (Residual Gas, unchanged navigation)
```

A separate, always-running queue processor:
- Retries on `window.addEventListener('online', ...)` (same trigger the existing Close Day queue uses).
- Retries periodically while the app is open (short interval, e.g. every 30-60s, only while queue is non-empty - no polling once it's empty).
- Retries once on login/app open.
- On each successful upload, writes the resulting photo link back onto the **already-committed** row using the same same-day correction / 48-hour correction mechanism already built (`adjustSheetRow`-style row-in-place update) - no new "attach a link after the fact" plumbing invented, this reuses what exists.
- A photo that never uploads simply stays queued indefinitely. It never blocks anything, never expires silently, never forces a redo. It surfaces via the pending badge (below) until it either succeeds or is manually retried/cleared.

This is the same "local queue + background retry + reuse the existing correction path to patch in the result" shape the app already uses for Close Day going offline - not a new pattern for this codebase, an extension of one already proven here.

### Manual "Add / retry photo"

On each in-scope section's Review/History row, within the existing 48-hour correction window: a button that lets an operator attach or replace a photo for an already-committed row, whether because the automatic queue hasn't caught up yet or because none was captured at commit time at all. Goes through the same resize (`_resizeImageForCapture`) → queue → background-upload → correction-write-back path as every other photo in this design; there is no separate/simpler code path for "added later."

### Pending badge

A small "⏳ N photo(s) waiting to upload" indicator on Home/History, same visual and update pattern as the existing Close Day pending-sync badge (`_updateCloseDayPendingBadge`), reflecting the photo queue's current length across all sections/branches this device knows about.

### Dual counter (stay-on-screen sections only)

Visible on the capture screen itself, updates with every commit in that session:

```
5 committed today · 2 photos uploading
```

"Committed today" = count of this section's rows committed today for this branch (already-known data, no new tracking needed - same source Review/History already reads). "Photos uploading" = count of this branch/section's entries still in the photo queue.

## Cross-device compatibility

The photo input already uses a plain `<input type="file" accept="image/*" capture="environment">`. `capture` is a hint mobile browsers may honor (opens camera-first, but every mobile browser tested still offers "choose from library" alongside it); desktop/laptop/PC browsers ignore it entirely and present their normal file picker, letting a desktop user select an existing image file. `_resizeImageForCapture` (canvas + `createImageBitmap`) operates on the resulting `File` object identically regardless of source device.

Requirement for this design: the new "Add/retry photo" button (manual, on Review/History rows) uses this exact same `<input type="file" accept="image/*">` pattern - not a camera-only or mobile-only control - so it works identically whether the person reviewing and attaching a photo two days later is on the phone that captured it, a different phone, a tablet, or an office PC/laptop with the photo already downloaded/scanned onto it.

## Data model

New localStorage key, `gs_photo_upload_queue`, an array of:

```js
{
  id: 'p'+Date.now().toString(36)+Math.random().toString(36).slice(2,8), // client-generated, mirrors _rid()
  capType: 'manifold'|'refill'|'private'|'received'|'residual',
  branch: 'Helderberg'|'Kleinmond',
  date: 'YYYY-MM-DD',
  rowRid: '<the row's own _rid, to find it again for the correction write-back>',
  category: '<same category string uploadPhotoSet already takes: Manifold/Refill/Private/Received/Residual>',
  dataUri: '<the already-resized JPEG data URI - resizing happens BEFORE queueing, not deferred>',
  attempts: 0,
  lastAttemptAt: null,
  lastError: null
}
```

Resizing happens at capture time exactly as it does today (`_resizeImageForCapture`, unchanged) - the queue stores the already-small, already-compressed JPEG, not the original multi-MB camera photo, so the queue itself never becomes a storage problem.

## Error handling

- A queue entry that fails is left in the queue with `attempts` incremented and `lastError` set; it is retried on the next trigger (online event, periodic tick, login), not immediately looped, so a truly offline device doesn't hammer a dead connection.
- No maximum retry count / no silent expiry. A branch that's had connectivity problems for days should still have every queued photo eventually land once connectivity returns, or remain visibly pending via the badge until someone manually retries or intervenes.
- The existing 2026-09-18 stopgap fixes (catch block in `_capCommitReal`, 25s per-photo timeout in `uploadPhotoSet`) remain in place and still apply to the (now much smaller) surface of things that can go wrong during the data-only commit itself.

## Non-goals

- Not rebuilding the actual Sheets-proxy/`apiPost` transport, only how photo uploads relate to the commit lifecycle around it.
- Not adding the stay-on-screen or dual-counter treatment to Residual Gas (already has its own working "stay and clear the list" behavior) or to Faulty Cylinders / Stock Transfer.
- Not changing Stock Count, Verified Stock Take, Daily Sales, or any report/reconciliation feature.
