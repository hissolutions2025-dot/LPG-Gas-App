# Manifold Remote Override Approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator submit an out-of-range Manifold reading for remote Manager/Owner
approval when no Manager/Owner is physically present, instead of being stuck with no
passthrough at all.

**Architecture:** A new Supabase table (`manifold_pending_overrides`) holds a worklist of
items awaiting approval. At each of the three existing on-the-spot authorization points
(hard-ceiling, flagged-band, used/partial), the operator chooses "authorise now" (today's
exact existing flow, unchanged) or "submit for remote approval" (row saves immediately,
flagged PENDING, operator continues). A new standalone screen lets any Manager/Owner
approve or reject pending items from anywhere, using the same password-signing convention
already used everywhere else in this app. Close Day is blocked for a branch with any still-
pending item, mirroring the existing opening-count-mismatch gate.

**Tech Stack:** Vanilla JS (single-file `index.html`), Supabase JS client (`sb`), no build
step, no test framework — verification is a syntax-check script (`new Function()` over
each extracted `<script>` block) plus live verification, this project's own established
convention (no automated test suite exists).

**Reference:** `docs/superpowers/specs/2026-08-31-manifold-remote-override-approval-design.md`

---

### Task 0: Create the Supabase table

**Files:** none (Supabase schema change — hand the user SQL, same as every prior schema
change this session).

- [ ] **Step 1: Give the user this SQL to run in the Supabase SQL editor**

```sql
CREATE TABLE IF NOT EXISTS manifold_pending_overrides (
  id uuid primary key default gen_random_uuid(),
  branch text not null,
  date text not null,
  cyl text,
  kind text not null,
  row_rid text,
  gas_left numeric,
  cap numeric,
  submitted_by uuid references profiles(id),
  submitted_by_name_snapshot text,
  submitted_at timestamptz default now(),
  status text not null default 'PENDING',
  resolved_by uuid references profiles(id),
  resolved_by_name_snapshot text,
  resolved_at timestamptz,
  resolution_note text
);
CREATE INDEX IF NOT EXISTS manifold_pending_overrides_status_idx ON manifold_pending_overrides (status);
CREATE INDEX IF NOT EXISTS manifold_pending_overrides_branch_date_idx ON manifold_pending_overrides (branch, date);

ALTER TABLE manifold_pending_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY manifold_pending_overrides_select ON manifold_pending_overrides
  FOR SELECT TO authenticated USING (true);

CREATE POLICY manifold_pending_overrides_insert ON manifold_pending_overrides
  FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY manifold_pending_overrides_update ON manifold_pending_overrides
  FOR UPDATE TO authenticated USING (
    (SELECT level FROM profiles WHERE id = auth.uid()) IN ('Manager','Owner')
  ) WITH CHECK (
    (SELECT level FROM profiles WHERE id = auth.uid()) IN ('Manager','Owner')
  );
```

- [ ] **Step 2: Confirm with the user the table was created successfully before continuing**

---

### Task 1: Capture-time — remote-submit branch at all three authorization points

**Files:**
- Modify: `index.html`, `_addLineFinish(c,d,onDone)` — the hard-ceiling block, the
  flagged-band block, and the used/partial block. Search for the exact text below; line
  numbers have shifted since this plan was written.

- [ ] **Step 1: Hard-ceiling block**

Find:
```javascript
      var wantsCeilOverride=confirm('Gas left ('+gl.toFixed(2)+'kg) exceeds '+(cap+_ceilTol.kg).toFixed(1)+'kg — that\'s not physically possible for a normal cylinder.\n\nPress Cancel to recheck your scale/tare entry — nothing has been saved yet.\nPress OK if the numbers are correct — a Manager or Owner will need to authorise saving this reading.');
      if(!wantsCeilOverride){if(onDone)onDone(false);return;}
      if(manifoldOverrideBusy){toast('An override is already pending for another reading — wait for it to finish, then try again',true);if(onDone)onDone(false);return;}
      manifoldOverrideBusy=true;
      manifoldWeightOverride('HARD CEILING — gas left '+gl.toFixed(2)+'kg for '+modalItem+' ('+(d.gasType||'LPG')+', exceeds '+(cap+_ceilTol.kg).toFixed(1)+'kg)').then(function(ok){
```
Replace with:
```javascript
      var wantsCeilOverride=confirm('Gas left ('+gl.toFixed(2)+'kg) exceeds '+(cap+_ceilTol.kg).toFixed(1)+'kg — that\'s not physically possible for a normal cylinder.\n\nPress Cancel to recheck your scale/tare entry — nothing has been saved yet.\nPress OK if the numbers are correct — a Manager or Owner will need to authorise saving this reading.');
      if(!wantsCeilOverride){if(onDone)onDone(false);return;}
      // Remote-approval branch: a Manager/Owner isn't always physically present to authorise
      // on the spot (a real operational gap found in live use - see the design doc for this
      // feature). Cancel here means "submit for remote approval" (save now, flagged PENDING,
      // resolved later by any Manager/Owner from the Pending Overrides screen) - OK means
      // "authorise now", which is today's exact existing flow, completely unchanged below.
      var mgrHereNow=confirm('Is a Manager or Owner here right now to authorise this?\n\nOK = they\'ll enter their password now.\nCancel = submit for remote approval and continue — a Manager or Owner will review it from the Pending Overrides screen.');
      if(!mgrHereNow){
        d._overrideStatus='PENDING';d._overrideKind='HARD_CEILING';d._overrideGasLeft=gl;d._overrideCap=cap;
        _addLineFinishAfterCap(c,d,onDone);
        return;
      }
      if(manifoldOverrideBusy){toast('An override is already pending for another reading — wait for it to finish, then try again',true);if(onDone)onDone(false);return;}
      manifoldOverrideBusy=true;
      manifoldWeightOverride('HARD CEILING — gas left '+gl.toFixed(2)+'kg for '+modalItem+' ('+(d.gasType||'LPG')+', exceeds '+(cap+_ceilTol.kg).toFixed(1)+'kg)').then(function(ok){
```

- [ ] **Step 2: Flagged-band block**

Find:
```javascript
    if(_flagTol.enabled && gl>cap+_flagTol.kg){
      // Re-entrancy guard: manifoldWeightOverride() below runs an async auth (askPassword) +
```
...down to (unchanged, just for locating context):
```javascript
      if(manifoldOverrideBusy){toast('An override is already pending for another reading — wait for it to finish, then try again',true);if(onDone)onDone(false);return;}
      manifoldOverrideBusy=true;
      manifoldWeightOverride('Gas left '+gl.toFixed(2)+'kg for '+modalItem+' ('+(d.gasType||'LPG')+', normal range up to '+(cap+_flagTol.kg).toFixed(1)+'kg)').then(function(ok){
```
Insert the same choice, right before the `if(manifoldOverrideBusy)` guard (i.e. right after the long re-entrancy-guard comment block, before that guard check):
```javascript
      var mgrHereNowFlag=confirm('Is a Manager or Owner here right now to authorise this?\n\nOK = they\'ll enter their password now.\nCancel = submit for remote approval and continue — a Manager or Owner will review it from the Pending Overrides screen.');
      if(!mgrHereNowFlag){
        d._overrideStatus='PENDING';d._overrideKind='FLAGGED_BAND';d._overrideGasLeft=gl;d._overrideCap=cap;
        _addLineFinishAfterCap(c,d,onDone);
        return;
      }
      if(manifoldOverrideBusy){toast('An override is already pending for another reading — wait for it to finish, then try again',true);if(onDone)onDone(false);return;}
      manifoldOverrideBusy=true;
      manifoldWeightOverride('Gas left '+gl.toFixed(2)+'kg for '+modalItem+' ('+(d.gasType||'LPG')+', normal range up to '+(cap+_flagTol.kg).toFixed(1)+'kg)').then(function(ok){
```
(Variable named `mgrHereNowFlag`, not `mgrHereNow` — this is a different `var` in the same
function scope as Task 1 Step 1's `mgrHereNow`, and JS would silently let a same-named `var`
redeclaration slide, but give each its own name for clarity when reading the function later.)

- [ ] **Step 3: Used/partial block**

Find:
```javascript
    if(isIncoming && isUsedPartial){
      if(manifoldOverrideBusy){toast('An override is already pending for another reading — wait for it to finish, then try again',true);if(onDone)onDone(false);return;}
      manifoldOverrideBusy=true;
      manifoldWeightOverride('Used/partial cylinder declared for '+modalItem+' — gas left '+gl.toFixed(2)+'kg ('+(d.gasType||'LPG')+')').then(function(ok){
```
Replace with:
```javascript
    if(isIncoming && isUsedPartial){
      var mgrHereNowPartial=confirm('Is a Manager or Owner here right now to authorise this?\n\nOK = they\'ll enter their password now.\nCancel = submit for remote approval and continue — a Manager or Owner will review it from the Pending Overrides screen.');
      if(!mgrHereNowPartial){
        d._overrideStatus='PENDING';d._overrideKind='USED_PARTIAL';d._overrideGasLeft=gl;d._overrideCap=cap;
        _addLineFinishAfterCap(c,d,onDone);
        return;
      }
      if(manifoldOverrideBusy){toast('An override is already pending for another reading — wait for it to finish, then try again',true);if(onDone)onDone(false);return;}
      manifoldOverrideBusy=true;
      manifoldWeightOverride('Used/partial cylinder declared for '+modalItem+' — gas left '+gl.toFixed(2)+'kg ('+(d.gasType||'LPG')+')').then(function(ok){
```

**IMPORTANT — do not touch anything else in `_addLineFinish`.** Every other line (the
underfill block, the leftover-gas block, everything before/after these three edits) must
stay byte-for-byte unchanged.

- [ ] **Step 4: Syntax-check**

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
git commit -m "feat: remote-approval branch at all three Manifold override authorization points"
```

---

### Task 2: Commit-time — push PENDING rows to Supabase

**Files:**
- Modify: `index.html` — add new functions near `_pushManifoldLiveRows` (in the "Manifold
  live data" block), and wire into `_capCommitReal()`.

- [ ] **Step 1: Add the push + retry-queue functions**

Add directly after `_manifoldLiveFlush()`'s closing brace:

```javascript
// ===== Manifold remote override approval (manifold_pending_overrides) =====
// Additive write, same shape as _pushManifoldLiveRows above - fires alongside it at commit
// time, never blocks the commit itself. Only rows actually stamped PENDING (by the
// remote-submit branch in _addLineFinish) produce anything here - a normal or
// physically-authorised row is a no-op.
function _pushManifoldPendingOverrides(rows,br){
  var pending=rows.filter(function(r){return r._overrideStatus==='PENDING';});
  if(!pending.length)return;
  var payload=pending.map(function(row){
    return {branch:br, date:row._date||today, cyl:row.cyl||null, kind:row._overrideKind||null, row_rid:row._rid||null, gas_left:(typeof row._overrideGasLeft==='number')?row._overrideGasLeft:null, cap:(typeof row._overrideCap==='number')?row._overrideCap:null, submitted_by:currentProfile&&currentProfile.id, submitted_by_name_snapshot:operator, status:'PENDING'};
  });
  sb.from('manifold_pending_overrides').insert(payload).then(function(res){
    if(res.error){console.error('_pushManifoldPendingOverrides failed:',res.error.message);_manifoldPendingQueue(payload);}
    else{_manifoldPendingFlush();}
  },function(e){console.error('_pushManifoldPendingOverrides rejected:',e&&e.message);_manifoldPendingQueue(payload);});
}
function _manifoldPendingQueue(payload){
  try{
    var q=JSON.parse(localStorage.getItem('gs_manifoldpending_queue')||'[]');
    q.push(payload);
    localStorage.setItem('gs_manifoldpending_queue',JSON.stringify(q.slice(-200)));
  }catch(e){}
}
function _manifoldPendingFlush(){
  var q;try{q=JSON.parse(localStorage.getItem('gs_manifoldpending_queue')||'[]');}catch(e){return;}
  if(!q.length)return;
  localStorage.setItem('gs_manifoldpending_queue','[]');
  q.forEach(function(payload){
    sb.from('manifold_pending_overrides').insert(payload).then(function(res){
      if(res.error)_manifoldPendingQueue(payload);
    },function(e){_manifoldPendingQueue(payload);});
  });
}
```

- [ ] **Step 2: Wire into `_capCommitReal()`**

Find:
```javascript
    if(capType==='manifold'){syncPush('Manifold',syncRowsManifold(freshRows,capBranch));_pushManifoldLiveRows(freshRows,capBranch);}
```
Change to:
```javascript
    if(capType==='manifold'){syncPush('Manifold',syncRowsManifold(freshRows,capBranch));_pushManifoldLiveRows(freshRows,capBranch);_pushManifoldPendingOverrides(freshRows,capBranch);}
```

- [ ] **Step 3: Flush the retry queue at login**

Find:
```javascript
  _manifoldLiveFlush();
  _closeDayFlushQueue();
```
Change to:
```javascript
  _manifoldLiveFlush();
  _manifoldPendingFlush();
  _closeDayFlushQueue();
```

- [ ] **Step 4: Syntax-check** (same command as Task 1). Expected: `ALL SCRIPT BLOCKS OK`

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat: push PENDING Manifold overrides to Supabase at commit time"
```

---

### Task 3: Fetch, badge, and landing tile

**Files:**
- Modify: `index.html` — new fetch/badge functions near the pending-overrides push
  functions (Task 2); wire into the login flow; add the landing tile HTML and its
  visibility toggle.

- [ ] **Step 1: Add the fetch + badge functions**

Add directly after `_manifoldPendingFlush()`'s closing brace:

```javascript
var _manifoldPendingOverrides=[]; // cached list of PENDING items, fetched at login for
                                    // EVERY role (not just Manager/Owner) - Close Day's gate
                                    // (a later task) needs this to be accurate regardless of
                                    // who ends up authorising the close, even though only
                                    // Manager/Owner ever sees the tile/badge built from it.
function _fetchManifoldPendingOverrides(){
  return sb.from('manifold_pending_overrides').select('*').eq('status','PENDING').then(function(res){
    if(res.error){console.error('_fetchManifoldPendingOverrides failed:',res.error.message);return;}
    _manifoldPendingOverrides=res.data||[];
    _updatePendingOverridesBadge();
  },function(e){console.error('_fetchManifoldPendingOverrides rejected:',e&&e.message);});
}
function _updatePendingOverridesBadge(){
  var b=document.getElementById('b-pendingOverrides');if(!b)return;
  var isMgr=(role==='Manager'||role==='Owner');
  var n=isMgr?_manifoldPendingOverrides.length:0;
  b.style.display=n?'flex':'none';b.textContent=n;
}
```

- [ ] **Step 2: Wire the fetch into login**

Find:
```javascript
  _manifoldPendingFlush();
  _closeDayFlushQueue();
```
Change to:
```javascript
  _manifoldPendingFlush();
  _fetchManifoldPendingOverrides();
  _closeDayFlushQueue();
```

- [ ] **Step 3: Wire tile visibility into login**

Find:
```javascript
  var _trg=document.getElementById('tileResidual');if(_trg)_trg.style.display=perm('residualGas')?'flex':'none';
```
Change to:
```javascript
  var _trg=document.getElementById('tileResidual');if(_trg)_trg.style.display=perm('residualGas')?'flex':'none';
  var _tpo=document.getElementById('tilePendingOverrides');if(_tpo)_tpo.style.display=(role==='Manager'||role==='Owner')?'flex':'none';
```

- [ ] **Step 4: Add the landing tile HTML**

Find:
```html
      <button class="tile t4" data-key="residual" id="tileResidual" onclick="openResidual()" style="display:none"><div class="ic">&#127766;</div><h3>Residual Gas</h3><p>Gas left in received cylinders</p></button>
```
Add immediately after it:
```html
      <button class="tile t3" data-key="pendingOverrides" id="tilePendingOverrides" onclick="openPendingOverrides()" style="display:none"><div class="ic">&#9888;</div><h3>Pending Overrides</h3><p>Manager/Owner: approve or reject remote submissions</p><span class="badge" id="b-pendingOverrides" style="display:none">0</span></button>
```

- [ ] **Step 5: Syntax-check** (same command as Task 1). Expected: `ALL SCRIPT BLOCKS OK`

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "feat: fetch/badge/tile for Manifold pending overrides"
```

---

### Task 4: Pending Overrides screen — list, approve, reject

**Files:**
- Modify: `index.html` — new view HTML (near `residualView`), new render/action functions
  (near the fetch/badge functions from Task 3).

- [ ] **Step 1: Add the view HTML**

Find:
```html
<!-- RESIDUAL GAS (main section) -->
<div id="residualView" class="view"><div class="wrap">
```
Add immediately BEFORE it:
```html
<!-- MANIFOLD PENDING OVERRIDES -->
<div id="pendingOverridesView" class="view"><div class="wrap">
  <div id="pendingOverridesBody"></div>
</div></div>

<!-- RESIDUAL GAS (main section) -->
<div id="residualView" class="view"><div class="wrap">
```

- [ ] **Step 2: Add `openPendingOverrides()` and `renderPendingOverrides()`**

Add directly after `_updatePendingOverridesBadge()`'s closing brace:

```javascript
function openPendingOverrides(){
  if(!(role==='Manager'||role==='Owner')){toast('Manager or Owner only',true);return;}
  document.getElementById('hTitle').textContent='Pending Overrides';
  document.getElementById('hSub').textContent='Approve or reject remote submissions';
  show('pendingOverridesView');document.getElementById('backBtn').style.display='block';window.scrollTo(0,0);
  _saveCurrentSection('pendingOverrides');
  _fetchManifoldPendingOverrides().then(renderPendingOverrides);
  renderPendingOverrides();
}
var _PENDING_OVERRIDE_KIND_LABELS={HARD_CEILING:'Hard ceiling',FLAGGED_BAND:'Flagged band',USED_PARTIAL:'Used/partial cylinder'};
function renderPendingOverrides(){
  var box=document.getElementById('pendingOverridesBody');if(!box)return;
  if(!_manifoldPendingOverrides.length){box.innerHTML='<div class="histEmpty" style="text-align:center;padding:20px">No pending overrides ✓</div>';return;}
  var html='';
  _manifoldPendingOverrides.forEach(function(item){
    var kindLabel=_PENDING_OVERRIDE_KIND_LABELS[item.kind]||item.kind||'';
    html+='<div class="histSection" style="border:2px solid var(--amber)">'+
      '<div style="font-weight:700">'+(item.branch||'')+' — '+(item.cyl||'')+' — '+kindLabel+'</div>'+
      '<div style="font-size:12px;color:var(--muted);margin:4px 0">'+(item.gas_left!=null?('Gas left '+num(item.gas_left).toFixed(2)+'kg'+(item.cap!=null?(' (cap '+item.cap+'kg)'):'')):'')+'</div>'+
      '<div style="font-size:11px;color:var(--muted)">Submitted by '+(item.submitted_by_name_snapshot||'—')+' · '+(item.submitted_at?new Date(item.submitted_at).toLocaleString():'')+'</div>'+
      '<div style="display:flex;gap:8px;margin-top:10px">'+
        '<button class="saveBtn" onclick="resolvePendingOverride(\''+item.id+'\',\'APPROVED\')">Approve</button>'+
        '<button class="saveBtn" style="background:#C0392B" onclick="resolvePendingOverride(\''+item.id+'\',\'REJECTED\')">Reject</button>'+
      '</div></div>';
  });
  box.innerHTML=html;
}
```

- [ ] **Step 3: Add `resolvePendingOverride()` and the mirror-row status update helper**

Add directly after `renderPendingOverrides()`'s closing brace:

```javascript
// Updates the corresponding manifold_live_rows mirror row's _overrideStatus/note so a
// THIRD device (neither the one that captured it nor the one resolving it) sees the
// resolved status the next time it fetches live Manifold data - without this, the mirror
// row would say PENDING forever regardless of what actually happened, and the same-day
// Adjust tool on another device would never see a rejection to surface. Deliberately a
// scoped exception to the earlier live-cross-device-data feature's "an Adjust correction
// doesn't update the mirror row" limitation - that limitation is about VALUE corrections
// (a manager typing a new weight), not about this feature's own PENDING/APPROVED/REJECTED
// status, which this feature's own write path is responsible for keeping current.
function _updateManifoldLiveRowOverrideStatus(rowRid,status,note){
  if(!rowRid)return Promise.resolve();
  return sb.from('manifold_live_rows').select('id,row').eq('row_id',rowRid).then(function(res){
    if(res.error||!res.data||!res.data.length)return;
    return Promise.all(res.data.map(function(rec){
      var updatedRow=Object.assign({},rec.row,{_overrideStatus:status,_overrideResolutionNote:note||''});
      return sb.from('manifold_live_rows').update({row:updatedRow}).eq('id',rec.id);
    }));
  },function(){});
}
function resolvePendingOverride(id,decision){
  if(!(role==='Manager'||role==='Owner')){toast('Manager or Owner only',true);return;}
  var item=_manifoldPendingOverrides.filter(function(x){return x.id===id;})[0];
  if(!item){toast('Item no longer pending',true);return;}
  var qualifies=function(p){return p.level==='Manager'||p.level==='Owner';};
  var authPromise=(currentProfile && qualifies(currentProfile))?_selfReauth((decision==='APPROVED'?'Approve':'Reject')+' this override?'):_borrowAuth('Manager or Owner',(decision==='APPROVED'?'Approve':'Reject')+' this override?',qualifies);
  authPromise.then(function(auth){
    if(!auth){toast('Manager or Owner password required',true);return;}
    var note='';
    if(decision==='REJECTED'){
      note=prompt('Reason for rejecting this reading (required):')||'';
      if(!note.trim()){toast('A reason is required to reject',true);return;}
    } else {
      note=prompt('Optional note (leave blank to skip):')||'';
    }
    sb.from('manifold_pending_overrides').update({status:decision,resolved_by:auth.id,resolved_by_name_snapshot:auth.name,resolved_at:new Date().toISOString(),resolution_note:note.trim()}).eq('id',id).then(function(res){
      if(res.error){toast('Could not save: '+res.error.message,true);return;}
      _updateManifoldLiveRowOverrideStatus(item.row_rid,decision,note.trim());
      auditLog('Manifold override '+decision.toLowerCase(),(item.branch||'')+' — '+(item.cyl||'')+' — '+(item.kind||'')+' — by '+auth.name+(note.trim()?(' — '+note.trim()):''));
      toast('Override '+decision.toLowerCase()+' ✓');
      _manifoldPendingOverrides=_manifoldPendingOverrides.filter(function(x){return x.id!==id;});
      _updatePendingOverridesBadge();
      renderPendingOverrides();
    },function(e){toast('Network error — check your connection',true);});
  });
}
```

- [ ] **Step 4: Syntax-check** (same command as Task 1). Expected: `ALL SCRIPT BLOCKS OK`

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat: Pending Overrides screen - list, approve, reject"
```

---

### Task 5: Close Day gate

**Files:**
- Modify: `index.html`, `closeDay()`.

- [ ] **Step 1: Add the block**

Find (the existing unpaired-Added-swap block, right before the Close Day auth block):
```javascript
  if(_unpairedManifoldAddedSlots.length){
    toast('Cannot close: '+_unpairedManifoldAddedSlots.join(', ')+' — incoming cylinder recorded but no outgoing cylinder weigh-out exists for it (incomplete swap). A Manager/Owner must resolve it (Manifold capture → "Adjust an already-committed entry") before the day can be closed.',true);
    return;
  }
  // Close Day requires: an authoriser WITH close-day permission + the high-risk second password
```
Change to:
```javascript
  if(_unpairedManifoldAddedSlots.length){
    toast('Cannot close: '+_unpairedManifoldAddedSlots.join(', ')+' — incoming cylinder recorded but no outgoing cylinder weigh-out exists for it (incomplete swap). A Manager/Owner must resolve it (Manifold capture → "Adjust an already-committed entry") before the day can be closed.',true);
    return;
  }
  // #4c BLOCK: any Manifold reading still awaiting remote Manager/Owner approval. Reads the
  // cache populated at login by _fetchManifoldPendingOverrides() (fetched unconditionally
  // for every role, not just Manager/Owner - see that function's own comment) - same
  // "cache refreshed at login, not a live re-fetch at the gate itself" precedent already
  // established by the opening-count-mismatch check above.
  var _pendingForBranch=(_manifoldPendingOverrides||[]).filter(function(p){return p.branch===branch&&(p.date||today)===today;});
  if(_pendingForBranch.length){
    toast('Cannot close: '+_pendingForBranch.length+' Manifold override(s) still awaiting Manager/Owner approval — see the Pending Overrides screen.',true);
    return;
  }
  // Close Day requires: an authoriser WITH close-day permission + the high-risk second password
```

- [ ] **Step 2: Syntax-check** (same command as Task 1). Expected: `ALL SCRIPT BLOCKS OK`

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: block Close Day while a branch has any pending Manifold override"
```

---

### Task 6: Rejected-row visibility in the same-day Adjust picker

**Files:**
- Modify: `index.html`, `corrLines()`'s Manifold branch.

- [ ] **Step 1: Add the rejection marker**

Find:
```javascript
  } else if(section==='Manifold'){
    // Correct gas left (kg) directly - it's the figure that actually matters downstream
    // (manifoldBalance(), computeManifoldMismatches() both read r.gasLeft, never re-derive
    // it from scale/tare), and it's what a manager actually knows when fixing a mistake
    // (a re-check found the cylinder had X kg left), not necessarily what the scale itself
    // read. Was editing scale instead, with gasLeft only a side-effect of that math - wrong
    // field to be correcting. Tare (the cylinder's own known empty weight) is treated as the
    // fixed anchor and scale is back-computed (scale=gasLeft+tare) so the three stay
    // arithmetically consistent, rather than leaving a stale scale reading sitting there.
    (st.manifold||[]).filter(inBr).forEach(function(r,idx){
      out.push({label:(r.stage||'Opening')+' · '+r.cyl+' · gas left='+r.gasLeft+'kg (edit)', get:function(){return r.gasLeft;}, set:function(v){r.gasLeft=v;r.scale=num(v)+num(r.tare);}, tag:'Manifold '+(r.stage||'Opening')+' '+r.cyl+' gasLeft', row:r});
    });
  }
```
Change to:
```javascript
  } else if(section==='Manifold'){
    // Correct gas left (kg) directly - it's the figure that actually matters downstream
    // (manifoldBalance(), computeManifoldMismatches() both read r.gasLeft, never re-derive
    // it from scale/tare), and it's what a manager actually knows when fixing a mistake
    // (a re-check found the cylinder had X kg left), not necessarily what the scale itself
    // read. Was editing scale instead, with gasLeft only a side-effect of that math - wrong
    // field to be correcting. Tare (the cylinder's own known empty weight) is treated as the
    // fixed anchor and scale is back-computed (scale=gasLeft+tare) so the three stay
    // arithmetically consistent, rather than leaving a stale scale reading sitting there.
    (st.manifold||[]).filter(inBr).forEach(function(r,idx){
      // A row a Manager/Owner rejected via the Pending Overrides screen surfaces here with
      // an explicit marker + their note, so the operator notices it among the list and
      // recheck/corrects it themselves - see the remote-override-approval design doc's
      // "Rejection handling" section. A row still genuinely PENDING (not yet resolved) is
      // shown too, but as an informational note only - it isn't this picker's job to
      // resolve it, only to make its state visible if someone happens to be looking here.
      var _rejTxt=(r._overrideStatus==='REJECTED')?(' ⚠ REJECTED'+(r._overrideResolutionNote?(': '+r._overrideResolutionNote):'')):((r._overrideStatus==='PENDING')?' ⏳ pending approval':'');
      out.push({label:(r.stage||'Opening')+' · '+r.cyl+' · gas left='+r.gasLeft+'kg (edit)'+_rejTxt, get:function(){return r.gasLeft;}, set:function(v){r.gasLeft=v;r.scale=num(v)+num(r.tare);}, tag:'Manifold '+(r.stage||'Opening')+' '+r.cyl+' gasLeft', row:r});
    });
  }
```

- [ ] **Step 2: Syntax-check** (same command as Task 1). Expected: `ALL SCRIPT BLOCKS OK`

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: surface rejected/pending Manifold overrides in the same-day Adjust picker"
```

---

### Task 7: Live verification and push

No automated test suite exists — verification is live and direct, and must simulate at
least two separate devices/sessions (two browser profiles, or the Claude Browser pane plus
a second real device), not just two tabs sharing the same localStorage.

- [ ] **Step 1: Verify the remote-submit path**

On Device A (Operator): trigger a hard-ceiling reading, confirm through to the new "Is a
Manager or Owner here right now?" prompt, choose Cancel (remote approval). Confirm the row
saves immediately (no password prompt), the operator can continue to the next cylinder, and
`manifold_pending_overrides` gains a matching row (check via the Supabase table editor or a
console `sb.from('manifold_pending_overrides').select('*').then(console.log)`).

- [ ] **Step 2: Verify the Pending Overrides screen**

On Device B (Manager/Owner, logged in separately): confirm the "Pending Overrides" tile
appears on landing with the correct badge count, opening it shows the item from Step 1 with
correct branch/cylinder/kind/reading/submitter.

- [ ] **Step 3: Verify Approve**

On Device B: Approve the item, entering the Manager/Owner's own password. Confirm the item
disappears from the list, `manifold_pending_overrides.status` is `APPROVED` with
`resolved_by`/`resolved_at`/note set correctly, an audit log entry is created, and
`manifold_live_rows`' matching row's `row._overrideStatus` is now `APPROVED`.

- [ ] **Step 4: Verify Reject and the Adjust-picker surface**

Repeat Steps 1-2 for a second reading, this time Reject it with a required note. Confirm the
mirror row updates to `REJECTED` with the note. On Device A (or any device), open the
same-day Adjust tool for Manifold, confirm the rejected row shows the `⚠ REJECTED: <note>`
marker in the picker.

- [ ] **Step 5: Verify the Close Day gate**

With at least one still-PENDING item for a branch, attempt Close Day for that branch —
confirm it's blocked with the correct message. Resolve the pending item (approve or reject),
confirm Close Day is no longer blocked for that reason.

- [ ] **Step 6: Verify the physically-present path is unaffected**

Trigger a hard-ceiling/flagged-band/used-partial reading again, this time answering OK
("a Manager/Owner is here now") — confirm the flow is byte-for-byte identical to before this
feature (password + reason prompt, same messages, same audit log entry shape).

- [ ] **Step 7: Regression-check**

Confirm every other Manifold feature from this session (tolerances, tare-mismatch,
underfill/leftover, live cross-device data, same-day Opening lock) still behaves exactly as
before — none of this task's code touches their paths, but verify live rather than assume.

- [ ] **Step 8: Push**

```bash
git push origin main
```
