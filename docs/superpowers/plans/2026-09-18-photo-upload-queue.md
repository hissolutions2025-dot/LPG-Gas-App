# Photo Upload Queue & Rapid-Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decouple photo upload from every capture commit (Manifold, Refill, Private Refill, Received, Residual Gas) so a stalled/failed photo never blocks or risks losing captured data, add a background retry queue plus a manual "add/retry photo" option reachable up to 48 hours later, and let Manifold/Refill/Private/Received stay on their own capture screen (ready for the next item) instead of bouncing to Home after every commit.

**Architecture:** One shared local queue (`gs_photo_upload_queue`, mirroring the existing Close Day pending-sync queue's shape) holds already-resized photos waiting to upload. A background processor retries it (online event, periodic tick, login) and, on success, writes the resulting link back onto the already-committed row via the existing per-type correction path (`adjustSheetRow` + the relevant Supabase live-mirror update) - reusing what this app already has for same-day corrections, not inventing a new one. Commit itself never awaits any of this.

**Tech Stack:** Single-file vanilla JS (`index.html`), no build step, no test framework. "Test" steps in this plan mean: (1) `node --check` on the JS extracted from `<script>` tags (syntax only - this app has no unit test runner), (2) live verification in the deployed app via browser console, injecting known data and calling the real functions directly (the established verification method used throughout this app's development - see any recent commit's own testing for precedent), (3) confirming on the actual deployed GitHub Pages URL after push. Every task's Step "Verify" replaces a conventional automated test for this reason.

**Known gap, called out honestly rather than guessed around:** Residual Gas does not use the same `_rid`/`adjustSheetRow` correction infrastructure Manifold/Refill/Private/Received do (confirmed: `_rid()`'s own comment lists only "Refill/Private/Received/Manifold" - Residual submits via a separate `apiPost('residualLog',{rows})` batch call with no row-level correction path anywhere in this file). Task 9 handles Residual's queue+decouple piece the same as the others, but its write-back step depends on the backend (Apps Script) already accepting corrections against whatever sheet/tab Residual logs to - that must be confirmed against the live backend before Task 9's write-back sub-step ships; if it isn't supported, Task 9 falls back to manual-only (the "Add/retry photo" button, Task 12) with no automatic background write-back for Residual specifically.

---

### Task 1: Photo upload queue data layer

**Files:**
- Modify: `index.html` (new functions, placed near the existing Close Day queue for consistency - search for `_closeDayQueueKey` and add these directly after `_closeDayFlushQueue`/`_updateCloseDayPendingBadge`)

- [ ] **Step 1: Add the queue load/save/add/remove functions**

Insert this block immediately after the existing `_updateCloseDayPendingBadge` function (search `function _updateCloseDayPendingBadge(){`, insert after its closing `}`):

```js
// ===== PHOTO UPLOAD QUEUE =====
// Added 2026-09-18 - see docs/superpowers/specs/2026-09-18-photo-upload-queue-design.md.
// Same local-queue + background-retry shape as the Close Day pending queue just above
// (_closeDayQueueKey/_closeDayQueueLoad/_closeDayQueueSave/_closeDayFlushQueue) - not a new
// pattern for this file, an extension of one already proven here. Holds already-resized
// photos (see _resizeImageForCapture - resizing happens at capture time, unchanged; the
// queue never stores an original multi-MB camera photo) for a row that has already
// committed its actual data - a queue entry existing here never means data is at risk, only
// that its photo(s) haven't finished uploading yet.
function _photoQueueKey(){return 'gs_photo_upload_queue';}
function _photoQueueLoad(){
  try{return JSON.parse(localStorage.getItem(_photoQueueKey())||'[]');}
  catch(e){console.error('Photo upload queue was corrupted and could not be read:',e.message);return [];}
}
function _photoQueueSave(q){
  try{localStorage.setItem(_photoQueueKey(),JSON.stringify(q));}catch(e){}
}
// capType: 'manifold'|'refill'|'private'|'received'|'residual'
// category: the same string uploadPhotoSet already takes (Manifold/Refill/Private/Received/Residual)
// sheet: the sheet/tab name adjustSheetRow expects for this capType (null for residual - see
// this plan's own "known gap" note; a null sheet means _photoQueueWriteBack skips the sheet
// correction step and only updates the local copy, until the backend question is resolved)
// linkField: the Sheet column name to write the joined links into (PhotoLinks/PhotoLink)
// localField: the app-side row field the joined links go into (photoLinks/_photoLink)
function _photoQueueAdd(entry){
  // De-dupes by capType+rowRid before adding - fixed during Task 5's code review: a Refill
  // row whose seal turns out already-used gets _committed reset to false and stays in
  // store.refill as a draft for the operator to fix and recommit; without this, the SAME
  // row's photos (same _rid) would get queued a second time on that recommit, each copy
  // independently retrying/uploading/write-back-ing for the same row. Removing any existing
  // entry for the same row before adding the new one makes a recommit replace, not duplicate -
  // the newest capture of a row's photos is always the one that matters.
  var q=_photoQueueLoad().filter(function(e){return !(e.capType===entry.capType && e.rowRid===entry.rowRid);});
  entry.id='p'+Date.now().toString(36)+Math.random().toString(36).slice(2,8);
  entry.attempts=0;entry.lastAttemptAt=null;entry.lastError=null;
  q.push(entry);
  _photoQueueSave(q);
  _updatePhotoQueuePendingBadge();
}
function _photoQueueRemove(id){
  var q=_photoQueueLoad().filter(function(e){return e.id!==id;});
  _photoQueueSave(q);
  _updatePhotoQueuePendingBadge();
}
function _photoQueueMarkAttempt(id,err){
  var q=_photoQueueLoad();
  var e=q.filter(function(x){return x.id===id;})[0];
  if(!e)return;
  e.attempts=(e.attempts||0)+1;e.lastAttemptAt=nowStamp();e.lastError=err||null;
  _photoQueueSave(q);
}
function _updatePhotoQueuePendingBadge(){
  var n=_photoQueueLoad().length;
  var text=n?('⏳ '+n+' photo(s) waiting to upload'):'';
  ['photoQueuePendingBadge','photoQueuePendingBadgeHistory'].forEach(function(id){
    var el=document.getElementById(id);
    if(!el)return;
    el.style.display=n?'block':'none';
    el.textContent=text;
  });
}
```

- [ ] **Step 2: Syntax-check**

Run (PowerShell):
```powershell
$content = Get-Content -Raw "index.html"
$scripts = [regex]::Matches($content, '(?s)<script>(.*?)</script>')
$js = ($scripts | ForEach-Object { $_.Groups[1].Value }) -join "`n;`n"
Set-Content -Path "$env:TEMP\lpg_check.js" -Value $js -Encoding utf8
node --check "$env:TEMP\lpg_check.js"
```
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: photo upload queue data layer (load/save/add/remove/badge)"
```

---

### Task 2: Generic `capture_live_rows` mirror updater

**Files:**
- Modify: `index.html` (new function, placed directly after the existing `_updateManifoldLiveRowFields` at the line matching `function _updateManifoldLiveRowFields(rowRid,fields){`)

- [ ] **Step 1: Add the generic mirror updater**

Manifold already has `_updateManifoldLiveRowFields` (its own dedicated `manifold_live_rows` table). Refill/Private/Received/Residual share the generic `capture_live_rows` table instead (`kind` column distinguishes them - confirmed via this table's own schema: `id,kind,row_id,branch,date,row,committed_by,committed_at`). No updater-by-row_id exists yet for that table - add one, insert immediately after `_updateManifoldLiveRowFields`'s closing `}`:

```js
// Generic capture_live_rows mirror updater, added 2026-09-18 for the photo upload queue -
// mirrors _updateManifoldLiveRowFields exactly (match by row_id, merge fields into the row
// JSON blob) but for the shared refill/private/received/residual table instead of Manifold's
// own dedicated one. kind must be passed since row_id alone isn't guaranteed unique across
// different capture types.
function _updateCaptureLiveRowFields(kind,rowRid,fields){
  if(!rowRid)return Promise.resolve();
  return sb.from('capture_live_rows').select('id,row').eq('kind',kind).eq('row_id',rowRid).then(function(res){
    if(res.error){console.error('_updateCaptureLiveRowFields select failed:',res.error.message);return;}
    if(!res.data||!res.data.length){console.error('_updateCaptureLiveRowFields: no capture_live_rows match for kind',kind,'row_id',rowRid,'- mirror row not updated (may not have finished syncing yet)');return;}
    return Promise.all(res.data.map(function(rec){
      var updatedRow=Object.assign({},rec.row,fields);
      return sb.from('capture_live_rows').update({row:updatedRow}).eq('id',rec.id).then(function(ures){
        if(ures.error)console.error('_updateCaptureLiveRowFields update failed:',ures.error.message);
      });
    }));
  },function(e){console.error('_updateCaptureLiveRowFields rejected:',e&&e.message);});
}
```

- [ ] **Step 2: Syntax-check** (same command as Task 1 Step 2)

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: generic capture_live_rows mirror updater for photo queue write-back"
```

---

### Task 3: Queue processor and write-back

**Files:**
- Modify: `index.html` (new functions, placed directly after Task 1's `_updatePhotoQueuePendingBadge`)

- [ ] **Step 1: Add the write-back dispatcher and processor**

```js
// Per-capType sheet/field mapping for photo write-back. sheet:null means "no known sheet-
// level correction path yet" (Residual - see this plan's own "known gap" note); the write-
// back still updates the local copy and (for the 4 with a mirror table) the live mirror, it
// just skips the adjustSheetRow call for residual until the backend question is settled.
var PHOTO_QUEUE_SHEET={manifold:'Manifold',refill:'Refills',private:'Private',received:'Received',residual:null};
var PHOTO_QUEUE_LINK_FIELD={manifold:'PhotoLink',refill:'PhotoLinks',private:'PhotoLinks',received:'PhotoLinks',residual:'PhotoLinks'};
var PHOTO_QUEUE_LOCAL_FIELD={manifold:'_photoLink',refill:'_photoLink',private:'photoLinks',received:'photoLinks',residual:'photoLinks'};
// Writes an uploaded photo link set back onto an already-committed row, three places: the
// local copy (so Review/History shows it immediately without waiting on anything else), the
// Sheet row in place (adjustSheetRow - same mechanism the same-day Adjust tool already uses,
// skipped when PHOTO_QUEUE_SHEET has no entry for this capType), and the live Supabase
// mirror (manifold_live_rows for manifold, capture_live_rows for the rest) so another device
// sees it today too, not just after Close Day's snapshot.
function _photoQueueWriteBack(entry,links){
  var localField=PHOTO_QUEUE_LOCAL_FIELD[entry.capType];
  var row=(store[entry.capType]||[]).filter(function(r){return r._rid===entry.rowRid;})[0];
  if(row)row[localField]=links;
  saveWorkingStore();
  var sheet=PHOTO_QUEUE_SHEET[entry.capType];
  if(sheet){
    var linkField=PHOTO_QUEUE_LINK_FIELD[entry.capType];
    var updates={};updates[linkField]=links;
    adjustSheetRow(sheet,entry.rowRid,updates);
  }
  if(entry.capType==='manifold'){
    return _updateManifoldLiveRowFields(entry.rowRid,{_photoLink:links});
  }
  // Uses localField (already computed above), NOT a hardcoded 'photoLinks' - Refill's own
  // local/mirror field is '_photoLink', not 'photoLinks' (confirmed via syncRowsRefill,
  // PhotoLinks:(r._photoLink||'')). Hardcoding 'photoLinks' here silently wrote an unused key
  // onto Refill's mirror row while its real field stayed stale - the same class of bug as the
  // Sheet-column PhotoLink/PhotoLinks mismatch caught earlier in this same task, just in the
  // mirror-write path instead of the sheet-write path. Found in code review, not by inspection
  // alone - worth being extra careful re-reading this exact function once more before Task 5+
  // start feeding it real entries.
  var mf={_committed:true};mf[localField]=links;
  return _updateCaptureLiveRowFields(entry.capType,entry.rowRid,mf);
}
// Processes queue entries one at a time (never parallel - a burst of retries hitting the same
// flaky connection at once helps nobody), but does NOT get stuck on a permanently-failing
// entry - found in code review: an earlier version always read q[0], so an entry that keeps
// failing (corrupted data, a category the backend rejects, anything) blocked every OTHER
// queued entry forever, silently, no matter how healthy the connection otherwise was. On a
// failure this now advances to the NEXT index within the same pass instead of stopping, so
// every entry gets one attempt per trigger (online reconnect / the 45s tick / login) even
// when an earlier entry is stuck - the stuck entry stays queued and gets retried on the next
// trigger, it just doesn't gate anything behind it anymore. uploadPhotoSet already skips any
// individual photo that fails and returns whatever DID succeed joined together - an empty
// return with photos present means everything failed this attempt (kept queued, retried
// later); any non-empty return is treated as this entry's best achievable result and the
// entry is removed, matching the exact same "partial success is still success" behavior the
// old at-commit-time blocking path already had (this isn't a new leniency, just preserving
// what existed).
var _photoQueueBusy=false;
function _photoQueueProcess(startIndex){
  if(_photoQueueBusy)return;
  var q=_photoQueueLoad();
  var idx=startIndex||0;
  if(idx>=q.length)return;
  var entry=q[idx];
  _photoQueueBusy=true;
  uploadPhotoSet(entry.category,entry.branch,entry.photos).then(function(links){
    if(!links){
      _photoQueueMarkAttempt(entry.id,'no photo(s) uploaded this attempt');
      _photoQueueBusy=false;
      _photoQueueProcess(idx+1); // move on to the next entry instead of retrying this one immediately
      return;
    }
    return _photoQueueWriteBack(entry,links).then(function(){
      _photoQueueRemove(entry.id);
      _photoQueueBusy=false;
      _photoQueueProcess(); // queue shrank - restart from 0 rather than reasoning about shifted indices
    });
  }).catch(function(e){
    _photoQueueMarkAttempt(entry.id,e&&e.message);
    _photoQueueBusy=false;
    _photoQueueProcess(idx+1);
  });
}
// Retry triggers - online reconnect (same event the Close Day queue already listens for),
// and a periodic tick that only does anything while the queue is non-empty (no polling once
// it's empty). Called once more from doLogin()/_finishLogin() in Task 4 below.
// Wrapped, not passed directly - found in code review: _photoQueueProcess now takes an
// optional startIndex (the head-of-line-blocking fix above), and addEventListener calls its
// handler with the Event object as the first argument - passed directly, 'online' would hand
// that Event to _photoQueueProcess as startIndex, `idx=startIndex||0` would hold the Event
// object (truthy), and q[idx] would resolve to undefined, throwing on entry.category. The
// 45s setInterval trigger below was never affected (it already calls with no arguments).
window.addEventListener('online',function(){_photoQueueProcess();});
setInterval(function(){if(_photoQueueLoad().length)_photoQueueProcess();},45000);
```

- [ ] **Step 2: Syntax-check** (same command as Task 1 Step 2)

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: photo upload queue background processor and write-back"
```

---

### Task 4: Wire queue processing into login and add the pending badge to the UI

**Files:**
- Modify: `index.html` (one call added to the login flow, two badge `<div>`s added to Home and History)

- [ ] **Step 1: Trigger a queue flush on login**

Find `_closeDayFlushQueue()`'s own call site inside `_finishLogin()` (search `_closeDayFlushQueue();` - it's called once per login alongside other startup sync work) and add the photo queue flush right next to it:

```js
_closeDayFlushQueue();
_photoQueueProcess();
_updatePhotoQueuePendingBadge();
```//`_updatePhotoQueuePendingBadge()` also needs calling once at app boot so a badge left over from a previous session shows immediately, not just after the next successful/failed flush - add it at the same place `_updateCloseDayPendingBadge()` is already called at boot (search for that exact call and add the photo one directly after it).

- [ ] **Step 2: Add the badge elements**

Find the existing `closeDayPendingBadge` element on the Home/landing screen (search `id="closeDayPendingBadge"`) and add a matching one directly after it:

```html
<div id="closeDayPendingBadge" style="display:none"></div>
<div id="photoQueuePendingBadge" style="display:none;background:#FDF3F2;color:#9B2C2C;border-radius:8px;padding:8px 12px;font-size:12px;font-weight:700;margin-top:6px;text-align:center"></div>
```

Find `closeDayPendingBadgeHistory` (search `id="closeDayPendingBadgeHistory"`, on the History screen) and add a matching one directly after it:

```html
<div id="closeDayPendingBadgeHistory" style="display:none"></div>
<div id="photoQueuePendingBadgeHistory" style="display:none;background:#FDF3F2;color:#9B2C2C;border-radius:8px;padding:8px 12px;font-size:12px;font-weight:700;margin-top:6px;text-align:center"></div>
```

- [ ] **Step 3: Syntax-check** (same command as Task 1 Step 2)

- [ ] **Step 4: Verify live**

Deploy (commit + push), wait for GitHub Pages, then in the browser console on the live app:
```js
_photoQueueAdd({capType:'private',branch:'Helderberg',date:today,rowRid:'test123',category:'Private',photos:[]});
document.getElementById('photoQueuePendingBadge').textContent
// expect: "⏳ 1 photo(s) waiting to upload"
_photoQueueRemove('test123'); // won't match (wrong id shape) - instead:
_photoQueueSave([]); _updatePhotoQueuePendingBadge();
document.getElementById('photoQueuePendingBadge').style.display
// expect: "none"
```

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat: wire photo queue flush into login, add pending badges to Home/History"
```

---

### Task 5: Decouple photo upload from Manifold/Refill/Private commit (`capCommit`/`_capCommitReal`)

**Files:**
- Modify: `index.html` (`_capCommitReal`, the block starting `if(capType==='manifold' || capType==='private' || capType==='refill'){`)

- [ ] **Step 1: Replace the blocking photo-upload loop with an enqueue**

Find this exact block inside `_capCommitReal` (confirmed against the actual file immediately before writing this task - the 25s timeout from the earlier stopgap fix lives INSIDE `uploadPhotoSet` itself, not duplicated at this call site, so this loop is a plain `await`, not a `Promise.race`):

```js
    if(capType==='manifold' || capType==='private' || capType==='refill'){
      var photoKey = capType==='private' ? 'supplierPhoto' : 'photo'; // manifold and refill both use the plain 'photo' key
      var linkKey = capType==='private' ? 'photoLinks' : '_photoLink';
      var rowsWithPhotos = freshRows.filter(function(r){return (r[photoKey]||[]).length;});
      if(rowsWithPhotos.length){
        toast('Uploading photo(s)…');
        for(var pi=0;pi<rowsWithPhotos.length;pi++){
          var pr=rowsWithPhotos[pi];
          pr[linkKey]=await uploadPhotoSet(capType==='manifold'?'Manifold':(capType==='refill'?'Refill':'Private'), capBranch, pr[photoKey]);
        }
      }
    }
```

Replace it with:

```js
    // Decoupled 2026-09-18 - see docs/superpowers/specs/2026-09-18-photo-upload-queue-design.md.
    // Photos no longer block commit at all: each row's already-resized photos go straight
    // into the background upload queue (Task 1-3) and the data commits immediately below,
    // regardless of upload outcome. photoKey/linkKey unchanged from before (Private's fields
    // are still named supplierPhoto/photoLinks, Manifold/Refill still photo/_photoLink -
    // only WHEN the upload happens changed, not the field names anything else reads).
    // _queuedThisCommit counts only what THIS commit just queued - fixed during code review:
    // _photoQueueLoad().length (used further down for the toast) is the ENTIRE persistent
    // backlog, every unprocessed entry from every prior commit/capType/branch, not "how many
    // this commit added." Reading that raw total in the toast either over-counts (stale
    // entries from earlier commits inflate it) or misleads (shows a nonzero count when THIS
    // commit queued nothing at all).
    var _queuedThisCommit=0;
    if(capType==='manifold' || capType==='private' || capType==='refill'){
      var photoKey = capType==='private' ? 'supplierPhoto' : 'photo';
      var category = capType==='manifold'?'Manifold':(capType==='refill'?'Refill':'Private');
      freshRows.filter(function(r){return (r[photoKey]||[]).length;}).forEach(function(r){
        _photoQueueAdd({capType:capType,branch:capBranch,date:today,rowRid:r._rid,category:category,photos:r[photoKey]});
        _queuedThisCommit++;
      });
    }
```

- [ ] **Step 2: Update the post-commit toast to mention queued photos**

Find:
```js
    } else toast(c.title+' committed ✓');
```
Replace with:
```js
    } else {
      toast(c.title+' committed ✓'+(_queuedThisCommit?(' · '+_queuedThisCommit+' photo(s) uploading in background'):''));
    }
```

- [ ] **Step 3: Syntax-check** (same command as Task 1 Step 2)

- [ ] **Step 4: Verify live**

Deploy, then in the browser console on the live app (using the same synthetic-data injection pattern established throughout this app's own development - set `currentProfile`/`role`/`branch`/`capBranch`/`capType='private'`, seed a `store.private` row with a `supplierPhoto` array and `_committed:false`, call `_capCommitReal()`, then confirm: `_photoQueueLoad().length===1`, the toast mentions "uploading in background", and the commit itself (audit log entry, `store.private[0]._committed`) completed without waiting on the fake photo).

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat: decouple photo upload from Manifold/Refill/Private commit"
```

---

### Task 6: Decouple photo upload from Received commit (`rCommit`)

**Files:**
- Modify: `index.html` (Received's own commit function - search `function rCommit`, find its own `uploadPhotoSet` call, same shape as Task 5 but Received's photos are session-level, not per-row - see `rPhoto`/`st.photos` in the surrounding code before this edit to confirm the exact local variable names in place at the time of implementation)

- [ ] **Step 1: Find Received's current blocking photo-upload call**

Read the function fully first (`function rCommit(){` through its own closing `}`) to find exactly where it awaits `uploadPhotoSet` for Received's session-level photo set, and what row(s) that upload's link is meant to attach to (Received's rows are per-size lines within one delivery session, sharing one photo set per the session, based on this plan's spec discussion of "session-level" photos - confirm the precise linkage before editing, since Received's shape differs from the other three's strictly-per-row photos).

- [ ] **Step 2: Replace the blocking call with an enqueue per committed row that should carry the link**

Mirror Task 5 Step 1's transformation exactly: remove the `await uploadPhotoSet(...)` / `await Promise.race([...])` call, replace with a loop over the rows this commit is about to sync that calls `_photoQueueAdd({capType:'received',branch:rBranch,date:today,rowRid:r._rid,category:'Received',photos:<the session's photo array>})` for each row that should receive the link (or once, on the first/primary row, if Received's backend model attaches one link to one row per session rather than duplicating it across every line - confirm against `syncRowsReceived`'s own field mapping before deciding).

- [ ] **Step 3: Update the post-commit toast** (same pattern as Task 5 Step 2, using Received's own existing toast line: `toast('Received committed'+(mm.length?...)+' ✓');`)

- [ ] **Step 4: Syntax-check** (same command as Task 1 Step 2)

- [ ] **Step 5: Verify live** (same approach as Task 5 Step 4, seeded for Received's own draft shape)

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "feat: decouple photo upload from Received commit"
```

---

### Task 7: Stay-on-screen after commit for Manifold/Refill/Private (`_capCommitReal`)

**Files:**
- Modify: `index.html` (`_capCommitReal`'s success path, the `goHome();` call)

- [ ] **Step 1: Replace `goHome()` with an in-place reset**

Find:
```js
    goHome();
  } catch(e){
```
Replace with:
```js
    _capCommitStayOrHome();
  } catch(e){
```

Add this new function directly after `_capCommitReal`'s own closing `}`:

```js
// Stay-on-screen after commit, added 2026-09-18 per explicit request ("if they are busy in a
// section wanting to go to the next refill then this would waste time") - Manifold/Refill/
// Private already worked this way for adding MULTIPLE lines before one commit; this just
// stops the commit itself from also ending the whole capture session. Faulty Cylinders/
// Residual Gas/Stock Transfer dispatch already do the equivalent (their own submit functions
// were never wired to goHome() in the first place) - this brings Manifold/Refill/Private in
// line with that existing, already-proven pattern instead of inventing a new one. Stock
// Count/Verified Stock Take are deliberately NOT touched - each of those commits IS the
// whole day's task, there's no "next item" to stay ready for.
function _capCommitStayOrHome(){
  var c=CAP[capType];
  capData={_type:capType};
  toggleSel={};
  if(c.toggles){c.toggles.forEach(function(t){toggleSel[t.key]=t.states[0];});}
  buildHeader(c);
  renderGrid();
  _capUpdateSessionCounter();
  window.scrollTo(0,0);
}
```

- [ ] **Step 2: Syntax-check** (same command as Task 1 Step 2)

- [ ] **Step 3: Verify live**

Deploy, then walk through the real UI (not just console): log in with a test/synthetic profile as established elsewhere this session, open Refill capture, add and commit a line, confirm the screen stays on the Refill capture form (not Home) with an empty grid ready for the next entry, and that Back still works normally to leave the section.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: stay on capture screen after commit for Manifold/Refill/Private"
```

---

### Task 8: Stay-on-screen after commit for Received (`rCommit`)

**Files:**
- Modify: `index.html` (`rCommit`'s success path, its own `goHome();` call)

- [ ] **Step 1: Replace Received's `goHome()` with an equivalent in-place reset**

Find Received's own success path (search the `toast('Received committed'...)+' ✓');goHome();` line from Task 6). Replace `goHome();` with a call to a new `_rCommitStayOrHome()` function, built the same way as Task 7's `_capCommitStayOrHome` but reusing whatever Received's own "reset the form" helper already is (Received has its own `rData`/`rSupplierState`/`rRenderGrid` - reuse the exact reset logic already used when switching branches on this screen, rather than duplicating it; find and call that existing reset path plus `_rUpdateSessionCounter()` from Task 10).

- [ ] **Step 2: Syntax-check** (same command as Task 1 Step 2)

- [ ] **Step 3: Verify live** (same approach as Task 7 Step 3, for Received)

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: stay on capture screen after commit for Received"
```

---

### Task 9: Decouple photo upload for Residual Gas (`residualSubmit`) - queue only, write-back per the known gap

**Files:**
- Modify: `index.html` (`residualSubmit`, the block awaiting `uploadPhotoSet` before its batch `apiPost('residualLog',...)` call)

- [ ] **Step 1: Replace the blocking photo-upload loop with an enqueue**

Find:
```js
    var rowsWithPhotos=residualList.filter(function(r){return (r.photos||[]).length;});
    if(rowsWithPhotos.length){
      toast('Uploading photo(s)…');
      for(var i=0;i<rowsWithPhotos.length;i++){
        var pr=rowsWithPhotos[i];
        pr.photoLinks=await uploadPhotoSet('Residual',pr.Branch,pr.photos);
      }
    }
```
Replace with:
```js
    // Decoupled 2026-09-18 - photos queue in the background same as every other section (see
    // Task 1-3); residualLog's own row submission below no longer waits on them. Write-back
    // for Residual specifically only updates the local copy and the capture_live_rows mirror
    // right now (PHOTO_QUEUE_SHEET.residual is null) - it does NOT correct anything server-
    // side on whatever sheet/tab residualLog writes to, since no row-level correction path is
    // confirmed to exist there yet (see this plan's own header note). Until that's confirmed,
    // a residual row's photo can still be added/retried manually (Task 12) even if the
    // background queue's write-back can't reach the sheet.
    residualList.filter(function(r){return (r.photos||[]).length;}).forEach(function(r){
      r._rid=r._rid||_rid();
      _photoQueueAdd({capType:'residual',branch:r.Branch,date:today,rowRid:r._rid,category:'Residual',photos:r.photos});
    });
```

- [ ] **Step 2: Stamp `_rid` on every committed row, not just ones with photos**

Find (a few lines below the block just edited):
```js
    var committedRows=residualList.map(function(r){
      return {Branch:r.Branch,Brand:r.Brand,Size:r.Size,GasType:r.GasType,CylScale:r.CylScale,CylTare:r.CylTare,Residual:r.Residual,Note:r.Note,_operator:operator,_date:today,_committed:true,_rid:_rid()};
    });
```
Replace `_rid:_rid()` with `_rid:(r._rid||_rid())` so a row that already got one from the photo-queue step above keeps the SAME id instead of getting a second, mismatched one that the queue entry's `rowRid` would no longer match:
```js
    var committedRows=residualList.map(function(r){
      return {Branch:r.Branch,Brand:r.Brand,Size:r.Size,GasType:r.GasType,CylScale:r.CylScale,CylTare:r.CylTare,Residual:r.Residual,Note:r.Note,_operator:operator,_date:today,_committed:true,_rid:(r._rid||_rid())};
    });
```

- [ ] **Step 3: Update the post-submit toast** (same "N photo(s) uploading in background" pattern as Task 5 Step 2, added to Residual's own `toast('Residual gas submitted ('+...+')');` line)

- [ ] **Step 4: Syntax-check** (same command as Task 1 Step 2)

- [ ] **Step 5: Verify live** (console-injection approach as Task 5 Step 4, adapted to `residualList`/`residualSubmit()`)

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "feat: decouple photo upload from Residual Gas submit (queue-only, see known gap)"
```

---

### Task 10: Dual session counter on Manifold/Refill/Private/Received capture screens

**Files:**
- Modify: `index.html` (new `<div>` in each of the 4 capture screen templates, new `_capUpdateSessionCounter()`/`_rUpdateSessionCounter()` functions)

- [ ] **Step 1: Add the counter element to the shared Manifold/Refill/Private capture view**

Find the capture view's header area (search `id="capHint"`, which `_openCapContinue` already sets text on - add the counter directly after it in the HTML):
```html
<div id="capHint" style="..."></div>
<div id="capSessionCounter" style="font-size:11px;color:var(--muted);margin-top:4px"></div>
```

- [ ] **Step 2: Add the counter update function**

```js
// Dual counter, added 2026-09-18 per explicit request - "committed today" (this section,
// this branch, today - same data Review/History already reads, no new tracking) and "photos
// uploading" (this branch's share of the photo queue). Called from _capCommitStayOrHome
// (Task 7) after every commit, and once when the screen first opens.
function _capUpdateSessionCounter(){
  var el=document.getElementById('capSessionCounter');if(!el)return;
  var committedToday=(store[capType]||[]).filter(function(r){return r.branch===capBranch&&(r._date||today)===today&&r._committed;}).length;
  var queuedForBranch=_photoQueueLoad().filter(function(e){return e.capType===capType&&e.branch===capBranch;}).length;
  el.textContent=committedToday+' committed today'+(queuedForBranch?(' · '+queuedForBranch+' photo(s) uploading'):'');
}
```

- [ ] **Step 3: Call it when the screen first opens**

In `_openCapContinue` (Task from earlier work this session - search `if(type==='private')loadPrivateSuppliers();`), add directly after:
```js
  if(type==='private')loadPrivateSuppliers();
  _capUpdateSessionCounter();
```

- [ ] **Step 4: Add the same counter to Received's own capture view**, mirroring Steps 1-3 with Received's own template/element ids and an `_rUpdateSessionCounter()` reading `store.received`/`rBranch` instead of `store[capType]`/`capBranch`.

- [ ] **Step 5: Syntax-check** (same command as Task 1 Step 2)

- [ ] **Step 6: Verify live**

Real UI walkthrough: commit two Refill lines in a row without leaving the screen, confirm the counter reads "2 committed today" (plus any queued-photo count), matching what Review/History shows for the same branch/day.

- [ ] **Step 7: Commit**

```bash
git add index.html
git commit -m "feat: dual session counter (committed today / photos uploading) on capture screens"
```

---

### Task 11: "Add/retry photo" on today's Review rows (Manifold/Refill/Private/Received)

**Files:**
- Modify: `index.html` (the Review/History row renderer shared by these types - search `capReviewCols` and its row-rendering caller fixed earlier today for the `photo:true` marker; also the equivalent Received review renderer)

Scope check done during planning: the "48-hour window" in this app is measured from when a DAY CLOSES, not from when a row is captured (confirmed: `if(!rec.closedTs || (Date.now()-rec.closedTs)>48*3600*1000){toast('48-hour window has closed',true);return;}`, index.html ~line 12120, inside `correctSavedLine` - the HISTORICAL correction tool, which operates on a frozen `rec.store` snapshot via `corrLines()`/`openCorrection()`/`corrApply()`, an entirely different data flow than the live Review screen this task touches). So:
- **This task** covers TODAY's rows only (the day hasn't closed yet) - no time gate needed at all, same as the existing same-day Adjust tool, which is available any time before Close Day.
- **Task 11b below** covers rows from an already-closed day, within 48 hours of that close - genuinely separate work, wired into `corrLines`/`openCorrection` instead.

- [ ] **Step 1: Add a button next to the photo cell on today's Review rows**

In the row renderer that already handles `if(c.photo){...}` (fixed earlier today - search `if(c.photo){var ph=Array.isArray(v)...`), extend it to add a button after the existing thumbnails. No extra eligibility gate needed here - this renderer only ever shows TODAY's still-open rows already, matching every other action already available on this same screen (correcting a value via the same-day Adjust tool has no time gate either, for the same reason):

```js
if(c.photo){
  var ph=Array.isArray(v)?v:(v?[v]:[]);
  var addBtn='<button type="button" class="sigClear" style="padding:3px 8px;font-size:10px" onclick="_openAddPhotoFor(\''+type+'\',\''+(r._rid||'')+'\')">'+(ph.length?'+ Add another':'+ Add photo')+'</button>';
  return '<td>'+(ph.length?ph.map(function(s){return '<img src="'+s+'" style="max-height:40px;border-radius:4px;margin:1px">';}).join(''):'—')+(r._rid?addBtn:'')+'</td>';
}
```

- [ ] **Step 2: Add the `_openAddPhotoFor` handler**

Reuses the existing photo-capture UI (`onPhotoPick`/`_pickPhotoOrFallback`/resize) via a small dedicated popup rather than a new capture surface - a single `<input type="file" accept="image/*">` (no `capture` attribute - see this task's own cross-device note below) triggered directly:

```js
// Reuses the plain <input type="file" accept="image/*"> pattern already used for live
// capture (onPhotoPick/_pickPhotoOrFallback) - deliberately WITHOUT the capture="environment"
// hint the live-capture inputs use, since this button is for attaching a photo that may
// already exist as a file (downloaded, scanned, transferred from another device) rather than
// taking a brand new one; the browser still offers "take photo" as one of the options on a
// phone/tablet, it just isn't forced to camera-first. On a PC/laptop/desktop this opens the
// normal file browser either way - no behavior difference to preserve there.
function _openAddPhotoFor(capType,rid){
  var input=document.createElement('input');
  input.type='file';input.accept='image/*';input.style.display='none';
  document.body.appendChild(input);
  input.onchange=function(){
    var f=input.files&&input.files[0];
    document.body.removeChild(input);
    if(!f)return;
    _resizeImageForCapture(f).then(function(dataUri){
      if(dataUri.length>PHOTO_HARD_LIMIT){toast('Photo still too large after resizing — try a different photo',true);return;}
      var category=(capType==='manifold'?'Manifold':capType==='refill'?'Refill':capType==='private'?'Private':capType==='received'?'Received':'Residual');
      _photoQueueAdd({capType:capType,branch:(histBranch||branch),date:today,rowRid:rid,category:category,photos:[dataUri]});
      toast('Photo queued — uploading in background');
    }).catch(function(){toast('Could not read that photo',true);});
  };
  input.click();
}
```

- [ ] **Step 3: Apply the same button to Received's own review row renderer** (mirror Step 1's `photo:true`-gated cell, using Received's own `_rid`-bearing row shape)

- [ ] **Step 4: Syntax-check** (same command as Task 1 Step 2)

- [ ] **Step 5: Verify live**

Real UI walkthrough on desktop (a PC/laptop browser, not emulated mobile) and once in mobile viewport (`resize_window` preset "mobile" if verifying through the browser pane): open History for a branch with a committed row, tap "+ Add photo", confirm a file picker opens (native OS file browser on desktop, camera/library chooser on mobile), select an image, confirm a "Photo queued" toast appears and `_photoQueueLoad()` grows by one.

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "feat: manual add/retry photo on Review/History rows, all capture types"
```

---

### Task 11b: Extend "Add/retry photo" to the 48-hour historical correction tool

**Files:**
- Modify: `index.html` (the historical correction screen - `corrLines()` at ~line 11549, `openCorrection()` at ~line 11646, `corrApply()` at ~line 12020, and `correctSavedLine()` at ~line 12116, which is what opens this whole tool for a specific already-closed day and enforces the real 48-hour-from-close check)

This is genuinely separate work from Task 11, not a copy-paste of it: the historical tool operates on `rec.store` - a FROZEN snapshot of a CLOSED day (`loadSavedDay`/`loadSavedDayShared`'s result), not the live `store[capType]` array Task 11's screen reads. A photo added here can't just push into `store[capType]` the way `_photoQueueWriteBack` (Task 3) does - it needs to update the frozen snapshot's own copy (so reopening the historical view shows it) in addition to going through the same `_photoQueueAdd`/background-upload/`adjustSheetRow`/mirror-update path Task 3 already built (that part IS reusable as-is, since it operates on the Sheet row and Supabase mirror by `_rid`, neither of which cares whether the local caller is `store[capType]` or a `rec.store` snapshot).

- [ ] **Step 1: Read `corrLines()`, `openCorrection()`, and `corrApply()` in full**

Understand exactly how `sel.row` is populated for a Manifold/Refill/Private/Received line within this tool (mirrors the shape `openCapAdjust`'s own `sel.row` already has - confirmed reused at index.html ~8389 `if(sel.row){...}` for value corrections), and how `onApply`'s callback receives enough context (`sel`, the historical record `rec`) to know which snapshot to also update.

- [ ] **Step 2: Add a photo button to this tool's own line-rendering, gated on the real 48-hour-from-close check already enforced by `correctSavedLine`** (that function already refuses to open past 48 hours - Step 2 does not need its own separate time check, only needs to render inside a screen that's already gated)

- [ ] **Step 3: On tap, resize (`_resizeImageForCapture`) then call `_photoQueueAdd` with the historical row's own `_rid`, AND update `rec.store[capType]`'s matching row's local photo field directly (mirroring what `_photoQueueWriteBack` does for the live case, but against the snapshot instead of `store[capType]`) so the historical view reflects it without waiting for the queue**

- [ ] **Step 4: Syntax-check** (same command as Task 1 Step 2)

- [ ] **Step 5: Verify live**

Walk through the real UI: close a test day (or use an already-closed real day within 48 hours), open the historical correction tool for a row missing a photo, add one, confirm it queues and the historical view shows it immediately.

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "feat: extend add/retry photo to the 48-hour historical correction tool"
```

---

### Task 12: Final end-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Full syntax check** (same command as Task 1 Step 2) - must still pass after every prior task's changes combined.

- [ ] **Step 2: Live smoke test of the whole flow**

On the deployed app, using the established synthetic-auth-injection method (no real password entered): commit a Private Refill line with a photo where the photo upload is stubbed to fail once then succeed on retry (mirrors this app's own earlier stopgap-fix verification style) - confirm the commit completes immediately regardless, the queue picks it up, the badge shows and then clears, and the row's `photoLinks`/mirror row end up with the link.

- [ ] **Step 3: Confirm nothing regressed**

Re-run the exact verification steps already used earlier this session for: the Manifold-Opening gate fix (still correct), the `photo:true` Review-table fix (still correct), and Stock Count/Verified Stock Take still `goHome()` as before (untouched).

- [ ] **Step 4: Report back**

Summarize what changed, what was verified, and the one open item (Residual's sheet-level write-back depending on backend confirmation) to the user directly - do not claim that part done until it's actually confirmed against the real backend.
