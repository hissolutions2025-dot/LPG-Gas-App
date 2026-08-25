# Shared Opening-Mismatch Detection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a Stock Count Opening-vs-previous-Closing mismatch visible to any Manager/Owner from any device, with the comparison baseline read live from the already-shared `day_closes` record instead of one device's local storage.

**Architecture:** A new `count_mismatches` Supabase table holds one row per branch/date/size/state/brand discrepancy, upserted by whichever device runs the diff (on an Opening commit, or on opening Count History) against yesterday's `day_closes.store_snapshot` — never stored as a separate baseline. A Manager/Owner-only badge and Count History's existing (unchanged-in-shape) mismatch panel both read from this shared table. `adjustMismatch()`'s Stock Count branch now also resolves the shared row, not just the local one.

**Tech Stack:** Vanilla JS (single-file PWA, `index.html`), Supabase (Postgres + supabase-js, `sb`), no build step, no test framework — verified via `node -e "new Function(...)"` syntax checks and live browser testing (the pattern used throughout this app's development, including the Phase 2b Stock Count pilot this plan directly builds on).

**Reference spec:** `docs/superpowers/specs/2026-08-25-shared-opening-mismatch-design.md`

---

## Before you start

Isolated worktree, same convention as the Phase 2b pilot:

```bash
git worktree add .worktrees/shared-opening-mismatch -b shared-opening-mismatch
```

Do all work inside that worktree's copy of `index.html` unless a step says otherwise (the one Supabase SQL task runs against the live project directly, not a file).

**Preview tooling note for every task below:** do NOT rely on `preview_start`/`.claude/launch.json` — it resolves against the repo root, not this worktree, and can silently serve the wrong branch (this bit a task during the Phase 2b pilot). Start your own disposable static file server pointed at this worktree's absolute path instead, e.g.:

```bash
node -e "require('http').createServer(function(req,res){res.setHeader('Cache-Control','no-store');require('fs').createReadStream('C:/Users/Freddie Du Plessis/OneDrive/Desktop/LPG-Gas-App/.worktrees/shared-opening-mismatch/index.html').pipe(res)}).listen(PORT)"
```

(pick an unused port per task). Stop the server when a task's verification is done.

---

### Task 1: Create the `count_mismatches` table + RLS

**Files:** none (Supabase SQL editor / CLI only — `supabase db query --linked --project-ref zyymnkychhglisqjvkqs "<sql>"`)

The Phase 2b pilot already established and live-verified the correct RLS pattern for this app's routine (non-high-risk) capture data: `stock_counts`' policies simply check `auth.uid() is not null` — no special permission bit exists for "Stock Count capture" in this app's `profiles.perms` model, and detection here runs as an automatic side effect of a normal commit, not a privileged action. Reuse that exact pattern.

- [ ] **Step 1: Create the table and enable RLS**

```sql
create table count_mismatches (
  id uuid primary key default gen_random_uuid(),
  branch text not null,
  date date not null,
  size text not null,
  state text not null check (state in ('Full','Empty')),
  brand text not null,
  expected numeric not null,
  counted numeric not null,
  resolved boolean not null default false,
  resolved_by uuid references profiles(id),
  resolved_by_name_snapshot text,
  resolved_at timestamptz,
  corrected_to numeric,
  resolution_reason text,
  unique (branch, date, size, state, brand)
);
alter table count_mismatches enable row level security;
```

- [ ] **Step 2: Add policies (same shape as `stock_counts`)**

```sql
create policy "count_mismatches insert by any signed-in user" on count_mismatches
for insert
with check (auth.uid() is not null);

create policy "count_mismatches update by any signed-in user" on count_mismatches
for update
using (auth.uid() is not null)
with check (auth.uid() is not null);

create policy "count_mismatches select by any signed-in user" on count_mismatches
for select
using (auth.uid() is not null);
```

- [ ] **Step 3: Verify the shape**

```sql
insert into count_mismatches (branch,date,size,state,brand,expected,counted)
values ('Helderberg','2026-08-24','9kg','Full','Afrox',45,32);
select * from count_mismatches where branch='Helderberg' and date='2026-08-24';
delete from count_mismatches where branch='Helderberg' and date='2026-08-24';
```

Expected: insert/select/delete all succeed (SQL editor runs as superuser, bypassing RLS — this only confirms the table/constraint shape; the policy itself is exercised for real in Task 8's live verification).

---

### Task 2: Add the local↔shared row translation helpers

**Files:**
- Modify: `index.html`, immediately before `function computeOpeningMismatches(br){` (currently around line 3599)

- [ ] **Step 1: Start a local test server, open it in the browser preview**

Per the preview tooling note above, pick an unused port (e.g. 8970).

- [ ] **Step 2: Confirm the helpers don't exist yet (red)**

Browser console: `typeof _countMismatchToShared` → expected `"undefined"`.

- [ ] **Step 3: Add the helpers**

```javascript
// Converts one local store._openMismatch-shaped entry into the shape count_mismatches
// expects. Only ever called for Stock-Count-kind entries (kind==='manifold' entries stay
// local-only this phase, per the design doc's explicit scope).
function _countMismatchToShared(m){
  return {branch:m.branch, date:today, size:m.size, state:m.state, brand:m.brand,
    expected:num(m.expected), counted:num(m.counted)};
}
// Converts one count_mismatches row (as returned by a Supabase select) back into the
// local store._openMismatch entry shape used by openHistory()'s existing render and by
// adjustMismatch().
function _countMismatchFromShared(d){
  return {branch:d.branch, size:d.size, state:d.state, brand:d.brand,
    expected:num(d.expected), counted:num(d.counted), resolved:!!d.resolved,
    adjustedTo:(d.corrected_to!==undefined && d.corrected_to!==null)?num(d.corrected_to):undefined,
    adjustedBy:d.resolved_by_name_snapshot||undefined,
    adjustedAt:d.resolved_at||undefined,
    adjustNote:d.resolved?('Adj by '+(d.resolved_by_name_snapshot||'?')+' → '+d.corrected_to+': '+(d.resolution_reason||'')):''};
}
```

- [ ] **Step 4: Reload, verify (green)**

```js
JSON.stringify(_countMismatchToShared({branch:'Helderberg',size:'9kg',state:'Full',brand:'Afrox',expected:45,counted:32}))
```
Expected: `{"branch":"Helderberg","date":"<today>","size":"9kg","state":"Full","brand":"Afrox","expected":45,"counted":32}`

```js
JSON.stringify(_countMismatchFromShared({branch:'Helderberg',size:'9kg',state:'Full',brand:'Afrox',expected:45,counted:32,resolved:true,corrected_to:40,resolved_by_name_snapshot:'Freddie du Plessis',resolution_reason:'Recount confirmed'}))
```
Expected: an object with `resolved:true`, `adjustedTo:40`, `adjustedBy:"Freddie du Plessis"`, `adjustNote:"Adj by Freddie du Plessis → 40: Recount confirmed"`.

- [ ] **Step 5: Syntax check + commit**

```bash
node -e "new Function(require('fs').readFileSync('index.html','utf8').match(/<script>([\s\S]*)<\/script>/)[1])"
git add index.html
git commit -m "Shared mismatch detection: add local<->shared row translation helpers"
```

---

### Task 3: Add `_dayBefore()` and the core `_refreshCountMismatches()` function

**Files:**
- Modify: `index.html`, immediately after the helpers added in Task 2

- [ ] **Step 1: Add `_dayBefore` and confirm it doesn't exist yet (red)**

Browser console: `typeof _dayBefore` → expected `"undefined"`.

- [ ] **Step 2: Add both functions**

```javascript
// One calendar day before the given YYYY-MM-DD string, computed in UTC so it's not
// sensitive to the browser's own timezone - matches computeToday()'s own use of
// toISOString() for the same reason.
function _dayBefore(dateStr){
  var d=new Date(dateStr+'T00:00:00Z');
  d.setUTCDate(d.getUTCDate()-1);
  return d.toISOString().slice(0,10);
}
// Reads yesterday's Closing figures live from the shared day_closes snapshot (never
// stored separately - see the design doc's rejection of a redundant expected_opening
// table), diffs them against today's committed Opening stock_counts rows for this
// branch, and upserts any discrepancy into the shared count_mismatches table. Also
// fetches whatever's already in count_mismatches for today, so a device that didn't do
// the diffing itself (e.g. just opened Count History) still sees what another device
// already found. Merges everything into store._openMismatch, replacing only this
// branch's Stock-Count-kind entries - manifold-kind entries (still local-only this
// phase) are left untouched. Every step degrades gracefully offline: on any failure,
// whatever store._openMismatch already had stays as-is, nothing throws, nothing blocks
// the caller.
function _refreshCountMismatches(br){
  return sb.from('day_closes').select('store_snapshot').eq('branch',br).eq('date',_dayBefore(today)).maybeSingle().then(function(dcRes){
    var exp={};
    if(dcRes.data && dcRes.data.store_snapshot && dcRes.data.store_snapshot.count){
      dcRes.data.store_snapshot.count.filter(function(r){return r.countType==='Closing';}).forEach(function(r){
        var st=(r.state==='Empty')?'Empty':'Full';
        if(!exp[r.size])exp[r.size]={Full:{},Empty:{}};
        exp[r.size][st][r.brand]=(exp[r.size][st][r.brand]||0)+num(r.qty);
      });
    }
    var op={};
    store.count.filter(function(r){return (!r.branch||r.branch===br)&&r.countType==='Opening'&&(r._date||today)===today;}).forEach(function(r){
      var st=(r.state==='Empty')?'Empty':'Full';
      if(!op[r.size])op[r.size]={Full:{},Empty:{}};
      op[r.size][st][r.brand]=(op[r.size][st][r.brand]||0)+num(r.qty);
    });
    var sizes={};Object.keys(exp).forEach(function(s){sizes[s]=1;});Object.keys(op).forEach(function(s){sizes[s]=1;});
    var freshMismatches=[];
    Object.keys(sizes).forEach(function(sz){
      ['Full','Empty'].forEach(function(st){
        var eB=(exp[sz]&&exp[sz][st])||{};var oB=(op[sz]&&op[sz][st])||{};
        var brands={};Object.keys(eB).forEach(function(b){brands[b]=1;});Object.keys(oB).forEach(function(b){brands[b]=1;});
        Object.keys(brands).forEach(function(b){
          var expected=eB[b]||0, counted=oB[b]||0;
          if(expected!==counted)freshMismatches.push({branch:br,size:sz,state:st,brand:b,expected:expected,counted:counted});
        });
      });
    });
    var upsertPromise=freshMismatches.length
      ? sb.from('count_mismatches').upsert(freshMismatches.map(_countMismatchToShared),{onConflict:'branch,date,size,state,brand'}).catch(function(){})
      : Promise.resolve();
    return upsertPromise.then(function(){
      return sb.from('count_mismatches').select('*').eq('branch',br).eq('date',today);
    });
  }).then(function(res){
    var rows=(res&&res.data)||[];
    store._openMismatch=(store._openMismatch||[]).filter(function(m){return m.branch!==br||m.kind==='manifold';});
    rows.forEach(function(d){store._openMismatch.push(_countMismatchFromShared(d));});
  }).catch(function(){
    // offline or fetch failed - whatever store._openMismatch already had stays as-is.
  });
}
```

- [ ] **Step 3: Reload, verify with a stubbed `sb.from` (green)**

```js
var origFrom=sb.from;
var upsertedRows=null;
sb.from=function(table){
  if(table==='day_closes'){
    return {select:function(){return {eq:function(){return {eq:function(){return {maybeSingle:function(){
      return Promise.resolve({data:{store_snapshot:{count:[
        {countType:'Closing',state:'Full',size:'9kg',brand:'Afrox',qty:45,branch:'Helderberg'}
      ]}}});
    }};}};}};}};
  }
  if(table==='count_mismatches'){
    return {
      upsert:function(rows){upsertedRows=rows;return Promise.resolve({error:null});},
      select:function(){return {eq:function(){return {eq:function(){
        return Promise.resolve({data:[{branch:'Helderberg',date:today,size:'9kg',state:'Full',brand:'Afrox',expected:45,counted:32,resolved:false}]});
      }};}};}
    };
  }
  return origFrom(table);
};
today='2026-08-24';
store.count=[{branch:'Helderberg',countType:'Opening',state:'Full',size:'9kg',brand:'Afrox',qty:32,_date:'2026-08-24'}];
store._openMismatch=[];
_refreshCountMismatches('Helderberg').then(function(){
  sb.from=origFrom;
  console.log(JSON.stringify({upsertedRows:upsertedRows, storeResult:store._openMismatch}));
});
```

Expected console output: `upsertedRows` contains one row (`Helderberg/9kg/Full/Afrox`, `expected:45`, `counted:32`), and `storeResult` contains one entry matching the stubbed `count_mismatches` select response (`resolved:false`).

- [ ] **Step 4: Syntax check + commit**

```bash
node -e "new Function(require('fs').readFileSync('index.html','utf8').match(/<script>([\s\S]*)<\/script>/)[1])"
git add index.html
git commit -m "Shared mismatch detection: add _refreshCountMismatches core detection function"
```

---

### Task 4: Wire the detection refresh into the commit flow and Count History

**Files:**
- Modify: `index.html:3445` (inside `_cCommitReal()`, the `computeOpeningMismatches(cBranch);` line)
- Modify: `index.html` inside `function openHistory(){` (around line 5034-5074, the mismatch panel section)

Current `_cCommitReal()` code (around line 3444-3446):

```javascript
  // #4 OPENING vs previous-day CLOSE (expected opening). Per size+brand+state exact match.
  computeOpeningMismatches(cBranch);
  var mm=(store._openMismatch||[]).filter(function(m){return m.branch===cBranch;});
```

- [ ] **Step 1: Keep the immediate local check for this commit's own toast, but also kick off the shared refresh**

Replace with:

```javascript
  // #4 OPENING vs previous-day CLOSE (expected opening). Per size+brand+state exact match.
  // computeOpeningMismatches() still runs synchronously first (unchanged) so THIS commit's
  // own toast below has an answer immediately, without waiting on a network round trip.
  // _refreshCountMismatches() then does the same comparison against the shared, live
  // day_closes baseline and upserts the durable, cross-device record - fire-and-forget,
  // offline-safe (see its own comment), never blocks this commit from completing.
  computeOpeningMismatches(cBranch);
  var mm=(store._openMismatch||[]).filter(function(m){return m.branch===cBranch;});
  _refreshCountMismatches(cBranch);
```

- [ ] **Step 2: Add the async refresh + targeted panel re-render to `openHistory()`**

Find this existing block inside `openHistory()`:

```javascript
  // #4 OPENING MISMATCH ALERTS (vs previous day close) - role-aware
  var mmList=(store._openMismatch||[]).filter(function(m){return m.branch===branch;});
  if(mmList.length){
    var isMgr=(role==='Manager'||role==='Owner');
    html+='<div class="histSection" style="border:2px solid #C0392B"><h4 style="color:#C0392B">⚠ Opening count incorrect</h4>';
    if(isMgr){
      html+='<div style="font-size:11px;color:var(--muted);margin-bottom:8px">These lines block Close Day until a Manager or Owner logs an adjustment (note required). The signed close is not changed - only today opening.</div>';
      html+='<table class="htable"><tr><th>Item</th><th>Prev close</th><th>Counted</th><th>Status</th></tr>';
      mmList.forEach(function(m,i){
        var item=(m.kind==='manifold')?('Manifold · '+m.cyl):(m.size+' · '+m.state+' · '+m.brand);
        html+='<tr'+(m.resolved?'':' style="background:#FBE9E7"')+'><td>'+item+'</td><td class="n">'+m.expected+'</td><td class="n">'+m.counted+'</td><td>'+
          (m.resolved?('<span style="color:var(--ok)">✓ corrected to '+(m.adjustedTo!==undefined?m.adjustedTo:m.counted)+'</span><div style="font-size:10px;color:var(--muted)">'+(m.adjustNote||'')+'</div>'):'<button class="sigClear" style="background:#C0392B;color:#fff" onclick="adjustMismatch('+i+')">Enter correct count</button>')+
          '</td></tr>';
      });
      html+='</table>';
    } else {
      html+='<div style="font-size:11px;color:var(--muted);margin-bottom:8px">This count is incorrect. A Manager or Owner must review before the day can be closed.</div>';
      html+='<table class="htable"><tr><th>Item</th><th>Status</th></tr>';
      mmList.forEach(function(m){
        var item=(m.kind==='manifold')?('Manifold · '+m.cyl):(m.size+' · '+m.state+' · '+m.brand);
        html+='<tr'+(m.resolved?'':' style="background:#FBE9E7"')+'><td>'+item+'</td><td>'+
          (m.resolved?'<span style="color:var(--ok)">✓ reviewed</span>':'<span style="color:#C0392B;font-weight:800">This count is incorrect</span>')+'</td></tr>';
      });
      html+='</table>';
    }
    html+='</div>';
  }
```

Replace with (identical rendering logic, extracted into a reusable function and wrapped in a container so it can be re-rendered after the async refresh, without touching anything else `openHistory()` builds):

```javascript
  // #4 OPENING MISMATCH ALERTS (vs previous day close) - role-aware. Rendered into its own
  // container (not inlined into the surrounding html string) so _refreshCountMismatches'
  // async result can update just this panel afterward, without re-rendering the rest of
  // Count History (refills, private, etc. - all synchronous and unaffected by this).
  html+='<div id="mmPanelContainer">'+_mismatchPanelHtml(branch)+'</div>';
```

- [ ] **Step 3: Add `_mismatchPanelHtml()` and `_refreshMismatchPanel()`**

Add these two functions immediately before `function openHistory(){`:

```javascript
// Pure render of the mismatch panel for one branch - identical logic to what openHistory()
// used to build inline, just callable twice (once for the initial synchronous paint from
// whatever's already in store._openMismatch, once again after the async shared refresh
// resolves).
function _mismatchPanelHtml(branch){
  var mmList=(store._openMismatch||[]).filter(function(m){return m.branch===branch;});
  if(!mmList.length)return '';
  var isMgr=(role==='Manager'||role==='Owner');
  var html='<div class="histSection" style="border:2px solid #C0392B"><h4 style="color:#C0392B">⚠ Opening count incorrect</h4>';
  if(isMgr){
    html+='<div style="font-size:11px;color:var(--muted);margin-bottom:8px">These lines block Close Day until a Manager or Owner logs an adjustment (note required). The signed close is not changed - only today opening.</div>';
    html+='<table class="htable"><tr><th>Item</th><th>Prev close</th><th>Counted</th><th>Status</th></tr>';
    mmList.forEach(function(m,i){
      var item=(m.kind==='manifold')?('Manifold · '+m.cyl):(m.size+' · '+m.state+' · '+m.brand);
      html+='<tr'+(m.resolved?'':' style="background:#FBE9E7"')+'><td>'+item+'</td><td class="n">'+m.expected+'</td><td class="n">'+m.counted+'</td><td>'+
        (m.resolved?('<span style="color:var(--ok)">✓ corrected to '+(m.adjustedTo!==undefined?m.adjustedTo:m.counted)+'</span><div style="font-size:10px;color:var(--muted)">'+(m.adjustNote||'')+'</div>'):'<button class="sigClear" style="background:#C0392B;color:#fff" onclick="adjustMismatch('+i+')">Enter correct count</button>')+
        '</td></tr>';
    });
    html+='</table>';
  } else {
    html+='<div style="font-size:11px;color:var(--muted);margin-bottom:8px">This count is incorrect. A Manager or Owner must review before the day can be closed.</div>';
    html+='<table class="htable"><tr><th>Item</th><th>Status</th></tr>';
    mmList.forEach(function(m){
      var item=(m.kind==='manifold')?('Manifold · '+m.cyl):(m.size+' · '+m.state+' · '+m.brand);
      html+='<tr'+(m.resolved?'':' style="background:#FBE9E7"')+'><td>'+item+'</td><td>'+
        (m.resolved?'<span style="color:var(--ok)">✓ reviewed</span>':'<span style="color:#C0392B;font-weight:800">This count is incorrect</span>')+'</td></tr>';
    });
    html+='</table>';
  }
  html+='</div>';
  return html;
}
// Kicks off the shared refresh and, if it finds anything different, re-renders just the
// mismatch panel container - not the whole Count History screen (avoids any risk of
// clobbering something else the user is mid-interacting with elsewhere on the page), and
// only if the user hasn't navigated away from History in the meantime.
function _refreshMismatchPanel(branch){
  _refreshCountMismatches(branch).then(function(){
    var container=document.getElementById('mmPanelContainer');
    var stillOnHistory=document.querySelector('.view.active') && document.querySelector('.view.active').id==='historyView';
    if(container && stillOnHistory && histBranch===branch)container.outerHTML='<div id="mmPanelContainer">'+_mismatchPanelHtml(branch)+'</div>';
  });
}
```

- [ ] **Step 4: Call `_refreshMismatchPanel` from `openHistory()`**

Find the line `document.getElementById('histBody').innerHTML=html;` inside `openHistory()` and add immediately after it:

```javascript
  _refreshMismatchPanel(branch);
```

- [ ] **Step 5: Reload, verify commit-flow wiring (green)**

```js
var calledWith=null;
var origRefresh=_refreshCountMismatches;
_refreshCountMismatches=function(br){calledWith=br;return Promise.resolve();};
operator='DiagTest';role='Owner';branch='Helderberg';cBranch='Helderberg';cCT='Opening';currentProfile={id:'x',name:'DiagTest',level:'Owner'};currentPerms={};today='2026-08-24';
cData={'Helderberg|Opening':{'9kg':{full:[{brand:'Afrox',qty:32,note:''}],empty:[]}}};
store={count:[]};
_cCommitReal();
new Promise(function(r){setTimeout(r,300);}).then(function(){
  _refreshCountMismatches=origRefresh;
  return JSON.stringify({calledWith:calledWith});
});
```

Expected: `{"calledWith":"Helderberg"}`.

- [ ] **Step 6: Verify Count History wiring (green)**

```js
var calledPanel=null;
var origRefreshPanel=_refreshMismatchPanel;
_refreshMismatchPanel=function(br){calledPanel=br;};
histBranch='Helderberg';branch='Helderberg';role='Owner';
store._openMismatch=[];
openHistory();
var panelExists=!!document.getElementById('mmPanelContainer');
_refreshMismatchPanel=origRefreshPanel;
JSON.stringify({calledPanel:calledPanel, panelExists:panelExists});
```

Expected: `{"calledPanel":"Helderberg","panelExists":true}`.

- [ ] **Step 7: Syntax check + commit**

```bash
node -e "new Function(require('fs').readFileSync('index.html','utf8').match(/<script>([\s\S]*)<\/script>/)[1])"
git add index.html
git commit -m "Shared mismatch detection: wire refresh into commit flow and Count History"
```

---

### Task 5: Add the Manager/Owner-only pending-mismatch badge

**Files:**
- Modify: `index.html:263` area (landing view HTML, next to the existing pending badges)
- Modify: `index.html:455` area (historyView HTML, next to the existing pending badges)
- Modify: `index.html` login flow (near the existing `_countFlushQueue();`/`_updateCountPendingBadge();` pair)
- Modify: `index.html`, add `_updateMismatchPendingBadge()` near the other badge-update functions

- [ ] **Step 1: Add the badge HTML elements**

Find the existing `id="countPendingBadge"` div on the landing view and add immediately after it:

```html
<div id="mismatchPendingBadge" style="display:none;background:#FDECC8;color:#8a5a00;font-size:12px;font-weight:800;padding:8px 12px;border-radius:10px;margin-bottom:12px"></div>
```

Find the existing `id="countPendingBadgeHistory"` div on `historyView` and add immediately after it:

```html
<div id="mismatchPendingBadgeHistory" style="display:none;background:#FDECC8;color:#8a5a00;font-size:12px;font-weight:800;padding:8px 12px;border-radius:10px;margin-bottom:12px"></div>
```

- [ ] **Step 2: Add `_updateMismatchPendingBadge()`**

Add immediately after `_updateCountPendingBadge` (search for `function _updateCountPendingBadge(){`):

```javascript
// Manager/Owner-only, unlike the sync-pending badges above - an Operator seeing "N
// mismatches" with no detail attached would just be noise; the one-line "this count is
// incorrect" tile/toast already tells them everything they're meant to know. Reads
// store._openMismatch directly rather than querying Supabase itself - whichever of
// _refreshCountMismatches's call sites ran most recently already populated it.
function _updateMismatchPendingBadge(){
  var isMgr=(role==='Manager'||role==='Owner');
  var n=isMgr?(store._openMismatch||[]).filter(function(m){return !m.resolved;}).length:0;
  var text=n?('⚠ '+n+' opening mismatch(es) need review'):'';
  ['mismatchPendingBadge','mismatchPendingBadgeHistory'].forEach(function(id){
    var el=document.getElementById(id);
    if(!el)return;
    el.style.display=n?'block':'none';
    el.textContent=text;
  });
}
```

- [ ] **Step 3: Call it on login and after both refresh paths**

Find the existing `_countFlushQueue();`/`_updateCountPendingBadge();` pair in the login flow and add immediately after:

```javascript
  _updateMismatchPendingBadge();
```

In `_refreshMismatchPanel()` (added in Task 4), add a call right after the panel re-render so the badge count stays in sync too:

```javascript
function _refreshMismatchPanel(branch){
  _refreshCountMismatches(branch).then(function(){
    var container=document.getElementById('mmPanelContainer');
    var stillOnHistory=document.querySelector('.view.active') && document.querySelector('.view.active').id==='historyView';
    if(container && stillOnHistory && histBranch===branch)container.outerHTML='<div id="mmPanelContainer">'+_mismatchPanelHtml(branch)+'</div>';
    _updateMismatchPendingBadge();
  });
}
```

(This replaces the version of `_refreshMismatchPanel` written in Task 4 Step 3 - the only change is the added `_updateMismatchPendingBadge();` call at the end.)

- [ ] **Step 4: Reload, verify (green)**

```js
role='Owner';
store._openMismatch=[{branch:'Helderberg',size:'9kg',state:'Full',brand:'Afrox',expected:45,counted:32,resolved:false}];
_updateMismatchPendingBadge();
JSON.stringify({display:document.getElementById('mismatchPendingBadge').style.display, text:document.getElementById('mismatchPendingBadge').textContent});
```
Expected: `{"display":"block","text":"⚠ 1 opening mismatch(es) need review"}`.

```js
role='Operator';
_updateMismatchPendingBadge();
document.getElementById('mismatchPendingBadge').style.display
```
Expected: `"none"` (even though the unresolved mismatch still exists - Operator never sees the count).

```js
role='Owner';
store._openMismatch[0].resolved=true;
_updateMismatchPendingBadge();
document.getElementById('mismatchPendingBadge').style.display
```
Expected: `"none"`.

- [ ] **Step 5: Syntax check + commit**

```bash
node -e "new Function(require('fs').readFileSync('index.html','utf8').match(/<script>([\s\S]*)<\/script>/)[1])"
git add index.html
git commit -m "Shared mismatch detection: add Manager/Owner-only pending-mismatch badge"
```

---

### Task 6: Update `adjustMismatch()`'s Stock Count branch to resolve the shared row

**Files:**
- Modify: `index.html`, inside `function adjustMismatch(i){`'s Stock Count (`else`) branch (currently around line 6020-6047)

- [ ] **Step 1: Add the shared resolve call**

Find this line inside `adjustMismatch()`'s Stock Count branch (the one added earlier tonight):

```javascript
      try{_stockCountsUpsert([row]);}catch(e){console.error('_stockCountsUpsert threw synchronously:',e.message);}
```

Add immediately after it (still inside the `else` block, before its closing `}`):

```javascript
      // Also resolve the shared count_mismatches row (upsert by its natural key, same
      // approach stock_counts already uses - no need to track a generated row id) so the
      // resolution is visible from any device, not just this one. Offline-safe: if this
      // fails, the local store._openMismatch entry (already marked resolved above) is
      // still correct on this device, and the next successful _refreshCountMismatches
      // call from any device will simply find the still-unresolved shared row and this
      // device's local resolution will re-apply next time this exact line gets adjusted.
      sb.from('count_mismatches').upsert([{
        branch:bc, date:today, size:sz, state:st, brand:br,
        expected:num(m.expected), counted:num(m.counted),
        resolved:true, resolved_by:(currentProfile&&currentProfile.id)||null,
        resolved_by_name_snapshot:auth.name, resolved_at:new Date().toISOString(),
        corrected_to:correct, resolution_reason:reason2.trim()
      }],{onConflict:'branch,date,size,state,brand'}).catch(function(){});
```

- [ ] **Step 2: Reload, verify (green)**

```js
var origFrom=sb.from;
var upserted=null;
sb.from=function(table){
  if(table==='count_mismatches')return {upsert:function(rows){upserted=rows;return Promise.resolve({error:null});}};
  return {upsert:function(){return Promise.resolve({error:null});},select:function(){return {eq:function(){return {eq:function(){return Promise.resolve({data:[]});};}};}}};
};
operator='DiagTest';role='Owner';branch='Helderberg';histBranch='Helderberg';currentProfile={id:'x',name:'DiagTest',level:'Owner'};currentPerms={adjust:1};today='2026-08-24';
store.count=[{countType:'Opening',state:'Full',size:'9kg',brand:'Afrox',qty:32,branch:'Helderberg',_date:'2026-08-24'}];
store._openMismatch=[{branch:'Helderberg',size:'9kg',state:'Full',brand:'Afrox',expected:45,counted:32,resolved:false}];
var origSelf=_selfReauth, origPrompt=window.prompt;
_selfReauth=function(){return Promise.resolve({name:'DiagTest',level:'Owner'});};
var n=0;window.prompt=function(){n++;return n===1?'40':'Recount confirmed';};
adjustMismatch(0);
new Promise(function(r){setTimeout(r,200);}).then(function(){
  sb.from=origFrom;_selfReauth=origSelf;window.prompt=origPrompt;
  return JSON.stringify(upserted);
});
```

Expected: one row with `resolved:true`, `corrected_to:40`, `resolution_reason:"Recount confirmed"`, `resolved_by_name_snapshot:"DiagTest"`.

- [ ] **Step 3: Syntax check + commit**

```bash
node -e "new Function(require('fs').readFileSync('index.html','utf8').match(/<script>([\s\S]*)<\/script>/)[1])"
git add index.html
git commit -m "Shared mismatch detection: adjustMismatch() resolves the shared count_mismatches row"
```

---

### Task 7: Live multi-device verification

**Files:** none (manual verification against the running app + live Supabase)

- [ ] **Step 1:** Two browser tabs pointed at this worktree's `index.html`, both against the real Supabase project (no mocking `sb.from` this time).

- [ ] **Step 2:** Log in to both tabs with real staff accounts (no official Close Day has happened yet, so this is safe against real business records) — one Manager/Owner-level account per tab is enough, same branch.

- [ ] **Step 3: Seed a real closed day to compare against.** If there's no `day_closes` row for Helderberg yesterday yet, close a test day for Helderberg with a known Closing figure for one size/brand first (e.g. 9kg Full Afrox = 45), so there's a real baseline to diff against.

- [ ] **Step 4: Trigger a mismatch.** On Tab A, commit an Opening count for that same size/brand with a different quantity (e.g. 32). Confirm Tab A's own toast fires as before.

- [ ] **Step 5: Cross-device visibility.** On Tab B (untouched, different device/tab), open Count History for that branch. Confirm the "⚠ opening mismatch(es) need review" badge appears and the red panel shows the Prev-close/Counted comparison — without Tab B having done anything itself.

- [ ] **Step 6: Operator visibility check.** Still on Tab B, switch the logged-in role to an Operator-level account (or check with one) and confirm only "This count is incorrect" shows, never the figures.

- [ ] **Step 7: Resolve from Tab B.** Tap "Enter correct count", enter the correction and a reason. Confirm it resolves locally, and confirm in the real `count_mismatches` table (via `supabase db query --linked --project-ref zyymnkychhglisqjvkqs "select * from count_mismatches where branch='Helderberg' order by resolved_at desc limit 5;"`) that the row shows `resolved:true` with the correct `corrected_to`/`resolution_reason`/`resolved_by_name_snapshot`.

- [ ] **Step 8: Confirm Tab A sees the resolution.** Reopen Count History on Tab A. Confirm it now shows "✓ corrected to N" instead of the red unresolved row.

- [ ] **Step 9: Confirm the Sheet and shared count table both got the correction** (from the fixes shipped earlier tonight, exercised here for real for the first time): check the Counts sheet tab shows the corrected figure, and check `stock_counts` (`select * from stock_counts where branch='Helderberg' and date=current_date and size='<size>' and brand='<brand>';`) shows the corrected `qty` with `corrected_from` set.

- [ ] **Step 10: Record the outcome.** Report which of the above passed, any issues found (describe precisely, don't fix inline), and clean up any test `day_closes`/`count_mismatches`/`stock_counts` rows created purely for this test if they'd otherwise confuse real data later.
