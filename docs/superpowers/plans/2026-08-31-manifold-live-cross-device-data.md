# Manifold Live Cross-Device Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every COMMITTED Manifold row visible to any device, on demand, so the
same-day Adjust tool, Review, Count History, and the Manifold capture screen itself all
show the real cross-device truth instead of only whatever this one device has captured
locally.

**Architecture:** Add a new Supabase table (`manifold_live_rows`) that mirrors every
committed Manifold row as a JSONB blob. Manifold's existing commit path writes to it
additively, right alongside the existing (unchanged) Google Sheet push, with a
localStorage retry queue on failure. Every screen that needs today's real Manifold truth
fetches from this table first and merges it into local `store.manifold` before rendering.

**Tech Stack:** Vanilla JS (single-file `index.html`), Supabase JS client (`sb`), no
build step, no test framework — this project's own established verification convention is
`node --check`-equivalent syntax verification (`new Function()` over each extracted
`<script>` block, since `index.html` isn't plain JS) plus live verification via direct
browser/console interaction. Every task below follows that convention, not a
pytest/jest-style automated suite this project doesn't have.

**Reference:** `docs/superpowers/specs/2026-08-31-manifold-live-cross-device-data-design.md`

---

### Task 0: Create the Supabase table

**Files:** none (Supabase schema change — no DB-write tool available; hand the user SQL,
same as every prior schema change this session).

- [ ] **Step 1: Give the user this SQL to run in the Supabase SQL editor**

```sql
CREATE TABLE IF NOT EXISTS manifold_live_rows (
  id uuid primary key default gen_random_uuid(),
  row_id text,
  branch text not null,
  date text not null,
  cyl text,
  row jsonb not null,
  committed_by uuid references profiles(id),
  committed_at timestamptz default now()
);
CREATE INDEX IF NOT EXISTS manifold_live_rows_branch_date_idx ON manifold_live_rows (branch, date);

ALTER TABLE manifold_live_rows ENABLE ROW LEVEL SECURITY;

CREATE POLICY manifold_live_rows_select ON manifold_live_rows
  FOR SELECT TO authenticated USING (true);

CREATE POLICY manifold_live_rows_insert ON manifold_live_rows
  FOR INSERT TO authenticated WITH CHECK (true);
```

- [ ] **Step 2: Confirm with the user the table was created successfully before continuing to Task 1**

---

### Task 1: Write path — push committed Manifold rows to Supabase

**Files:**
- Modify: `index.html` (near `_fetchManifoldSlotCount`, around line 1044 — add the new
  functions in the same "Manifold live data" block) and inside `_capCommitReal()` (around
  line 6684–6747).

- [ ] **Step 1: Add the push + retry-queue functions**

Add directly after `_fetchManifoldSlotCount(br)`'s closing brace (the function block added
earlier this session for tolerances/slot count):

```javascript
// ===== Manifold live cross-device mirror (manifold_live_rows) =====
// Additive parallel write alongside the existing Sheet push in _capCommitReal() below -
// never replaces it, never blocks it, and a failure here never blocks a commit from
// completing. See docs/superpowers/specs/2026-08-31-manifold-live-cross-device-data-design.md.
function _pushManifoldLiveRows(rows,br){
  if(!rows||!rows.length)return;
  var payload=rows.map(function(row){
    return {row_id:row._rid||null, branch:br, date:row._date||today, cyl:row.cyl||null, row:row, committed_by:currentProfile&&currentProfile.id};
  });
  sb.from('manifold_live_rows').insert(payload).then(function(res){
    if(res.error){console.error('_pushManifoldLiveRows failed:',res.error.message);_manifoldLiveQueue(payload);}
  },function(e){console.error('_pushManifoldLiveRows rejected:',e&&e.message);_manifoldLiveQueue(payload);});
}
function _manifoldLiveQueue(payload){
  try{
    var q=JSON.parse(localStorage.getItem('gs_manifoldlive_queue')||'[]');
    q.push(payload);
    localStorage.setItem('gs_manifoldlive_queue',JSON.stringify(q.slice(-200)));
  }catch(e){}
}
function _manifoldLiveFlush(){
  var q;try{q=JSON.parse(localStorage.getItem('gs_manifoldlive_queue')||'[]');}catch(e){return;}
  if(!q.length)return;
  localStorage.setItem('gs_manifoldlive_queue','[]');
  q.forEach(function(payload){
    sb.from('manifold_live_rows').insert(payload).then(function(res){
      if(res.error)_manifoldLiveQueue(payload);
    },function(e){_manifoldLiveQueue(payload);});
  });
}
```

- [ ] **Step 2: Wire the push into `_capCommitReal()`, reordering the `_committed` stamp**

Find this exact block (around line 6719–6730):

```javascript
    if(capType==='manifold')syncPush('Manifold',syncRowsManifold(freshRows,capBranch));
    else if(capType==='refill'){
      // record each seal against the active roll history (dedupe handled inside)
      freshRows.filter(function(r){return r.seal;}).forEach(function(r){sealRecordUse(capBranch,num(r.seal));});
      syncPush('Refills',syncRowsRefill(freshRows,capBranch));
    }
    else if(capType==='private')syncPush('Private',syncRowsPrivate(freshRows,capBranch));
    // Mark these rows synced so a later Review-with-nothing-new (or this whole function
    // re-running) never re-sends them - see the freshRows guard above and capReview()'s
    // preserve-committed-rows filter.
    freshRows.forEach(function(r){r._committed=true;});
    _clearCommittedCapData(capBranch);
```

Replace it with (stamps `_committed=true` FIRST, before any push — every row pushed
anywhere, Sheet or Supabase, should already carry the flag that says "this is committed
data," so a row round-tripped back in via `_fetchManifoldLiveRows` later on another device
is never mistaken for something still needing to be committed; the old single stamp that
used to happen after all three pushes is removed, not duplicated):

```javascript
    // Mark these rows synced so a later Review-with-nothing-new (or this whole function
    // re-running) never re-sends them - see the freshRows guard above and capReview()'s
    // preserve-committed-rows filter. Stamped BEFORE the pushes below (not after, like it
    // used to be) so a row is never pushed anywhere - Sheet or Supabase - without already
    // carrying the flag that says "this is committed data."
    freshRows.forEach(function(r){r._committed=true;});
    if(capType==='manifold'){syncPush('Manifold',syncRowsManifold(freshRows,capBranch));_pushManifoldLiveRows(freshRows,capBranch);}
    else if(capType==='refill'){
      // record each seal against the active roll history (dedupe handled inside)
      freshRows.filter(function(r){return r.seal;}).forEach(function(r){sealRecordUse(capBranch,num(r.seal));});
      syncPush('Refills',syncRowsRefill(freshRows,capBranch));
    }
    else if(capType==='private')syncPush('Private',syncRowsPrivate(freshRows,capBranch));
    _clearCommittedCapData(capBranch);
```

- [ ] **Step 3: Flush the retry queue at login**

Find (around line 2993):
```javascript
  syncFlush();
  _closeDayFlushQueue();
```
Change to:
```javascript
  syncFlush();
  _manifoldLiveFlush();
  _closeDayFlushQueue();
```

- [ ] **Step 4: Syntax-check**

Run (PowerShell — the Bash tool has been unreliable all session, prefer PowerShell):
```powershell
node -e "
const fs=require('fs');
const html=fs.readFileSync('index.html','utf8');
const re=/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/gi;
let m, ok=true;
while((m=re.exec(html))){
  try{ new Function(m[1]); }
  catch(e){ ok=false; console.log('SYNTAX ERROR:', e.message); }
}
console.log(ok?'ALL SCRIPT BLOCKS OK':'FAILED');
"
```
Expected: `ALL SCRIPT BLOCKS OK`

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat: push committed Manifold rows to a live Supabase mirror table"
```

---

### Task 2: Read path — fetch and merge live rows into `store.manifold`

**Files:**
- Modify: `index.html` (same "Manifold live data" block as Task 1).

- [ ] **Step 1: Add `_fetchManifoldLiveRows(br,date)`**

```javascript
// Pulls today's real committed Manifold truth for one branch from Supabase and merges it
// into local store.manifold. Replace-by-scope for this branch+date (mirrors
// loadWorkingStore()'s own local replace-by-branch merge, just sourced live) - EXCEPT any
// of THIS device's own committed rows that haven't round-tripped into the mirror table
// yet (still sitting in _manifoldLiveQueue after a failed push) are kept, not discarded -
// otherwise a row this device just committed would flicker out of its own screen the
// moment this fetch resolves, purely because of a transient network hiccup on the write
// side. Every row this pulls in is forced _committed=true regardless of what's stored -
// this table only ever holds already-committed rows by construction, and a device that
// later commits something else must never mistake one of these for "still needs sending."
function _fetchManifoldLiveRows(br,date){
  return sb.from('manifold_live_rows').select('row').eq('branch',br).eq('date',date).then(function(res){
    if(res.error){console.error('_fetchManifoldLiveRows failed for '+br+'/'+date+':',res.error.message);return;}
    var liveRows=(res.data||[]).map(function(r){var row=r.row||{};row._committed=true;return row;});
    var liveRids={};liveRows.forEach(function(r){if(r._rid)liveRids[r._rid]=true;});
    var localPending=(store.manifold||[]).filter(function(r){
      return r.branch===br && (r._date||today)===date && r._committed && r._rid && !liveRids[r._rid];
    });
    var others=(store.manifold||[]).filter(function(r){return !(r.branch===br && (r._date||today)===date);});
    store.manifold=others.concat(liveRows).concat(localPending);
  },function(e){console.error('_fetchManifoldLiveRows rejected for '+br+'/'+date+':',e&&e.message);});
}
```

- [ ] **Step 2: Syntax-check** (same command as Task 1 Step 4). Expected: `ALL SCRIPT BLOCKS OK`

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: add _fetchManifoldLiveRows read path for cross-device Manifold data"
```

---

### Task 3: Wire the fetch into the Manifold capture screen (fire-and-rerender)

**Files:**
- Modify: `index.html`, `openCap(type,opts)` (around line 5288–5323) and `capSetBranch(x)`
  (around line 5346–5353).

- [ ] **Step 1: Update `openCap`**

Find (around line 5317):
```javascript
  if(type==='manifold'){_fetchManifoldSlotCount(capBranch).then(renderGrid);_fetchManifoldPrevClose(capBranch);} // re-renders again once live count lands; renderGrid() below runs immediately with whatever's cached/fallback
```
Change to:
```javascript
  if(type==='manifold'){_fetchManifoldSlotCount(capBranch).then(renderGrid);_fetchManifoldPrevClose(capBranch);_fetchManifoldLiveRows(capBranch,today).then(renderGrid);} // re-renders again once live data lands; renderGrid() below runs immediately with whatever's cached/fallback
```

- [ ] **Step 2: Update `capSetBranch`**

Find (around line 5350):
```javascript
  if(capType==='manifold'){_fetchManifoldSlotCount(x).then(renderGrid);_fetchManifoldPrevClose(x);}
```
Change to:
```javascript
  if(capType==='manifold'){_fetchManifoldSlotCount(x).then(renderGrid);_fetchManifoldPrevClose(x);_fetchManifoldLiveRows(x,today).then(renderGrid);}
```

- [ ] **Step 3: Syntax-check** (same command). Expected: `ALL SCRIPT BLOCKS OK`

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: fetch live Manifold data on capture screen open/branch switch"
```

---

### Task 4: Wire the fetch into Review (blocking, before the picker/render)

**Files:**
- Modify: `index.html`, `capReview()` (around line 6519).

- [ ] **Step 1: Split `capReview()` into a thin wrapper + `_capReviewReal()`**

Find the function signature:
```javascript
function capReview(){
  var c=CAP[capType];
```
Change to:
```javascript
function capReview(){
  if(capType==='manifold'){
    _fetchManifoldLiveRows(capBranch,today).then(_capReviewReal,_capReviewReal);
    return;
  }
  _capReviewReal();
}
function _capReviewReal(){
  var c=CAP[capType];
```

This is the same wrapper/`_xReal()` split already used throughout this codebase
(`cCommit`/`_cCommitReal`, `capCommit`/`_capCommitReal`) — not a new pattern. The rest of
the existing `capReview()` body (validation, unpaired-swap checks, the render call) is
untouched, it just now lives inside `_capReviewReal()`. `.then(_capReviewReal,_capReviewReal)`
runs the real function whether the fetch succeeds or fails — a failed live fetch must
never block Review from opening, same graceful-degradation rule as every other live fetch
in this app.

- [ ] **Step 2: Syntax-check** (same command). Expected: `ALL SCRIPT BLOCKS OK`

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: fetch live Manifold data before Review opens"
```

---

### Task 5: Wire the fetch into the same-day Adjust tool (blocking)

**Files:**
- Modify: `index.html`, `openCapAdjust()` (around line 5449).

- [ ] **Step 1: Split `openCapAdjust()` into a thin wrapper + `_openCapAdjustReal()`**

Find the function signature:
```javascript
function openCapAdjust(){
  var sectionName=CAP_ADJUST_SECTION[capType];
```
Change to:
```javascript
function openCapAdjust(){
  if(capType==='manifold'){
    _fetchManifoldLiveRows(capBranch,today).then(_openCapAdjustReal,_openCapAdjustReal);
    return;
  }
  _openCapAdjustReal();
}
function _openCapAdjustReal(){
  var sectionName=CAP_ADJUST_SECTION[capType];
```

Same shape as Task 4 — the rest of `openCapAdjust()`'s existing body (the closed-day
check, building `todaysStore`, calling `openCorrection`) is untouched, just now inside
`_openCapAdjustReal()`. This is the exact change that closes the reported gap: once
`store.manifold` is refreshed from Supabase first, `todaysStore` (built from
`store[capType]` right after) correctly includes rows another device committed, and the
Adjust picker built from it can find and correct them.

- [ ] **Step 2: Syntax-check** (same command). Expected: `ALL SCRIPT BLOCKS OK`

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: fetch live Manifold data before the same-day Adjust picker opens"
```

---

### Task 6: Wire the fetch into Count History (fire-and-rerender, with staleness guard)

**Files:**
- Modify: `index.html`, `openHistory(mismatchOverlayRows)` (around line 6836).

- [ ] **Step 1: Add the live fetch at the top of `openHistory`**

Find the function signature:
```javascript
function openHistory(mismatchOverlayRows){
```
Add immediately after the opening brace:
```javascript
function openHistory(mismatchOverlayRows){
  // Manifold's live mirror only ever holds a day that isn't closed yet (see design doc) -
  // only worth fetching when this branch's day is still open, and only re-render if the
  // user is STILL looking at History for this exact branch by the time it resolves (same
  // staleness-guard convention as renderManifoldSlots()/_fetchManifoldSlotCount() call
  // sites elsewhere in this file) - a slow network response must never clobber a screen
  // the user has already navigated away from or switched branch on.
  if(!loadSavedDay(today,histBranch)){
    (function(br){
      _fetchManifoldLiveRows(br,today).then(function(){
        if(histBranch===br && document.getElementById('historyView') && document.getElementById('historyView').classList.contains('active'))openHistory(mismatchOverlayRows);
      });
    })(histBranch);
  }
```

- [ ] **Step 2: Syntax-check** (same command). Expected: `ALL SCRIPT BLOCKS OK`

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: fetch live Manifold data for Count History's Manifold table"
```

---

### Task 7: Live verification and push

No automated test suite exists for this project — verification is live, direct, and
must actually simulate two separate devices (two different browser profiles/incognito
windows, or the Claude Browser pane plus a second real device/browser), not just two tabs
sharing the same localStorage.

- [ ] **Step 1: Verify the write path**

On Device A: commit a fresh Manifold row (any stage). Confirm in the Supabase table editor
(or via a console `sb.from('manifold_live_rows').select('*').then(console.log)`) that a
matching row appears with the correct `branch`, `date`, `cyl`, and `row.row_id`/`row._rid`.

- [ ] **Step 2: Verify the read path — capture screen**

On Device B (different browser profile, same branch, same day): open Manifold capture.
Confirm the cylinder Device A just committed shows as already captured (not able to be
Opened again if it was an Opening row — reuses the existing same-day-lock feature), even
though Device B never captured it itself.

- [ ] **Step 3: Verify the read path — Adjust**

On Device B: open the same-day Adjust tool for Manifold. Confirm Device A's row now
appears in the picker. Correct it, confirm the correction applies (local store updates,
Adjustments sync fires, `adjustSheetRow` fires) — this is the exact originally-reported
gap being closed.

- [ ] **Step 4: Verify offline/failure graceful degradation**

Simulate a Supabase write failure (e.g. temporarily wrong table name in a scratch copy, or
disconnect network at commit time) — confirm the commit still completes and still pushes
to the Google Sheet successfully, and confirm `localStorage['gs_manifoldlive_queue']`
gains an entry. Reconnect and reload (triggering login's `_manifoldLiveFlush()`) — confirm
the queued row disappears from `gs_manifoldlive_queue` and appears in Supabase.

- [ ] **Step 5: Regression-check nothing else moved**

Confirm Count/Refill/Private/Received/Residual capture, and every already-shipped Manifold
feature this session (tolerances, tare-mismatch, underfill, leftover-on-removal,
hard-ceiling override, same-day Opening lock) still behave exactly as before — none of
this task touches their code paths, but verify live rather than assume.

- [ ] **Step 6: Push**

```bash
git push origin main
```
