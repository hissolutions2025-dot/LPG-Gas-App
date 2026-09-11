# Verified Stock Takes + Auditor Role (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a neutral counter (the "Auditor") capture a full physical stock take — every size, brand, Full/Empty, and the Manifold — into the app, dual-signed (joint mode) or Auditor-only (solo mode), on any date, stored separately from the daily Operator flow, with an immediate same-day comparison against the Operator's own Closing count.

**Architecture:** New `verified_stock_takes` Supabase table (one row per take, `count` + `manifold` as jsonb, both signatures, a `mode` discriminator). New `Auditor` role — a 4th `level` string, no Edge Function change needed (the `manage-user` function stores `level` verbatim and only special-cases `'Owner'`). New standalone capture screen that visually matches the daily count/manifold grids but has its OWN state and commit path — it never touches `store.count` / `store.manifold` / the daily commit flow / `stock_counts` / `manifold_live_rows`, so regression risk to the live daily flow is zero. Sheets mirror via two new append-only tabs (`VerifiedCounts`, `VerifiedManifold`) through the existing generic TABS writer — a verified take is committed once, atomically, never updated, so no custom Apps Script action is needed (unlike Branch Transfers). Owner-only during build; a small follow-up opens it to the real `Auditor` role.

**Tech Stack:** Vanilla JS (single-file `index.html`), Supabase (Postgres + RLS), Google Apps Script (the bound script behind the `sheets-sync` proxy).

**Deliberate refinement of the spec:** the spec (`docs/superpowers/specs/2026-09-09-stock-balance-management-design.md`, Phase 1) says "reuse the exact same capture UI as daily counts" (`openCount`/`cRenderGrid`, the Manifold capture). This plan reuses the **visual pattern and the pure data helpers** (`ALLSIZES`, `BRANDS`, the per-size row layout, `num()`, `_nowISO()`), but NOT the stateful `openCount` / `cRenderGrid` / `openCap('manifold')` controllers — those are wired into `store.count`/`store.manifold`, the daily draft autosave, live mismatch/cutoff warnings, the Close Day gates and `syncRowsCount`/`syncRowsManifold`. A verified take wants none of that. Same regression-avoidance reasoning that shaped Phase 2 (Branch Transfers) — build a clean, self-contained capture rather than overload the load-bearing daily machinery. If the reviewer wants literal `cRenderGrid` reuse instead, raise it before Task 5.

**Depends on:** nothing from Phase 2 (Branch Transfers). Phase 2's one-shot signature helper (`_initXferSigCanvas`) is on an unmerged branch, so this plan defines its own equivalent (`_initVstSigCanvas`). If Phase 2 merges first, a later cleanup can dedupe the two.

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/20260911000000_verified_stock_takes.sql` | new table + RLS (Task 1) |
| the bound Apps Script (external, pasted by owner) | `VerifiedCounts` + `VerifiedManifold` tab schema, v17 (Task 2) |
| `index.html` — Manage Users block (`ueLevel`, `permPreset`, `ueLevelChanged`, `PERM_KEYS`) | the `Auditor` role (Task 3) |
| `index.html` — new self-contained block after the Branch-Transfers block (or after `openReceived` if Phase 2 not merged) | data layer: `_pushVerifiedTake`, `_fetchVerifiedTakeComparison`, `_vstSig` / `_initVstSigCanvas` (Task 4) |
| `index.html` — new `verifiedTakeView` screen div + its JS controller | the capture UI (Task 5) |
| `index.html` — tile markup, `_finishLogin` tile-visibility block, the login landing branch | tile + rollout gate + Auditor-lands-here (Task 6) |

---

### Task 1: `verified_stock_takes` Supabase table

**Files:**
- Create: `supabase/migrations/20260911000000_verified_stock_takes.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Verified Stock Takes (Phase 1 of docs/superpowers/specs/2026-09-09-stock-balance-management-design.md)
-- One row per joint/solo Auditor stock take. Separate table - never touches
-- stock_counts / manifold_live_rows / the daily flow.
CREATE TABLE IF NOT EXISTS verified_stock_takes (
  id uuid primary key default gen_random_uuid(),
  branch text not null,
  date text not null,                     -- 'YYYY-MM-DD', same convention as stock_counts.date
  mode text not null,                     -- 'joint' | 'solo'
  count jsonb not null,                   -- [{size,brand,state,qty,note}]
  manifold jsonb not null,                -- [{cyl,brand,gasType,scale,tare,gasLeft,cylState,notes}]
  auditor_id uuid references profiles(id),
  auditor_name_snapshot text,
  auditor_sig text,                       -- data URL
  operator_id uuid references profiles(id),          -- null when mode='solo'
  operator_name_snapshot text,                       -- null when mode='solo'
  operator_sig text,                                 -- null when mode='solo'
  committed_at timestamptz default now()
);
CREATE INDEX IF NOT EXISTS verified_stock_takes_branch_date_idx ON verified_stock_takes (branch, date);

ALTER TABLE verified_stock_takes ENABLE ROW LEVEL SECURITY;
CREATE POLICY verified_stock_takes_select ON verified_stock_takes FOR SELECT TO authenticated USING (true);
CREATE POLICY verified_stock_takes_insert ON verified_stock_takes FOR INSERT TO authenticated WITH CHECK (true);
```

(No UPDATE policy — a verified take is immutable once committed. Matches `stock_counts`' permissive-select/insert shape; role scope is enforced client-side, same as every other table in this app.)

- [ ] **Step 2: Apply it**

```bash
supabase db push --linked
```
Expected: `Applying migration 20260911000000_verified_stock_takes.sql...` then success.

- [ ] **Step 3: Verify**

```powershell
supabase db query --linked -o json "select column_name,data_type,is_nullable from information_schema.columns where table_name='verified_stock_takes' order by ordinal_position;"
supabase db query --linked -o json "select policyname,cmd from pg_policies where tablename='verified_stock_takes';"
```
Expected: 13 columns matching the migration; 2 policies (`select`, `insert`).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260911000000_verified_stock_takes.sql
git commit -m "feat: verified_stock_takes table (Phase 1 — Verified Stock Takes)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

> **Note (from Task 1 review, already applied):** the review caught a real defect
> before it reached Task 4 — `id` is a server-generated `uuid` PK, but Task 4's
> `_pushVerifiedTake` (below) was originally written to preset `id` with a
> client-generated string (`'vst_...'`), which fails a `uuid` type cast against real
> Postgres. Fixed with a follow-up migration
> `20260911000001_verified_stock_takes_client_row_id.sql` — a separate
> `client_row_id text` column with a partial unique index (`WHERE client_row_id IS
> NOT NULL`), same pattern as `stock_transfers.row_id` from Branch Transfers.
> **`id` stays server-generated and untouched; `client_row_id` is what the client
> generates, uses for idempotent-retry detection, and sends as the Sheets `TakeId`.**
> This migration is already written, applied, and committed (`af3b997` → follow-up
> commit on the same branch) — Task 4's code below already reflects it.

---

### Task 2: Apps Script — `VerifiedCounts` + `VerifiedManifold` tabs (v17)

**Files:**
- Modify: the bound Apps Script (external — the owner pastes the full updated file, same as the v15/v16 workflow).

- [ ] **Step 1: Add the two tab schemas**

In the `TABS` map, add:
```javascript
VerifiedCounts:   ['Auditor','Operator','Mode','CountType','State','Size','Brand','Qty','Note','TakeId'],
VerifiedManifold: ['Auditor','Operator','Mode','Cylinder','Brand','GasType','Scale','Tare','GasLeft','Condition','Note','TakeId'],
```
In the `HEADERS` map, add:
```javascript
VerifiedCounts:   ['Timestamp','Date','Time','Branch','Auditor','Operator','Mode','Count Type','State','Size','Brand','Qty','Note','Take Id'],
VerifiedManifold: ['Timestamp','Date','Time','Branch','Auditor','Operator','Mode','Cylinder','Brand','Gas Type','Cyl Scale (kg)','Cyl Tare (kg)','Gas Left (kg)','Condition','Note','Take Id'],
```
(`CountType` is a fixed literal `'Verified'` on every row — it's there so a human filtering the tab, and any future recon formula, can tell these apart from Opening/Closing at a glance without joining to the daily `Counts` tab. `TakeId` = the client-generated `verified_stock_takes.client_row_id` — NOT the server-generated `id` — so all the rows of one take group together.)

No new `doPost` action and no migration function — these tabs are written through the existing generic TABS writer (`syncPush('VerifiedCounts', rows)` → `{type:'VerifiedCounts', rows}` → generic append). The tabs auto-create via `setupSheets()` the first time a row is written (the generic writer already calls `setupSheets()` when `sh.getLastRow()===0`).

- [ ] **Step 2: Bump the version**

Change `doGet`'s message to `'Gas Sales v17 endpoint live'`. Add a v17 changelog paragraph at the top of the file the same way v16's was written (explaining the two Verified Stock Take tabs, append-only, no action/migration needed).

- [ ] **Step 3: Deploy + verify**

Deploy → Manage deployments → edit → New version → Deploy. Confirm the `/exec` URL returns `{"ok":true,"msg":"Gas Sales v17 endpoint live"}`. (Optionally run `setupSheets()` by hand once to create both tabs and eyeball their header rows before the app ever writes to them.)

---

### Task 3: The `Auditor` role

**Files:**
- Modify: `index.html` — search for each anchor by name.

- [ ] **Step 1: Add `Auditor` to the level dropdown**

Find `<select class="mField" id="ueLevel" onchange="ueLevelChanged()">` (currently `<option>Operator</option><option>Manager</option><option>Owner</option>`). Add `<option>Auditor</option>` after `Operator` (so the order reads Operator, Auditor, Manager, Owner — least to most privilege, Auditor being a narrow sideways role).

- [ ] **Step 2: Add the `verifiedCount` permission key**

Find `var PERM_KEYS=[...]`. Append `'verifiedCount'` to the array. Find `var PERM_LABELS={...}` and add `verifiedCount:'Verified Stock Take — capture'`.

- [ ] **Step 3: Add the `permPreset('Auditor')` branch**

Find `function permPreset(level){`. Add, before the final `return` (the Operator default):
```javascript
  if(level==='Auditor') return {view:1,verifiedCount:1};
```
(An Auditor gets `view` — so nothing that gates on "can this account see the app at all" breaks — and `verifiedCount`, and NOTHING else. No `capture`, no `closeday`, no `history`, no faulty/residual/suppliers. Every existing tile's `perm(...)` check will therefore hide it for an Auditor automatically.)

Also find `function userPerms(u){` — confirm nothing in it force-grants perms for a non-Owner level (it currently only force-grants for `u.level==='Owner'`). No change needed, just verify.

- [ ] **Step 4: Branch-assignment UI for an Auditor**

Find `function ueLevelChanged(){`. It currently has an `if(lvl==='Owner'){...return;}`, an `if(lvl==='Manager'){...}`, and an `else {...}` (Operator). Add an `Auditor` case that behaves like `Manager` (one or both branches — an Auditor may audit either site):
```javascript
  if(lvl==='Manager'||lvl==='Auditor'){
    wrap.innerHTML='<label style="display:block;margin-bottom:6px"><input type="checkbox" class="ueBr" value="Helderberg"> Helderberg</label><label style="display:block"><input type="checkbox" class="ueBr" value="Kleinmond"> Kleinmond</label>';
    note.textContent=(lvl==='Auditor')?'Auditors can be assigned one or both branches to verify.':'Managers can be assigned one or both branches.';
  } else if(lvl==='Owner'){
    // ... existing Owner block unchanged ...
  } else {
    // ... existing Operator block unchanged ...
  }
```
Read the ACTUAL current structure of `ueLevelChanged` first and fold the `Auditor` case in without disturbing the Owner/Operator branches or the lockout-checkbox logic above them (Auditor accounts CAN be locked out — only `Owner` is special there, so the existing `lvl==='Owner'` lockout guard already does the right thing for Auditor).

- [ ] **Step 5: Syntax check + commit**

```powershell
$content = Get-Content "index.html" -Raw
$m = [regex]::Matches($content, '(?s)<script>(.*?)</script>')
$biggest = $m | Sort-Object { $_.Groups[1].Value.Length } -Descending | Select-Object -First 1
Set-Content -Path "$env:TEMP\claude\_check.js" -Value $biggest.Groups[1].Value -Encoding utf8
node --check "$env:TEMP\claude\_check.js"
Remove-Item "$env:TEMP\claude\_check.js" -Force
```
Expected: no output.

```bash
git add index.html
git commit -m "feat: Auditor role (level + verifiedCount perm + branch-assignment UI)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Browser verification**

Serve the worktree, open Manage Users → New user, confirm: the level dropdown has `Auditor`; selecting it shows the one-or-both-branches checkboxes and the Auditor note; the lockout checkbox is enabled (not greyed like Owner). Confirm `permPreset('Auditor')` in the console returns `{view:1,verifiedCount:1}` and `userPerms({level:'Auditor'})` returns the same (no force-grants).

---

### Task 4: Data layer — push, comparison fetch, signature helper

**Files:**
- Modify: `index.html` — add a new self-contained block. Placement: after the Branch-Transfers data-layer block if Phase 2 is merged (search `function _pushTransferDispatch`); otherwise after `function _pushManifoldLiveRows` / near the other live-mirror helpers.

- [ ] **Step 1: Add the data-layer functions**

```javascript
// ===== Verified Stock Takes (verified_stock_takes) - Phase 1 of the Stock Balance
// Management spec. A neutral Auditor's full physical count, stored separately from the
// daily Operator flow. Committed once, atomically - never updated - so no retry-in-place
// machinery, just an insert + two append-only Sheet pushes. A push failure queues to
// localStorage and retries at login, same convention _manifoldLiveFlush already uses.
function _pushVerifiedTake(payload){
  // payload = {branch, date, mode, count:[...], manifold:[...],
  //            auditorName, auditorSig, operatorName, operatorSig}  (operator* null for solo)
  // takeId is the CLIENT-generated key (client_row_id column, added by the Task 1 follow-up
  // migration) - `id` itself is a server-generated uuid and is deliberately never set here.
  // takeId is what identifies this take for idempotent-retry detection (the unique partial
  // index on client_row_id) and is what the Sheet mirror uses as TakeId.
  var takeId='vst_'+Date.now()+'_'+Math.floor(Math.random()*100000);
  var row={
    client_row_id:takeId, branch:payload.branch, date:payload.date, mode:payload.mode,
    count:payload.count, manifold:payload.manifold,
    auditor_id:currentProfile&&currentProfile.id, auditor_name_snapshot:payload.auditorName, auditor_sig:payload.auditorSig,
    operator_id:(payload.mode==='joint'?(payload._operatorId||null):null),
    operator_name_snapshot:(payload.mode==='joint'?(payload.operatorName||null):null),
    operator_sig:(payload.mode==='joint'?(payload.operatorSig||null):null)
  };
  return sb.from('verified_stock_takes').insert(row).select().then(function(res){
    if(res.error){console.error('_pushVerifiedTake failed:',res.error.message);_vstQueue(row);return null;}
    _vstSheetPush(payload,takeId);
    return (res.data&&res.data[0])||{client_row_id:takeId};
  },function(e){console.error('_pushVerifiedTake rejected:',e&&e.message);_vstQueue(row);return null;});
}
function _vstSheetPush(payload,takeId){
  var meta={ts:_nowISO(),date:payload.date,branch:payload.branch};
  syncPush('VerifiedCounts',(payload.count||[]).map(function(c){
    return Object.assign({},meta,{Auditor:payload.auditorName,Operator:(payload.operatorName||''),Mode:payload.mode,
      CountType:'Verified',State:c.state,Size:c.size,Brand:c.brand,Qty:c.qty,Note:(c.note||''),TakeId:takeId});
  }));
  syncPush('VerifiedManifold',(payload.manifold||[]).map(function(m){
    return Object.assign({},meta,{Auditor:payload.auditorName,Operator:(payload.operatorName||''),Mode:payload.mode,
      Cylinder:m.cyl,Brand:(m.brand||''),GasType:(m.gasType||''),Scale:m.scale,Tare:m.tare,GasLeft:m.gasLeft,
      Condition:(m.cylState||''),Note:(m.notes||''),TakeId:takeId});
  }));
}
function _vstQueue(row){
  try{var q=JSON.parse(localStorage.getItem('gs_vst_queue')||'[]');q.push(row);localStorage.setItem('gs_vst_queue',JSON.stringify(q.slice(-50)));}catch(e){}
}
function _vstFlush(){
  var q;try{q=JSON.parse(localStorage.getItem('gs_vst_queue')||'[]');}catch(e){return;}
  if(!q.length)return;
  localStorage.setItem('gs_vst_queue','[]');
  q.forEach(function(row){
    sb.from('verified_stock_takes').insert(row).then(function(res){
      if(res.error){
        var m=String(res.error.message||'');
        if(res.error.code!=='23505'&&m.indexOf('duplicate key')===-1)_vstQueue(row); // 23505 = already landed
      }
    },function(){_vstQueue(row);});
  });
}
// After a take commits: pull the Operator's own Closing stock_counts for this branch+date
// and return a per-size comparison so the capture screen can toast "you counted X, the
// day's Closing said Y" immediately - the whole point of a verified take. Returns
// {hasClosing:bool, lines:[{size,verified,closing,diff}]} - never invents a zero baseline
// (same non-negotiable this app already enforces for the Opening-vs-prev-close check).
function _fetchVerifiedTakeComparison(br,date,verifiedCount){
  return sb.from('stock_counts').select('*').eq('branch',br).eq('date',date).eq('count_type','Closing').then(function(res){
    if(res.error||!res.data||!res.data.length)return {hasClosing:false,lines:[]};
    var closeBySize={};
    res.data.forEach(function(r){ closeBySize[r.size]=(closeBySize[r.size]||0)+num(r.qty); });
    var vBySize={};
    (verifiedCount||[]).forEach(function(c){ vBySize[c.size]=(vBySize[c.size]||0)+num(c.qty); });
    var sizes={}; Object.keys(closeBySize).forEach(function(s){sizes[s]=1;}); Object.keys(vBySize).forEach(function(s){sizes[s]=1;});
    var lines=Object.keys(sizes).sort().map(function(s){
      var v=vBySize[s]||0, c=closeBySize[s]||0;
      return {size:s,verified:v,closing:c,diff:v-c};
    }).filter(function(l){return l.diff!==0;});
    return {hasClosing:true,lines:lines};
  },function(){return {hasClosing:false,lines:[]};});
}
// One-shot signature capture - same shape Phase 2 used for transfers (deliberately NOT
// the persistent Day-Close sigData/sigUnlocked pad, which is day-scoped and would collide
// with an in-progress Close Day on the same device). If Phase 2 is merged, this duplicates
// _initXferSigCanvas / _xferSig - fine for now, dedupe later.
var _vstSig={auditor:'',operator:'',_activeCanvas:''};
function _initVstSigCanvas(canvasId,sigKey){
  var cv=document.getElementById(canvasId);if(!cv||cv._init)return;cv._init=true;
  var ctx=cv.getContext('2d');ctx.lineWidth=2.2;ctx.lineCap='round';ctx.strokeStyle='#16202B';
  var drawing=false,last=null;
  function pos(e){var r=cv.getBoundingClientRect();var t=e.touches?e.touches[0]:e;return {x:(t.clientX-r.left)*(cv.width/r.width),y:(t.clientY-r.top)*(cv.height/r.height)};}
  function start(e){drawing=true;last=pos(e);e.preventDefault();}
  function move(e){if(!drawing)return;var p=pos(e);ctx.beginPath();ctx.moveTo(last.x,last.y);ctx.lineTo(p.x,p.y);ctx.stroke();last=p;_vstSig[sigKey]=cv.toDataURL('image/png');_vstSig._activeCanvas=canvasId;e.preventDefault();}
  function end(){drawing=false;}
  cv.addEventListener('mousedown',start);cv.addEventListener('mousemove',move);cv.addEventListener('mouseup',end);cv.addEventListener('mouseleave',end);
  cv.addEventListener('touchstart',start,{passive:false});cv.addEventListener('touchmove',move,{passive:false});cv.addEventListener('touchend',end);
}
function _vstSigClear(canvasId,sigKey){var cv=document.getElementById(canvasId);if(cv)cv.getContext('2d').clearRect(0,0,cv.width,cv.height);_vstSig[sigKey]='';if(_vstSig._activeCanvas===canvasId)_vstSig._activeCanvas='';}
```

- [ ] **Step 2: Wire `_vstFlush()` into `_finishLogin`**

In `_finishLogin`, alongside the other queue flushes (`_manifoldLiveFlush(); _manifoldPendingFlush();` — and `_transferFlush();` if Phase 2 merged), add:
```javascript
  _vstFlush();
```

- [ ] **Step 3: Syntax check + commit**

Syntax check (same command as Task 3 Step 5). Then:
```bash
git add index.html
git commit -m "feat: Verified Stock Take data layer (push + Sheet mirror + same-day comparison fetch + sig capture)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Browser verification**

Serve the worktree. Stub `sb.from('verified_stock_takes').insert(...).select()` (capture the actual object passed to `.insert(...)` so you can inspect it) → resolve `{data:[{id:'11111111-1111-1111-1111-111111111111'}],error:null}` (a real-shaped uuid, NOT a `vst_...` string — this is what catches an accidental `id:` preset regressing back in). Stub `syncPush`/`_nowISO`/`num`, set `currentProfile`. Call `_pushVerifiedTake({branch:'Helderberg',date:'2026-09-10',mode:'joint',count:[{size:'9kg',brand:'Afrox',state:'Full',qty:60,note:''}],manifold:[{cyl:'Cyl 1',scale:57,tare:45,gasLeft:12}],auditorName:'A',auditorSig:'data:x',operatorName:'O',operatorSig:'data:y'})`. Confirm: the captured insert payload has `client_row_id:'vst_...'` and NO `id` key at all; `operator_name_snapshot:'O'` for joint; `syncPush('VerifiedCounts', ...)` got 1 row with `CountType:'Verified'` and `TakeId` equal to that same `client_row_id` value; `syncPush('VerifiedManifold', ...)` got 1 row. Repeat with `mode:'solo'` + `operatorName:null` → confirm the insert payload has `operator_id/name/sig` all `null`. Stub `stock_counts` select → a couple of Closing rows and confirm `_fetchVerifiedTakeComparison` returns `{hasClosing:true, lines:[...]}` with correct `diff`, and `{hasClosing:false}` when the select returns `[]`.

---

### Task 5: The Verified Stock Take capture screen

**Files:**
- Modify: `index.html` — new `<div id="verifiedTakeView" class="view">` (place it with the other screen divs, e.g. next to `residualView` — and remember from the Phase 2 review: **it MUST get a matching entry in the `body[data-view=...] .view{display:none!important}` allow-list block near the top of the file, or it renders blank**). New JS controller block after the Task 4 data layer.

- [ ] **Step 1: Add the screen markup**

```html
<div id="verifiedTakeView" class="view">
  <div class="wrap">
    <label>Branch</label>
    <select id="vstBranch"><option>Helderberg</option><option>Kleinmond</option></select>
    <label>Date</label>
    <input id="vstDate" type="date">
    <label>Mode</label>
    <select id="vstMode" onchange="vstModeChanged()">
      <option value="joint">Joint — Auditor + Operator count together</option>
      <option value="solo">Solo — Auditor counts independently</option>
    </select>

    <h3 style="margin:16px 0 6px">Cylinder count</h3>
    <div id="vstCountGrid"></div>

    <h3 style="margin:16px 0 6px">Manifold</h3>
    <div id="vstManifoldGrid"></div>

    <label>Auditor signature</label>
    <canvas id="vstAuditorSig" width="600" height="150" style="border:1.5px solid var(--steel);border-radius:8px;width:100%;touch-action:none"></canvas>
    <button class="sigClear" onclick="_vstSigClear('vstAuditorSig','auditor')">Clear signature</button>

    <div id="vstOperatorSigWrap">
      <label>Operator signature (joint mode)</label>
      <input id="vstOperatorName" placeholder="Operator name" style="width:100%">
      <canvas id="vstOperatorSig" width="600" height="150" style="border:1.5px solid var(--steel);border-radius:8px;width:100%;touch-action:none"></canvas>
      <button class="sigClear" onclick="_vstSigClear('vstOperatorSig','operator')">Clear signature</button>
    </div>

    <button onclick="vstCommit()">Commit Verified Stock Take</button>
  </div>
</div>
```

- [ ] **Step 2: Add the grids + mode toggle + open function**

```javascript
var VST_STATES=['Full','Empty'];
var VST_MANIFOLD_SLOTS=['Cyl 1','Cyl 2','Cyl 3','Cyl 4']; // matches SECTION_ITEMS.manifold
function vstRenderCountGrid(){
  var g=document.getElementById('vstCountGrid');
  g.innerHTML='<div style="font-size:11px;color:var(--muted);margin-bottom:6px">One row per size. Enter the count for each brand present; leave a size at 0 if none.</div>'+
    ALLSIZES.map(function(sz){
      return '<div style="border:1px solid var(--steel);border-radius:8px;padding:6px;margin-bottom:6px">'+
        '<b style="font-size:12px">'+sz+'</b>'+
        VST_STATES.map(function(st){
          return '<div style="display:flex;gap:6px;align-items:center;margin-top:4px">'+
            '<span style="width:44px;font-size:11px">'+st+'</span>'+
            '<select id="vstb-'+sz+'-'+st+'" style="flex:1">'+BRANDS.map(function(b){return '<option>'+b+'</option>';}).join('')+'</select>'+
            '<input id="vstq-'+sz+'-'+st+'" type="number" min="0" step="1" value="0" style="width:70px">'+
            '</div>';
        }).join('')+
        '</div>';
    }).join('');
}
function vstRenderManifoldGrid(){
  var g=document.getElementById('vstManifoldGrid');
  g.innerHTML=VST_MANIFOLD_SLOTS.map(function(cyl){
    return '<div style="display:flex;gap:6px;align-items:center;margin-bottom:4px">'+
      '<span style="width:52px;font-size:12px">'+cyl+'</span>'+
      '<input id="vstms-'+cyl+'" type="number" step="0.01" placeholder="scale" style="width:80px" oninput="vstManGasLeft(\''+cyl+'\')">'+
      '<input id="vstmt-'+cyl+'" type="number" step="0.01" placeholder="tare" style="width:80px" oninput="vstManGasLeft(\''+cyl+'\')">'+
      '<span style="font-size:12px">= <b id="vstmg-'+cyl+'">0.00</b> kg left</span>'+
      '</div>';
  }).join('');
}
function vstManGasLeft(cyl){
  var s=num(document.getElementById('vstms-'+cyl).value), t=num(document.getElementById('vstmt-'+cyl).value);
  document.getElementById('vstmg-'+cyl).textContent=Math.max(0,s-t).toFixed(2);
}
function vstModeChanged(){
  var joint=(document.getElementById('vstMode').value==='joint');
  document.getElementById('vstOperatorSigWrap').style.display=joint?'block':'none';
}
function openVerifiedTake(){
  if(role!=='Owner'){toast('Owner only',true);return;} // rollout gate - flip to perm('verifiedCount') once verified live
  show('verifiedTakeView');
  document.getElementById('backBtn').style.display='block';
  document.getElementById('hTitle').textContent='Verified Stock Take';
  document.getElementById('hSub').textContent='Auditor — independent count';
  _vstSig.auditor='';_vstSig.operator='';_vstSig._activeCanvas='';
  document.getElementById('vstDate').value=today;
  document.getElementById('vstBranch').value=(branch||'Helderberg');
  document.getElementById('vstMode').value='joint';
  vstModeChanged();
  vstRenderCountGrid();
  vstRenderManifoldGrid();
  setTimeout(function(){_initVstSigCanvas('vstAuditorSig','auditor');_initVstSigCanvas('vstOperatorSig','operator');},50);
}
```

- [ ] **Step 3: Add `vstCommit`**

```javascript
var _vstCommitBusy=false;
function vstCommit(){
  if(_vstCommitBusy)return;
  var mode=document.getElementById('vstMode').value;
  var br=document.getElementById('vstBranch').value;
  var date=document.getElementById('vstDate').value;
  if(!date){toast('Pick a date',true);return;}
  if(!_vstSig.auditor){toast('Auditor must sign',true);return;}
  var operatorName='';
  if(mode==='joint'){
    operatorName=(document.getElementById('vstOperatorName').value||'').trim();
    if(!operatorName){toast('Enter the Operator name for a joint count',true);return;}
    if(!_vstSig.operator){toast('Operator must sign for a joint count',true);return;}
  }
  var count=[];
  ALLSIZES.forEach(function(sz){
    VST_STATES.forEach(function(st){
      var q=Math.round(num(document.getElementById('vstq-'+sz+'-'+st).value));
      if(q>0)count.push({size:sz,brand:document.getElementById('vstb-'+sz+'-'+st).value,state:st,qty:q,note:''});
    });
  });
  if(!count.length){toast('Enter at least one cylinder count',true);return;}
  var manifold=VST_MANIFOLD_SLOTS.map(function(cyl){
    var s=num(document.getElementById('vstms-'+cyl).value), t=num(document.getElementById('vstmt-'+cyl).value);
    return {cyl:cyl,brand:'',gasType:'',scale:s,tare:t,gasLeft:Math.max(0,s-t),cylState:'',notes:''};
  }).filter(function(m){return m.scale>0||m.tare>0;});
  _vstCommitBusy=true;
  _pushVerifiedTake({branch:br,date:date,mode:mode,count:count,manifold:manifold,
    auditorName:operator,auditorSig:_vstSig.auditor,
    operatorName:(mode==='joint'?operatorName:null),operatorSig:(mode==='joint'?_vstSig.operator:null)
  }).then(function(res){
    _vstCommitBusy=false;
    if(!res){toast('Could not reach the server — queued, will retry at next login',true);return;}
    auditLog('Verified Stock Take committed',mode+' — '+br+' '+date+' — '+count.length+' count line(s)');
    toast('Verified Stock Take saved. Checking against the day’s Closing count…');
    _fetchVerifiedTakeComparison(br,date,count).then(function(cmp){
      if(!cmp.hasClosing){toast('No Operator Closing count for '+br+' on '+date+' yet — nothing to compare against.',true);goHome();return;}
      if(!cmp.lines.length){toast('✅ Verified count matches the day’s Closing count on every size.');goHome();return;}
      var msg=cmp.lines.slice(0,6).map(function(l){return l.size+': you '+l.verified+' vs Closing '+l.closing+' ('+(l.diff>0?'+':'')+l.diff+')';}).join('  ·  ');
      toast('⚠ Verified count differs from Closing on '+cmp.lines.length+' size(s): '+msg,true);
      goHome();
    });
  });
}
```

- [ ] **Step 4: Add the CSS view allow-list entry**

Near the top of `index.html` (the `body[data-view] .view{display:none !important;}` block, ~line 81-101), add `body[data-view="verifiedTakeView"] #verifiedTakeView` to the comma-separated allow-list (match the surrounding format exactly — read those lines first).

- [ ] **Step 5: Syntax check + browser verification + commit**

Syntax check. Then serve the worktree, stub `sb`/`syncPush`/`apiPost`, set `role='Owner'; operator='TestOwner'; currentProfile={id:'...'}; today='2026-09-10'; branch='Helderberg'`. Call `openVerifiedTake()` and confirm: `getComputedStyle(document.getElementById('verifiedTakeView')).display` is NOT `'none'`; `#vstCountGrid` has `ALLSIZES.length` size blocks each with 2 state rows; `#vstManifoldGrid` has 4 slot rows; entering scale/tare updates the "kg left" span live; switching Mode to `solo` hides `#vstOperatorSigWrap`. Then: joint mode, no operator name → `vstCommit()` toasts "Enter the Operator name"; fill everything, `_vstSig.auditor`/`_vstSig.operator` set → `vstCommit()` calls `_pushVerifiedTake` with a well-formed payload and (with a stubbed comparison) shows the comparison toast then `goHome()`. `role='Operator'; openVerifiedTake()` → "Owner only" toast, no navigation.

```bash
git add index.html
git commit -m "feat: Verified Stock Take capture screen (joint/solo, count + manifold grids, same-day Closing comparison)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Tile, rollout gate, Auditor landing

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Add the Home tile**

After the Admin tile (`id="tileAdmin"`), add:
```html
<button class="tile t1" data-key="verifiedTake" id="tileVerifiedTake" onclick="openVerifiedTake()" style="display:none"><div class="ic">&#9745;</div><h3>Verified Stock Take</h3><p>Auditor: independent physical count</p></button>
```

- [ ] **Step 2: Tile visibility (rollout gate — Owner only for now)**

In `_finishLogin`, in the run of tile-visibility lines (after the `_tpo` / `tileTransfer` lines), add:
```javascript
var _tvt=document.getElementById('tileVerifiedTake');if(_tvt)_tvt.style.display=(role==='Owner')?'flex':'none';
```
(Comment it: `// rollout gate — flip to perm('verifiedCount') once verified live, so real Auditor accounts can see it.`)

- [ ] **Step 3: Auditor lands directly on the tile after login**

Find where `_finishLogin` decides the initial screen (it calls `_restoreCurrentSection()` then falls back to `goHome()` / `show('landing')`). An Auditor has no other tile, so landing on Home (with only the one tile visible) is acceptable and needs NO special-casing — confirm that's what happens for a `role==='Auditor'` account (all other tiles hidden by their `perm(...)` checks, only `tileVerifiedTake` shown... but WAIT: Step 2 gates the tile to `role==='Owner'` during the build. So during the build, an Auditor account sees a completely empty Home. That's fine for the build phase — real Auditor accounts aren't created until the rollout gate is flipped. Note this explicitly in the commit message.)

- [ ] **Step 4: NO section-restore entry**

Confirm `openVerifiedTake()` does NOT call `_saveCurrentSection('verifiedTake')`, and there is NO `verifiedTake` case in `_restoreCurrentSection()`. (Same rollout-safety reasoning as Phase 2's transfer screen — a user demoted from Owner mid-session, or a reload, must not auto-restore into an Owner-gated screen.) The plan's `openVerifiedTake()` (Task 5) deliberately omits `_saveCurrentSection` — just verify nothing else adds it.

- [ ] **Step 5: Syntax check + browser verification + commit**

Syntax check. Serve, log in stub as Owner → confirm the tile shows and opens the screen. Stub `role='Auditor'` → confirm the tile is hidden (build-phase gate) and Home shows no tiles without error. Stub `role='Manager'`/`'Operator'` → tile hidden.

```bash
git add index.html
git commit -m "feat: Verified Stock Take tile + Owner-only rollout gate (no section-restore entry)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: Full-cycle verification against real Supabase + push

**Files:** none (verification only)

- [ ] **Step 1: Confirm the migration is live**

```powershell
supabase migration list --linked
supabase db query --linked -o json "select count(*) from verified_stock_takes;"
```
Expected: `20260911000000` local+remote in sync; count `0` (not an error).

- [ ] **Step 2: Real-Supabase lifecycle test**

Via `supabase db query --linked` (write the SQL to a file, run with `-f` — single quotes in inline SQL break the PowerShell arg parser, learned in Phase 2):
- Insert one `joint` verified take for `Helderberg` / today, `client_row_id='vst-TEST-joint'`, with a small `count` jsonb (2-3 lines) and a `manifold` jsonb (1-2 slots).
- `select` it back — confirm `mode`, `count`/`manifold` round-trip as jsonb, `operator_name_snapshot` is set, `id` is a real server-generated uuid distinct from `client_row_id`.
- Insert a `solo` take (`client_row_id='vst-TEST-solo'`) — confirm `operator_id`/`operator_name_snapshot`/`operator_sig` are all `null` and the insert still succeeds (no NOT NULL violation).
- Attempt to re-insert `client_row_id='vst-TEST-joint'` again — confirm it's rejected with a `23505` unique-violation on `verified_stock_takes_client_row_id_unique` (proves the idempotent-retry protection is live, same check Phase 2 ran on `stock_transfers.row_id`).
- Run the comparison query the app uses: `select size, sum(qty::numeric) from stock_counts where branch='Helderberg' and date=<a real recent date with a Closing count, e.g. 2026-09-09> and count_type='Closing' group by size;` — confirm it returns rows (this is what `_fetchVerifiedTakeComparison` reads; verifying it against real Closing data confirms the toast will have something to compare).
- Delete both test rows — tag them at insert time with a recognisable `client_row_id` prefix (e.g. `'vst-TEST-joint'` / `'vst-TEST-solo'`) so cleanup is a simple `delete from verified_stock_takes where client_row_id like 'vst-TEST-%' returning id, client_row_id;` (same convention Phase 2's Task 8 used for `stock_transfers`).

- [ ] **Step 3: Note what still needs a real run by the owner**

- The UI end-to-end in a live authenticated Auditor (or Owner, during build) session.
- The Apps Script Sheet mirror — `syncPush('VerifiedCounts'/'VerifiedManifold', ...)` actually landing rows on the two new tabs (needs the deployed v17 `/exec` reachable via the sync config).
- The comparison toast firing against a real same-day Closing count.

- [ ] **Step 4: Push + finish the branch**

```bash
git push -u origin <branch>
```
Then use `superpowers:finishing-a-development-branch` (option 2 — push + PR).

---

## Self-Review

- [x] **Spec coverage:** Auditor role (Task 3) ✓; joint + solo modes (Tasks 1, 5) ✓; any-date capture (Task 5, `vstDate` free `type="date"`) ✓; full count + Manifold detail (Task 5 grids) ✓; runs *alongside* the daily flow, never replaces it (separate table + separate screen, no `store.count`/`store.manifold` touch — stated in Architecture) ✓; dual sign-off joint / Auditor-only solo (Task 5 `vstCommit` gates) ✓; same-day comparison toast vs Operator Closing (Task 4 `_fetchVerifiedTakeComparison`, Task 5 `vstCommit`) ✓; Sheets mirror (Task 2 tabs, Task 4 `_vstSheetPush`) ✓; Owner-only during build (Task 6 Step 2) ✓; no section-restore / demoted-user safety (Task 6 Step 4) ✓.
- [x] **Placeholder scan:** every code step has complete code; no TBD/TODO.
- [x] **Type consistency:** `count` line shape `{size,brand,state,qty,note}` is identical across the migration comment, `_pushVerifiedTake`, `_vstSheetPush`, `_fetchVerifiedTakeComparison`, and `vstCommit`'s builder. `manifold` line shape `{cyl,brand,gasType,scale,tare,gasLeft,cylState,notes}` identical across the migration comment, `_vstSheetPush`, and `vstCommit`'s builder. `_vstSig` slot keys (`auditor`/`operator`/`_activeCanvas`) consistent between `_initVstSigCanvas`, `_vstSigClear`, `openVerifiedTake`, `vstCommit`.
- [x] **Naming:** `verifiedTakeView` (screen id) used identically in the markup, `show(...)`, and the CSS allow-list step. `vst*` prefix throughout. `tileVerifiedTake` consistent between markup and `_finishLogin`.
- [x] **Known gap carried forward:** `_pushVerifiedTake`'s `_operatorId` for a joint take — `vstCommit` collects the Operator *name* free-text (the Operator signing isn't necessarily a logged-in profile on the Auditor's device), so `operator_id` will be `null` even for joint takes and `operator_name_snapshot` carries the identity. That's acceptable (the signature + typed name are the attestation; the FK is a nice-to-have). Flagged here so a reviewer doesn't treat the always-null `operator_id` as a bug.

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-09-10-verified-stock-takes.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, two-stage review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session with checkpoints for review.

Which approach?
