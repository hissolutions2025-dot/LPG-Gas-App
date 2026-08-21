# Phase 2b Pilot: Stock Count on Supabase — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make committed Stock Count lines visible and correctable from any device on the same day, by backing them with a new Supabase table instead of only local `store.count`, with offline-safe sync matching Close Day's proven pattern.

**Architecture:** A new `stock_counts` table (one row per committed line, upserted, no deletes) becomes the shared source of truth for "what's been committed today." Commits and corrections write to it (with an offline retry queue adapted from Close Day's). Opening the "Adjust an already-committed count" tool reads from it first (refresh-on-open, falling back to local data if offline) and merges what it finds into local `store.count` by exact line key, so the existing correction UI (`corrStepCountGroups` etc.) works completely unchanged on top of reconciled data.

**Tech Stack:** Vanilla JS (single-file PWA, `index.html`), Supabase (Postgres + supabase-js client already initialised as `sb`), no build step, no test framework — verified via `node -e "new Function(...)"` syntax checks and live browser testing against a local static file server (the pattern already used throughout this app's development).

**Reference spec:** `docs/superpowers/specs/2026-08-21-phase2b-stock-count-pilot-design.md`

---

## Before you start

This plan should be executed in an isolated git worktree, same convention as Phase 2a:

```bash
git worktree add .worktrees/phase2b-stock-count-pilot -b phase2b-stock-count-pilot
```

Do all work below inside that worktree's copy of `index.html` unless a step says otherwise (the two Supabase SQL tasks run against the live Supabase project directly, not against a file).

---

### Task 1: Inspect the existing `day_closes` RLS policy pattern

**Files:** none (Supabase SQL editor only — read-only investigation)

- [ ] **Step 1: Run this in the Supabase SQL editor for the project**

```sql
select policyname, cmd, qual, with_check
from pg_policies
where tablename = 'day_closes'
order by cmd;
```

- [ ] **Step 2: Record the output**

Copy the `qual`/`with_check` text for the `INSERT` and `SELECT` policies somewhere you can paste from in Task 2 — that's the exact permission-check expression (whatever it references — a `profiles` column, a helper function, etc.) already proven to work for gating Supabase writes/reads by the signed-in user's role/branch. Task 2 reuses this expression verbatim, swapping only the specific permission name it checks for (Stock Count capture instead of Close Day).

---

### Task 2: Create the `stock_counts` table + RLS policies

**Files:** none (Supabase SQL editor only)

- [ ] **Step 1: Create the table**

```sql
create table stock_counts (
  id uuid primary key default gen_random_uuid(),
  branch text not null,
  date date not null,
  count_type text not null check (count_type in ('Opening','Closing')),
  state text not null check (state in ('Full','Empty')),
  size text not null,
  brand text not null,
  qty numeric not null default 0,
  note text default '',
  updated_by uuid references profiles(id),
  updated_by_name_snapshot text,
  updated_at timestamptz not null default now(),
  unique (branch, date, count_type, state, size, brand)
);
alter table stock_counts enable row level security;
```

- [ ] **Step 2: Add insert/update policy**

Take the `with_check` (or `qual`, whichever the `day_closes` INSERT policy used) expression recorded in Task 1, and adapt it to check the Stock Count capture permission instead of the Close Day permission it currently checks (same expression shape, different permission name/value — whatever `day_closes`'s policy used to spell "closeday" is exactly what you're changing here to spell "count" capture instead). Then:

```sql
create policy "stock_counts_upsert" on stock_counts
for all
using (<adapted expression from day_closes, checking Stock Count capture permission for auth.uid() and stock_counts.branch>)
with check (<same expression>);
```

- [ ] **Step 3: Add select policy**

Same approach, using the `day_closes` SELECT policy's expression as the template:

```sql
create policy "stock_counts_select" on stock_counts
for select
using (<adapted expression from day_closes SELECT policy, checking Stock Count capture/view permission for auth.uid() and stock_counts.branch>);
```

- [ ] **Step 4: Verify from the SQL editor**

```sql
insert into stock_counts (branch,date,count_type,state,size,brand,qty)
values ('Helderberg','2026-08-21','Opening','Full','5kg','Afrox',3);

select * from stock_counts where branch='Helderberg' and date='2026-08-21';

delete from stock_counts where branch='Helderberg' and date='2026-08-21';
```

Expected: insert succeeds (you're running as the Postgres superuser in the SQL editor, which bypasses RLS — this just confirms the table/constraint shape is correct, not the policy itself). The real policy check happens implicitly once the app starts using it in Task 9/10's live verification.

---

### Task 3: Add shared-row mapping + reconcile helpers

**Files:**
- Modify: `index.html`, immediately before `function _cCommitReal(){` (currently around line 3290)

- [ ] **Step 1: Start a local test server and open it in the browser preview**

```bash
node -e "require('http').createServer(function(req,res){require('fs').createReadStream('index.html').pipe(res)}).listen(8800)"
```

Open `http://localhost:8800/index.html` in the browser preview tool. Use the browser console (via the preview tool's JS execution) for every verification step below — this app has no test framework, so a controlled browser console run against known globals is this codebase's equivalent of a unit test.

- [ ] **Step 2: Confirm the helpers don't exist yet (red)**

Run in the browser console:

```js
typeof _stockCountToSharedRow
```

Expected: `"undefined"`.

- [ ] **Step 3: Add the mapping + reconcile functions**

Insert this directly before `function _cCommitReal(){`:

```javascript
// Converts one local store.count-shaped row into the shape stock_counts expects
// (snake_case columns, ISO date, current operator as the updater) - the write side
// of the local <-> shared translation.
function _stockCountToSharedRow(r){
  return {branch:r.branch, date:r._date||today, count_type:r.countType, state:r.state,
    size:r.size, brand:r.brand, qty:num(r.qty), note:r.note||'',
    updated_by:(currentProfile&&currentProfile.id)||null,
    updated_by_name_snapshot:operator||'', updated_at:new Date().toISOString()};
}
// Converts one stock_counts row (as returned by a Supabase select) back into the
// local store.count row shape - the read side of the translation.
function _stockCountFromSharedRow(d){
  return {branch:d.branch, countType:d.count_type, state:d.state, size:d.size,
    brand:d.brand, qty:d.qty, note:d.note||'', _date:d.date, _time:d.updated_at,
    _operator:d.updated_by_name_snapshot||'', _role:''};
}
// Merges shared (Supabase) rows into local store.count by exact line key
// (branch|countType|size|state|brand) - same merge-by-line-key logic _cCommitReal
// uses for its own commits, reused here so a line committed by ANOTHER device
// correctly overwrites/adds to this device's local copy without touching any
// unrelated line.
function _reconcileSharedCountRows(sharedRows){
  var localRows=sharedRows.map(_stockCountFromSharedRow);
  var touchedKeys={};
  localRows.forEach(function(r){touchedKeys[r.branch+'|'+r.countType+'|'+r.size+'|'+r.state+'|'+r.brand]=true;});
  store.count=store.count.filter(function(r){
    return !touchedKeys[(r.branch||'')+'|'+r.countType+'|'+r.size+'|'+r.state+'|'+r.brand];
  }).concat(localRows);
}
```

- [ ] **Step 4: Reload the page, verify (green)**

Reload `http://localhost:8800/index.html`, then in the console:

```js
JSON.stringify(_stockCountToSharedRow({branch:'Helderberg',countType:'Opening',state:'Full',size:'5kg',brand:'Afrox',qty:3,note:'',_date:'2026-08-21'}))
```

Expected: an object with `branch:"Helderberg", date:"2026-08-21", count_type:"Opening", state:"Full", size:"5kg", brand:"Afrox", qty:3`.

```js
store.count=[{branch:'Helderberg',countType:'Opening',state:'Full',size:'9kg',brand:'Afrox',qty:9,_date:today}];
_reconcileSharedCountRows([{branch:'Helderberg',date:today,count_type:'Opening',state:'Full',size:'5kg',brand:'Afrox',qty:3,note:'',updated_by_name_snapshot:'Test',updated_at:new Date().toISOString()}]);
JSON.stringify(store.count.map(function(r){return r.size+' '+r.qty;}))
```

Expected: `["9kg 9","5kg 3"]` — the existing 9kg line survives untouched, the shared 5kg line is added.

- [ ] **Step 5: Syntax check + commit**

```bash
node -e "new Function(require('fs').readFileSync('index.html','utf8').match(/<script>([\s\S]*)<\/script>/)[1])"
git add index.html
git commit -m "Stock Count pilot: add local<->shared row mapping + reconcile helpers"
```

---

### Task 4: Add the offline retry queue for Stock Count sync

**Files:**
- Modify: `index.html`, immediately after the helpers added in Task 3

- [ ] **Step 1: Confirm the queue functions don't exist yet (red)**

In the browser console: `typeof _countQueueLoad` → expected `"undefined"`.

- [ ] **Step 2: Add the queue functions**

Adapted from `_closeDayQueueLoad`/`Save`/`Remove`/`Flush` (around line 5033) — the key difference is that Stock Count can be committed to many times a day, so each queued item is its own entry with a generated id, not one entry per branch+date:

```javascript
function _countQueueKey(){return 'gs_stockcount_pending';}
function _countQueueLoad(){
  try{return JSON.parse(localStorage.getItem(_countQueueKey())||'[]');}
  catch(e){console.error('Pending Stock Count sync queue was corrupted and could not be read:',e.message);return [];}
}
function _countQueueSave(q){
  try{localStorage.setItem(_countQueueKey(),JSON.stringify(q));}
  catch(e){
    console.error('Could not save the pending Stock Count sync queue:',e.message);
    toast('Could not save a pending sync record — device storage may be full. Free up space and reopen the app.',true);
  }
}
function _countQueuePush(sharedRows){
  var q=_countQueueLoad();
  q.push({id:nowStamp()+'-'+Math.random().toString(36).slice(2,8), rows:sharedRows});
  _countQueueSave(q);
  _updateCountPendingBadge();
}
function _countQueueRemove(id){
  var q=_countQueueLoad();
  var idx=q.findIndex(function(e){return e.id===id;});
  if(idx>-1){q.splice(idx,1);_countQueueSave(q);}
}
function _countFlushQueue(){
  var q=_countQueueLoad();
  if(!q.length)return;
  q.forEach(function(entry){
    sb.from('stock_counts').upsert(entry.rows,{onConflict:'branch,date,count_type,state,size,brand'}).then(function(res){
      if(!res.error){_countQueueRemove(entry.id);_updateCountPendingBadge();}
      // any error: leave it queued, already-current in localStorage - retried next flush.
    }).catch(function(){
      // network-level failure - leave it queued, try again next flush.
    });
  });
}
window.addEventListener('online',_countFlushQueue);
// Defined here (not left until the badge-HTML task) because _countQueuePush and
// _countFlushQueue above already call it - Task 6 only adds the HTML elements this
// reads and wires the call sites; before that HTML exists, this is just a safe no-op
// (getElementById returns null, the forEach body returns early).
function _updateCountPendingBadge(){
  var n=_countQueueLoad().length;
  var text=n?('⏳ '+n+' count update(s) waiting to sync'):'';
  ['countPendingBadge','countPendingBadgeHistory'].forEach(function(id){
    var el=document.getElementById(id);
    if(!el)return;
    el.style.display=n?'block':'none';
    el.textContent=text;
  });
}
```

- [ ] **Step 3: Reload, verify queue push/remove (green)**

```js
localStorage.removeItem('gs_stockcount_pending');
_countQueuePush([{branch:'Helderberg',date:'2026-08-21',count_type:'Opening',state:'Full',size:'5kg',brand:'Afrox',qty:3}]);
JSON.parse(localStorage.getItem('gs_stockcount_pending')).length
```

Expected: `1`.

```js
var q=_countQueueLoad();
_countQueueRemove(q[0].id);
JSON.parse(localStorage.getItem('gs_stockcount_pending')).length
```

Expected: `0`.

- [ ] **Step 4: Syntax check + commit**

```bash
node -e "new Function(require('fs').readFileSync('index.html','utf8').match(/<script>([\s\S]*)<\/script>/)[1])"
git add index.html
git commit -m "Stock Count pilot: add offline retry queue for shared sync"
```

---

### Task 5: Add `_stockCountsUpsert` (the write function commit + correction both call)

**Files:**
- Modify: `index.html`, immediately after the queue functions added in Task 4

- [ ] **Step 1: Add the function**

```javascript
// Upserts committed/corrected local rows into the shared stock_counts table.
// Called from both _cCommitReal() (a normal commit) and openCountAdjust()'s onApply
// (a correction) - same write path either way, offline-safe via the queue above.
function _stockCountsUpsert(freshRows){
  if(!freshRows||!freshRows.length)return;
  var sharedRows=freshRows.map(_stockCountToSharedRow);
  sb.from('stock_counts').upsert(sharedRows,{onConflict:'branch,date,count_type,state,size,brand'}).then(function(res){
    if(res.error){
      console.error('stock_counts upsert failed, queuing:',res.error.message);
      _countQueuePush(sharedRows);
    }
  }).catch(function(){
    _countQueuePush(sharedRows);
  });
}
```

- [ ] **Step 2: Reload, verify it queues on failure (green)**

Simulate an offline/error condition by stubbing `sb.from` before calling it:

```js
localStorage.removeItem('gs_stockcount_pending');
var origFrom=sb.from;
sb.from=function(t){return {upsert:function(){return Promise.resolve({error:{message:'simulated failure'}});}};};
_stockCountsUpsert([{branch:'Helderberg',countType:'Opening',state:'Full',size:'5kg',brand:'Afrox',qty:3,note:'',_date:'2026-08-21'}]);
setTimeout(function(){
  sb.from=origFrom;
  console.log('queued:',JSON.parse(localStorage.getItem('gs_stockcount_pending')).length);
},50);
```

Expected (after the timeout fires): `queued: 1`.

- [ ] **Step 3: Syntax check + commit**

```bash
node -e "new Function(require('fs').readFileSync('index.html','utf8').match(/<script>([\s\S]*)<\/script>/)[1])"
git add index.html
git commit -m "Stock Count pilot: add _stockCountsUpsert write path"
```

---

### Task 6: Wire the pending badge into app startup, reconnect, and History

**Files:**
- Modify: `index.html:263` (landing view HTML)
- Modify: `index.html:455` (historyView HTML)
- Modify: `index.html` around line 2542-2543 (login flow)
- Modify: `index.html` around line 4763 (`openHistory()`)

`_updateCountPendingBadge` itself was already added in Task 4 (it's called from
`_countQueuePush`/`_countFlushQueue`, so it had to exist before this task). This task
only adds the HTML it reads and wires the call sites so it actually runs at the right
moments.

- [ ] **Step 1: Add the badge HTML elements**

At `index.html:263`, immediately after the existing `closeDayPendingBadge` div:

```html
<div id="countPendingBadge" style="display:none;background:#FDECC8;color:#8a5a00;font-size:12px;font-weight:800;padding:8px 12px;border-radius:10px;margin-bottom:12px"></div>
```

At `index.html:455`, immediately after the existing `closeDayPendingBadgeHistory` div:

```html
<div id="countPendingBadgeHistory" style="display:none;background:#FDECC8;color:#8a5a00;font-size:12px;font-weight:800;padding:8px 12px;border-radius:10px;margin-bottom:12px"></div>
```

- [ ] **Step 2: Call it on login and reconnect**

At `index.html` around line 2542-2543, right after the existing `_closeDayFlushQueue();` / `_updateCloseDayPendingBadge();` pair, add:

```javascript
  _countFlushQueue();
  _updateCountPendingBadge();
```

- [ ] **Step 3: Call it when History opens**

At `index.html` around line 4763, right after `_updateCloseDayPendingBadge();` inside `function openHistory(){`, add:

```javascript
  _updateCountPendingBadge();
```

- [ ] **Step 4: Reload, verify the badge renders (green)**

```js
localStorage.setItem('gs_stockcount_pending', JSON.stringify([{id:'x',rows:[]}]));
_updateCountPendingBadge();
document.getElementById('countPendingBadge').style.display
```

Expected: `"block"`, and `document.getElementById('countPendingBadge').textContent` contains `"1 count update(s) waiting to sync"`.

```js
localStorage.removeItem('gs_stockcount_pending');
_updateCountPendingBadge();
document.getElementById('countPendingBadge').style.display
```

Expected: `"none"`.

- [ ] **Step 5: Syntax check + commit**

```bash
node -e "new Function(require('fs').readFileSync('index.html','utf8').match(/<script>([\s\S]*)<\/script>/)[1])"
git add index.html
git commit -m "Stock Count pilot: wire pending-sync badge into startup, reconnect, History"
```

---

### Task 7: Wire the write path into the commit flow (`_cCommitReal`)

**Files:**
- Modify: `index.html:3290` (`_cCommitReal`)

- [ ] **Step 1: Add the call**

Inside `_cCommitReal()`, right after the existing branch-sync loop:

```javascript
  Object.keys(branchesInCommit).forEach(function(bn){
    var rowsForBn=syncRowsCount(store.count.filter(function(r){return r.branch===bn;}),bn);
    syncPush('Counts', rowsForBn.map(function(x){x._replaceKey=(x.date+'|'+x.branch);return x;}));
  });
```

add immediately after this block (still inside `_cCommitReal`, before the `cData={};cSaveDraft();` line):

```javascript
  // New: push this commit's touched lines into the shared stock_counts table too,
  // so any device can see them - offline-safe via _stockCountsUpsert's own queue.
  _stockCountsUpsert(freshRows);
```

- [ ] **Step 2: Reload, verify a commit calls the upsert (green)**

```js
var origUpsert=_stockCountsUpsert, called=null;
_stockCountsUpsert=function(rows){called=rows;};
cData={'Helderberg|Opening':{'5kg':{full:[{brand:'Afrox',qty:4,note:''}],empty:[]}}};
cBranch='Helderberg';cCT='Opening';today='2026-08-21';operator='Test';role='Operator';
store={count:[]};
_cCommitReal();
_stockCountsUpsert=origUpsert;
JSON.stringify(called&&called.map(function(r){return r.size+' '+r.qty;}))
```

Expected: `["5kg 4"]`.

- [ ] **Step 3: Syntax check + commit**

```bash
node -e "new Function(require('fs').readFileSync('index.html','utf8').match(/<script>([\s\S]*)<\/script>/)[1])"
git add index.html
git commit -m "Stock Count pilot: commit flow now syncs to shared stock_counts table"
```

---

### Task 8: Fix the Adjust tab's visibility gate

**Files:**
- Modify: `index.html:3046-3049` (inside `cRenderGrid`)

- [ ] **Step 1: Replace the local-only gating condition**

Current code:

```javascript
  var _cal=document.getElementById('cAdjustLink');
  if(_cal){
    var _hasCommittedToday=store.count.some(function(r){return r.branch===cBranch && (r._date||today)===today;});
    _cal.style.display=(_hasCommittedToday && !loadSavedDay(today,cBranch))?'block':'none';
```

Replace with:

```javascript
  var _cal=document.getElementById('cAdjustLink');
  if(_cal){
    // Show whenever the day isn't closed yet - don't gate on local knowledge of what's
    // committed. A device that hasn't committed anything itself today may still have
    // something to adjust that another device committed; openCountAdjust() checks the
    // shared truth itself and tells the user plainly if there's genuinely nothing yet.
    _cal.style.display=(!loadSavedDay(today,cBranch))?'block':'none';
```

- [ ] **Step 2: Reload, verify the tab shows even with no local commits (green)**

```js
store.count=[];today='2026-08-21';cBranch='Helderberg';
cRenderGrid();
document.getElementById('cAdjustLink').style.display
```

Expected: `"block"` (previously would have been `"none"` with an empty `store.count`).

- [ ] **Step 3: Syntax check + commit**

```bash
node -e "new Function(require('fs').readFileSync('index.html','utf8').match(/<script>([\s\S]*)<\/script>/)[1])"
git add index.html
git commit -m "Stock Count pilot: Adjust tab no longer hides based on local-only knowledge"
```

---

### Task 9: Wire the read path into `openCountAdjust` (fetch + reconcile + fallback)

**Files:**
- Modify: `index.html:4192` (`openCountAdjust`)

- [ ] **Step 1: Replace the function**

Current:

```javascript
function openCountAdjust(){
  if(loadSavedDay(today,cBranch)){toast('Day already closed for '+cBranch+' - use the correction tool from Count History instead',true);return;}
  var todaysStore={count:store.count.filter(function(r){return r.branch===cBranch && (r._date||today)===today;})};
  openCorrection({
    title:'Adjust Stock Count ('+cCT+') — '+cBranch+' (today, before close)',
    store:todaysStore, branch:cBranch, sections:[cCT],
    onApply:function(sel,oldVal,newVal,reason,auth){
      syncPush('Adjustments',[{date:today,branch:cBranch,Kind:'SameDayCountAdjustment',Line:sel.tag,From:oldVal,To:newVal,Reason:reason,By:auth.name+' ('+auth.level+')'}]);
      saveWorkingStore();
      auditLog('Stock Count adjusted (same day)',cBranch+' '+sel.tag+': '+oldVal+' → '+newVal+' by '+auth.name+' - '+reason,{was:oldVal},{now:newVal});
      var rowsForBn=syncRowsCount(store.count.filter(function(r){return r.branch===cBranch;}),cBranch);
      syncPush('Counts', rowsForBn.map(function(x){x._replaceKey=(x.date+'|'+x.branch);return x;}));
    },
    afterClose:function(){
      cRenderGrid();
      if(document.querySelector('.view.active')&&document.querySelector('.view.active').id==='historyView')openHistory();
    }
  });
}
```

Replace with:

```javascript
function openCountAdjust(){
  if(loadSavedDay(today,cBranch)){toast('Day already closed for '+cBranch+' - use the correction tool from Count History instead',true);return;}
  // Refresh-on-open: pull today's committed lines for this branch from the shared
  // table first, merging anything found into local store.count, so the picker below
  // shows what's been committed from ANY device today, not just this one. If the
  // fetch fails (offline, etc.) the .catch swallows it and we proceed with whatever
  // this device already knows locally - same graceful-degradation approach Close Day
  // uses, never blocking the tool from opening.
  sb.from('stock_counts').select('*').eq('branch',cBranch).eq('date',today).then(function(res){
    if(res.data && res.data.length)_reconcileSharedCountRows(res.data);
  }).catch(function(){}).then(function(){
    var todaysStore={count:store.count.filter(function(r){return r.branch===cBranch && (r._date||today)===today;})};
    if(!todaysStore.count.length){toast('Nothing committed yet today for '+cBranch,true);return;}
    openCorrection({
      title:'Adjust Stock Count ('+cCT+') — '+cBranch+' (today, before close)',
      store:todaysStore, branch:cBranch, sections:[cCT],
      onApply:function(sel,oldVal,newVal,reason,auth){
        syncPush('Adjustments',[{date:today,branch:cBranch,Kind:'SameDayCountAdjustment',Line:sel.tag,From:oldVal,To:newVal,Reason:reason,By:auth.name+' ('+auth.level+')'}]);
        saveWorkingStore();
        auditLog('Stock Count adjusted (same day)',cBranch+' '+sel.tag+': '+oldVal+' → '+newVal+' by '+auth.name+' - '+reason,{was:oldVal},{now:newVal});
        var rowsForBn=syncRowsCount(store.count.filter(function(r){return r.branch===cBranch;}),cBranch);
        syncPush('Counts', rowsForBn.map(function(x){x._replaceKey=(x.date+'|'+x.branch);return x;}));
        // New: push the reconciled full current-day picture for this branch into the
        // shared table too - same "send everything for the branch+day" idempotent
        // philosophy as the Sheet replace-set line right above, offline-safe via
        // _stockCountsUpsert's own queue.
        _stockCountsUpsert(store.count.filter(function(r){return r.branch===cBranch && (r._date||today)===today;}));
      },
      afterClose:function(){
        cRenderGrid();
        if(document.querySelector('.view.active')&&document.querySelector('.view.active').id==='historyView')openHistory();
      }
    });
  });
}
```

- [ ] **Step 2: Reload, verify reconcile-then-open (green)**

```js
var origFrom=sb.from;
sb.from=function(t){
  return {select:function(){return {eq:function(){return {eq:function(){
    return Promise.resolve({data:[{branch:'Helderberg',date:'2026-08-21',count_type:'Opening',state:'Full',size:'19kg',brand:'Afrox',qty:7,note:'',updated_by_name_snapshot:'OtherDevice',updated_at:new Date().toISOString()}]});
  }};}};};
};
today='2026-08-21';cBranch='Helderberg';cCT='Opening';store.count=[];
openCountAdjust();
setTimeout(function(){
  sb.from=origFrom;
  console.log('reconciled:',store.count.map(function(r){return r.size+' '+r.qty;}));
},100);
```

Expected (after timeout): `reconciled: ["19kg 7"]` — a line this device never locally committed is now present, sourced entirely from the (stubbed) shared fetch.

- [ ] **Step 3: Verify the offline-fallback path doesn't block opening**

```js
sb.from=function(t){return {select:function(){return {eq:function(){return {eq:function(){return Promise.reject(new Error('offline'));}};}};}};};
store.count=[{branch:'Helderberg',countType:'Opening',state:'Full',size:'5kg',brand:'Afrox',qty:2,_date:'2026-08-21'}];
openCountAdjust();
setTimeout(function(){
  sb.from=origFrom;
  console.log('modal open:',document.getElementById('corrModal').classList.contains('show'));
},100);
```

Expected (after timeout): `modal open: true` — the local-only line was enough to proceed even though the shared fetch failed.

- [ ] **Step 4: Syntax check + commit**

```bash
node -e "new Function(require('fs').readFileSync('index.html','utf8').match(/<script>([\s\S]*)<\/script>/)[1])"
git add index.html
git commit -m "Stock Count pilot: Adjust tool reads shared truth on open, falls back to local offline"
```

---

### Task 10: Live multi-device verification

**Files:** none (manual verification against the running app + live Supabase)

- [ ] **Step 1: Stop the local file-only server from Task 3**, and instead run the app pointed at the real Supabase project (same `SUPABASE_URL`/anon key already in `index.html` — no code change needed, just don't stub `sb.from` this time).

- [ ] **Step 2: Simulate two devices** using two browser tabs (or two profiles) logged in as the same branch.

- [ ] **Step 3: Commit → cross-device visibility**

In Tab A: commit a Stock Count for Helderberg (any size/brand). In Tab B: open Stock Count → tap "Adjust an already-committed count" → confirm the line committed in Tab A appears.

Expected: it appears without needing to refresh anything beyond opening the Adjust tool.

- [ ] **Step 4: Offline commit → queued → syncs on reconnect**

In Tab A: use the browser devtools' network throttling to go offline, commit a Stock Count. Confirm the "N waiting to sync" badge appears on the landing page. Go back online. Confirm the badge clears within a few seconds (via `window.addEventListener('online', ...)` firing `_countFlushQueue`). Then in Tab B: confirm the line is now visible via the Adjust tool.

- [ ] **Step 5: Correction applied while offline**

Repeat step 4's offline toggle, but this time make a correction via the Adjust tool (not a fresh commit) while offline. Confirm the same queue/badge/reconnect behavior.

- [ ] **Step 6: Closed-day correction flow unaffected**

Close a day for a test branch/date, then use the existing 48-hour correction tool from Count History on that closed day. Confirm it still works exactly as before (it never touches `stock_counts`).

- [ ] **Step 7: Record the outcome**

If all six checks pass, this pilot is proven. Report back with what was verified before merging/pushing (see `superpowers:finishing-a-development-branch`).
