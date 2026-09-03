# Pending Overrides Screen Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the Manager/Owner Pending Overrides screen (`index.html`) so each card
shows the full captured reading (not just gas-left/cap), replaces native `prompt()` dialogs
with the app's own `askText()` modal, and adds a "Fix reading" action that deep-links into
the existing same-day Adjust tool for that exact row.

**Architecture:** Purely frontend, single-file (`index.html`), no backend/schema change. A
new join-fetch merges `manifold_live_rows` detail onto the already-fetched
`manifold_pending_overrides` list before render. The card template and `resolvePendingOverride()`
are rewritten in place. "Fix reading" reuses the existing `openCapAdjust()`/`openCorrection()`
correction wizard, extended with an optional `jumpToRid` parameter that skips straight to
editing one specific line instead of showing the full section/line picker.

**Tech Stack:** Vanilla JS (classic `<script>`, no build step), Supabase JS client (`sb`),
existing app CSS variables/idioms only - no new library, no new CSS classes (this file styles
one-off elements inline, matching its own established convention).

---

### Task 1: Join `manifold_live_rows` detail onto pending items

**Files:**
- Modify: `index.html`, near `_fetchManifoldPendingOverrides()` (~line 1157-1185) and
  `openPendingOverrides()` (~line 1192-1218).

- [ ] **Step 1: Add the join-fetch function**

Find (the closing brace of `_fetchManifoldPendingOverrides`, right before `_updatePendingOverridesBadge` is defined):
```javascript
function _updatePendingOverridesBadge(){
```
Insert immediately above it:
```javascript
// Joins full capture detail (brand/gasType/scale/tare/photo/stage) from manifold_live_rows
// onto each already-fetched pending item, keyed by row_rid===row_id - manifold_pending_overrides
// only ever stored gas_left/cap (the two numbers the threshold check needed), never the whole
// line, so this is a real second query, not just a display change. Called only from the
// Pending Overrides screen's own open path (NOT from _fetchManifoldPendingOverrides itself,
// which also runs at login for every role just to populate the badge count - adding this join
// there would fire an extra query on every login even when the screen is never opened).
// Same graceful-degradation shape as the rest of this feature: a row whose live-mirror hasn't
// finished syncing yet (or was never found) simply renders without the extra detail below,
// not an error.
function _fetchPendingOverrideLiveDetails(){
  var rids=_manifoldPendingOverrides.map(function(p){return p.row_rid;}).filter(Boolean);
  if(!rids.length)return Promise.resolve();
  return sb.from('manifold_live_rows').select('row_id,row').in('row_id',rids).then(function(res){
    if(res.error){console.error('_fetchPendingOverrideLiveDetails failed:',res.error.message);return;}
    var byRid={};
    (res.data||[]).forEach(function(rec){byRid[rec.row_id]=rec.row||{};});
    _manifoldPendingOverrides.forEach(function(p){
      var live=p.row_rid&&byRid[p.row_rid];
      if(!live)return;
      p._liveBrand=live.brand;p._liveGasType=live.gasType;p._liveScale=live.scale;
      p._liveTare=live.tare;p._livePhoto=Array.isArray(live.photo)?live.photo:[];p._liveStage=live.stage||'Opening';
    });
  },function(e){console.error('_fetchPendingOverrideLiveDetails rejected:',e&&e.message);});
}
function _updatePendingOverridesBadge(){
```

- [ ] **Step 2: Chain it into `openPendingOverrides()`'s fetch**

Find:
```javascript
  try{
    _fetchManifoldPendingOverrides().then(renderPendingOverrides,function(e){
      console.error('openPendingOverrides: fetch chain failed:',e&&e.message);
      toast('Could not refresh pending overrides — showing last known list',true);
      renderPendingOverrides();
    });
  }catch(e){
```
Change to:
```javascript
  try{
    _fetchManifoldPendingOverrides().then(function(){
      return _fetchPendingOverrideLiveDetails();
    }).then(renderPendingOverrides,function(e){
      console.error('openPendingOverrides: fetch chain failed:',e&&e.message);
      toast('Could not refresh pending overrides — showing last known list',true);
      renderPendingOverrides();
    });
  }catch(e){
```

- [ ] **Step 3: Syntax-check**

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

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: join manifold_live_rows detail onto pending overrides"
```

---

### Task 2: Redesign the card template

**Files:**
- Modify: `index.html`, `renderPendingOverrides()` (~line 1220-1236).

- [ ] **Step 1: Replace the card-building loop**

Find:
```javascript
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
Change to:
```javascript
var _PENDING_OVERRIDE_KIND_ICON={HARD_CEILING:'🔴',FLAGGED_BAND:'🟠',USED_PARTIAL:'🔵'};
var _PENDING_OVERRIDE_KIND_COLOR={HARD_CEILING:'var(--bad)',FLAGGED_BAND:'var(--amber)',USED_PARTIAL:'var(--navy)'};
function _pendingOverrideExpectedLine(item){
  if(item.kind==='USED_PARTIAL'){
    return 'Declared used/partial cylinder — '+(item.gas_left!=null?num(item.gas_left).toFixed(2)+'kg':'—');
  }
  if(item.gas_left==null||item.cap==null)return '';
  return 'Expected ≤ '+num(item.cap).toFixed(1)+'kg → Got '+num(item.gas_left).toFixed(2)+'kg';
}
function renderPendingOverrides(){
  var box=document.getElementById('pendingOverridesBody');if(!box)return;
  if(!_manifoldPendingOverrides.length){box.innerHTML='<div class="histEmpty" style="text-align:center;padding:20px">No pending overrides ✓</div>';return;}
  var html='';
  _manifoldPendingOverrides.forEach(function(item){
    var kindLabel=_PENDING_OVERRIDE_KIND_LABELS[item.kind]||item.kind||'';
    var icon=_PENDING_OVERRIDE_KIND_ICON[item.kind]||'⚪';
    var color=_PENDING_OVERRIDE_KIND_COLOR[item.kind]||'var(--amber)';
    var expLine=_pendingOverrideExpectedLine(item);
    var hasDetail=item._liveBrand!==undefined||item._liveScale!==undefined;
    var detailLine=hasDetail?((item._liveBrand||'')+' '+(item._liveGasType||'')+' · Scale '+(item._liveScale!=null?num(item._liveScale).toFixed(2):'—')+'kg · Tare '+(item._liveTare!=null?num(item._liveTare).toFixed(2):'—')+'kg'):'';
    var photoHtml=(item._livePhoto&&item._livePhoto.length)?('<div style="margin:6px 0">'+item._livePhoto.map(function(s){return '<img src="'+s+'" style="max-height:70px;border-radius:6px;margin-right:4px">';}).join('')+'</div>'):'';
    var othersCount=_manifoldPendingOverrides.filter(function(x){return x.id!==item.id && x.branch===item.branch && x.submitted_by_name_snapshot===item.submitted_by_name_snapshot;}).length;
    var patternNote=othersCount?('<div style="font-size:11px;color:var(--amber);margin-top:4px">'+othersCount+' other pending item'+(othersCount===1?'':'s')+' from this operator/branch today</div>'):'';
    html+='<div class="histSection" style="border-left:4px solid '+color+';border-top:1px solid var(--line);border-right:1px solid var(--line);border-bottom:1px solid var(--line)">'+
      '<div style="font-weight:700">'+icon+' '+(item.branch||'')+' — '+(item.cyl||'')+' — '+kindLabel+'</div>'+
      (expLine?('<div style="font-size:12px;color:var(--ink);margin:4px 0;font-weight:600">'+expLine+'</div>'):'')+
      (detailLine?('<div style="font-size:12px;color:var(--muted)">'+detailLine+'</div>'):'')+
      photoHtml+
      '<div style="font-size:11px;color:var(--muted);margin-top:4px">Submitted by '+(item.submitted_by_name_snapshot||'—')+' · '+(item.submitted_at?new Date(item.submitted_at).toLocaleString():'')+'</div>'+
      patternNote+
      '<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">'+
        '<button class="saveBtn" onclick="resolvePendingOverride(\''+item.id+'\',\'APPROVED\')">Approve</button>'+
        '<button class="saveBtn" style="background:var(--bad)" onclick="resolvePendingOverride(\''+item.id+'\',\'REJECTED\')">Reject</button>'+
        (item.row_rid?('<button class="saveBtn" style="background:var(--steel)" onclick="_fixManifoldReading(\''+item.id+'\')">Fix reading</button>'):'')+
      '</div></div>';
  });
  box.innerHTML=html;
}
```

Note: `_fixManifoldReading` takes the pending item's `id` (not the whole object) so it can
look the item back up from `_manifoldPendingOverrides` at click time - built in Task 4.

- [ ] **Step 2: Syntax-check** (same command as Task 1 Step 3). Expected: `ALL SCRIPT BLOCKS OK`

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: redesign Pending Overrides card layout with full detail"
```

---

### Task 3: Replace `prompt()` with `askText()` in `resolvePendingOverride()`

**Files:**
- Modify: `index.html`, `resolvePendingOverride()` (~line 1259-1297).

- [ ] **Step 1: Replace the whole function** (restructures one function into two - full
  before/after shown, apply as a single replacement, not a fragmented diff)

Find (the complete current function, verify against the live file first - this must match
exactly):
```javascript
function resolvePendingOverride(id,decision){
  if(!(role==='Manager'||role==='Owner')){toast('Manager or Owner only',true);return;}
  var item=_manifoldPendingOverrides.filter(function(x){return x.id===id;})[0];
  if(!item){toast('Item no longer pending',true);return;}
  if(role==='Manager' && (_curUser().branches||[]).indexOf(item.branch)===-1){toast('Not your branch',true);return;}
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
    sb.from('manifold_pending_overrides').update({status:decision,resolved_by:auth.id,resolved_by_name_snapshot:auth.name,resolved_at:new Date().toISOString(),resolution_note:note.trim()}).eq('id',id).eq('status','PENDING').select().then(function(res){
      if(res.error){toast('Could not save: '+res.error.message,true);return;}
      // .eq('status','PENDING') above means this update only actually applies if the item
      // was STILL pending at the moment it ran - if someone else (or a second tap from this
      // same device) already resolved it, zero rows match and .select() comes back empty.
      // Without this, two competing resolutions would silently overwrite each other with no
      // warning to either person.
      if(!res.data||!res.data.length){
        toast('This item was already resolved by someone else — refreshing the list',true);
        _manifoldPendingOverrides=_manifoldPendingOverrides.filter(function(x){return x.id!==id;});
        _updatePendingOverridesBadge();
        renderPendingOverrides();
        return;
      }
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
Replace with (two functions - `resolvePendingOverride` now only handles auth + note
collection via `askText()`, then hands off to `_resolvePendingOverrideFinish` for the actual
update; `item` is passed through explicitly since it's no longer in the same closure):
```javascript
function resolvePendingOverride(id,decision){
  if(!(role==='Manager'||role==='Owner')){toast('Manager or Owner only',true);return;}
  var item=_manifoldPendingOverrides.filter(function(x){return x.id===id;})[0];
  if(!item){toast('Item no longer pending',true);return;}
  if(role==='Manager' && (_curUser().branches||[]).indexOf(item.branch)===-1){toast('Not your branch',true);return;}
  var qualifies=function(p){return p.level==='Manager'||p.level==='Owner';};
  var authPromise=(currentProfile && qualifies(currentProfile))?_selfReauth((decision==='APPROVED'?'Approve':'Reject')+' this override?'):_borrowAuth('Manager or Owner',(decision==='APPROVED'?'Approve':'Reject')+' this override?',qualifies);
  authPromise.then(function(auth){
    if(!auth){toast('Manager or Owner password required',true);return;}
    var notePromise=(decision==='REJECTED')
      ? askText('Reason for rejecting this reading','Required before this can be rejected:','')
      : askText('Optional note','Leave blank to skip:','');
    notePromise.then(function(noteRaw){
      if(noteRaw===null)return; // cancelled
      var note=(noteRaw||'').trim();
      if(decision==='REJECTED' && !note){toast('A reason is required to reject',true);return;}
      _resolvePendingOverrideFinish(id,decision,note,auth,item);
    });
  });
}
function _resolvePendingOverrideFinish(id,decision,note,auth,item){
  sb.from('manifold_pending_overrides').update({status:decision,resolved_by:auth.id,resolved_by_name_snapshot:auth.name,resolved_at:new Date().toISOString(),resolution_note:note}).eq('id',id).eq('status','PENDING').select().then(function(res){
    if(res.error){toast('Could not save: '+res.error.message,true);return;}
    // .eq('status','PENDING') above means this update only actually applies if the item
    // was STILL pending at the moment it ran - if someone else (or a second tap from this
    // same device) already resolved it, zero rows match and .select() comes back empty.
    // Without this, two competing resolutions would silently overwrite each other with no
    // warning to either person.
    if(!res.data||!res.data.length){
      toast('This item was already resolved by someone else — refreshing the list',true);
      _manifoldPendingOverrides=_manifoldPendingOverrides.filter(function(x){return x.id!==id;});
      _updatePendingOverridesBadge();
      renderPendingOverrides();
      return;
    }
    _updateManifoldLiveRowOverrideStatus(item.row_rid,decision,note);
    auditLog('Manifold override '+decision.toLowerCase(),(item.branch||'')+' — '+(item.cyl||'')+' — '+(item.kind||'')+' — by '+auth.name+(note?(' — '+note):''));
    toast('Override '+decision.toLowerCase()+' ✓');
    _manifoldPendingOverrides=_manifoldPendingOverrides.filter(function(x){return x.id!==id;});
    _updatePendingOverridesBadge();
    renderPendingOverrides();
  },function(e){toast('Network error — check your connection',true);});
}
```

- [ ] **Step 2: Syntax-check** (same command as Task 1 Step 3). Expected: `ALL SCRIPT BLOCKS OK`

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: replace prompt() with askText() in resolvePendingOverride"
```

---

### Task 4: "Fix reading" deep-link into the same-day Adjust tool

**Files:**
- Modify: `index.html`, `openCapAdjust()`/`_openCapAdjustReal()` (~line 5823-5866),
  `openCorrection()` (~line 8034-8056), add new `_fixManifoldReading()`.

- [ ] **Step 1: Thread an optional `jumpToRid` through `openCapAdjust()`/`_openCapAdjustReal()`**

Find:
```javascript
function openCapAdjust(){
  if(capType==='manifold'){
    if(openCapAdjustBusy)return;
    openCapAdjustBusy=true;
    var _openCapAdjustFetchType=capType,_openCapAdjustFetchBranch=capBranch;
    _fetchManifoldLiveRows(capBranch,today).then(function(){
      openCapAdjustBusy=false;
      if(capType===_openCapAdjustFetchType&&capBranch===_openCapAdjustFetchBranch)_openCapAdjustReal();
    },function(){
      openCapAdjustBusy=false;
      if(capType===_openCapAdjustFetchType&&capBranch===_openCapAdjustFetchBranch)_openCapAdjustReal();
    });
    return;
  }
  _openCapAdjustReal();
}
function _openCapAdjustReal(){
  var sectionName=CAP_ADJUST_SECTION[capType];
  if(!sectionName){toast('Not available for this section',true);return;}
  if(loadSavedDay(today,capBranch)){toast('Day already closed for '+capBranch+' - use the correction tool from Count History instead',true);return;}
  var c=CAP[capType];
  var todaysStore={};
  todaysStore[capType]=(store[capType]||[]).filter(function(r){return r.branch===capBranch && (r._date||today)===today;});
  openCorrection({
    title:'Adjust '+c.title+' — '+capBranch+' (today, before close)',
    store:todaysStore, branch:capBranch, sections:[sectionName],
```
Change to:
```javascript
function openCapAdjust(jumpToRid){
  if(capType==='manifold'){
    if(openCapAdjustBusy)return;
    openCapAdjustBusy=true;
    var _openCapAdjustFetchType=capType,_openCapAdjustFetchBranch=capBranch;
    _fetchManifoldLiveRows(capBranch,today).then(function(){
      openCapAdjustBusy=false;
      if(capType===_openCapAdjustFetchType&&capBranch===_openCapAdjustFetchBranch)_openCapAdjustReal(jumpToRid);
    },function(){
      openCapAdjustBusy=false;
      if(capType===_openCapAdjustFetchType&&capBranch===_openCapAdjustFetchBranch)_openCapAdjustReal(jumpToRid);
    });
    return;
  }
  _openCapAdjustReal(jumpToRid);
}
function _openCapAdjustReal(jumpToRid){
  var sectionName=CAP_ADJUST_SECTION[capType];
  if(!sectionName){toast('Not available for this section',true);return;}
  if(loadSavedDay(today,capBranch)){toast('Day already closed for '+capBranch+' - use the correction tool from Count History instead',true);return;}
  var c=CAP[capType];
  var todaysStore={};
  todaysStore[capType]=(store[capType]||[]).filter(function(r){return r.branch===capBranch && (r._date||today)===today;});
  openCorrection({
    title:'Adjust '+c.title+' — '+capBranch+' (today, before close)',
    store:todaysStore, branch:capBranch, sections:[sectionName], jumpToRid:jumpToRid||null,
```

- [ ] **Step 2: Make `openCorrection()` honor `cfg.jumpToRid`**

Find:
```javascript
  authPromise.then(function(auth){
    if(!auth){toast('Manager or Owner password required',true);return;}
    corrCfg=cfg;corrAuth=auth;
    document.getElementById('corrTitle').textContent=cfg.title||'Log a correction';
    document.getElementById('corrModal').classList.add('show');
    corrStepSection();
  });
}
```
Change to:
```javascript
  authPromise.then(function(auth){
    if(!auth){toast('Manager or Owner password required',true);return;}
    corrCfg=cfg;corrAuth=auth;
    document.getElementById('corrTitle').textContent=cfg.title||'Log a correction';
    document.getElementById('corrModal').classList.add('show');
    // Deep-link support: when the caller already knows exactly which line needs fixing
    // (Pending Overrides' "Fix reading" button), skip the section-and-line pickers entirely
    // and land straight on that line's edit screen - only meaningful when there's exactly one
    // section to search (Manifold, here), matching how this is actually invoked.
    if(cfg.jumpToRid && cfg.sections && cfg.sections.length===1){
      corrStepLines(cfg.sections[0]);
      var _lines=corrCfg._lines||[];
      var _idx=-1;
      for(var i=0;i<_lines.length;i++){ if(_lines[i].row && _lines[i].row._rid===cfg.jumpToRid){_idx=i;break;} }
      if(_idx>-1){corrStepEdit(_idx);return;}
      toast('Could not find that exact line — showing the full list instead',true);
    }
    corrStepSection();
  });
}
```

- [ ] **Step 3: Add `_fixManifoldReading()`**

Find (right after `renderPendingOverrides` closes, from Task 2's rewrite - the last line of
that function is `box.innerHTML=html;\n}`):
```javascript
      '</div></div>';
  });
  box.innerHTML=html;
}
```
Insert immediately after it:
```javascript
// "Fix reading" from Pending Overrides: navigates into Manifold capture for the item's own
// branch+stage (a Manager/Owner reviewing overrides may be looking at a DIFFERENT branch's
// item than whichever branch capture last had open - capSetBranch() below already blocks an
// Operator from doing this, but this whole screen is Manager/Owner-only anyway), then opens
// the existing same-day Adjust tool jumped straight to this exact row instead of a fresh
// unfiltered picker. Deliberately does NOT auto-resolve the pending item - correcting the
// number and authorising the reading are kept as two distinct, separately-audited actions;
// the Manager returns to this screen afterward and taps Approve normally, now approving the
// corrected value.
function _fixManifoldReading(id){
  var item=_manifoldPendingOverrides.filter(function(x){return x.id===id;})[0];
  if(!item){toast('Item no longer pending',true);return;}
  if(!item.row_rid){toast('No linked reading to fix — the original capture may not have finished syncing yet',true);return;}
  openCap('manifold');
  if(capBranch!==item.branch)capSetBranch(item.branch);
  var stage=item._liveStage||'Opening';
  if(toggleSel.stage!==stage)setToggle('stage',stage);
  openCapAdjust(item.row_rid);
}
```

- [ ] **Step 4: Syntax-check** (same command as Task 1 Step 3). Expected: `ALL SCRIPT BLOCKS OK`

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat: Fix reading deep-link from Pending Overrides into same-day Adjust"
```

---

### Task 5: Live verification and push

No automated test suite exists - verification is live and direct, on the real deployed app,
using the SAME technique established during this session's earlier debugging: run diagnostic/
seed queries in the OPERATOR's own logged-in browser console (`sb` is globally accessible),
never an anon/unauthenticated one.

- [ ] **Step 1: Seed a realistic pending item to test against**

If no real pending override currently exists, trigger one live: open Manifold capture as an
Operator, weigh a cylinder to a value that trips the flagged-band or hard-ceiling check (see
`addLine()` ~line 6653: cap is 48kg LPG/45kg Propane, flagged-band tolerance on top of that),
choose "submit for remote approval" at the confirm prompt. Confirm it appears in
`manifold_pending_overrides` (same console-query technique as before:
`sb.from('manifold_pending_overrides').select('*').eq('status','PENDING').then(r=>console.log(JSON.stringify(r.data,null,2)))`).

- [ ] **Step 2: Verify the card shows full detail**

Log in as Manager/Owner, open Pending Overrides. Confirm: icon + coloured left border matches
the kind; "Expected ≤ Xkg → Got Ykg" line shows correct numbers; brand/gasType/scale/tare line
shows the real captured values (not blank) — confirms Task 1's join actually landed data, not
just that it didn't error. If a photo was captured with the reading, confirm it renders inline.

- [ ] **Step 3: Verify the pattern note**

Seed a second pending item for the same branch+operator (repeat Step 1 once more). Confirm
both cards now show "1 other pending item from this operator/branch today".

- [ ] **Step 4: Verify `askText()` replaced `prompt()`**

Tap Reject on one item. Confirm the app's own styled text-input modal appears (matching
`manifoldWeightOverride()`'s reason prompt elsewhere in the app), NOT a native browser
`window.prompt()` dialog. Leave it blank and confirm — should block with "A reason is
required to reject" and stay open. Enter a reason, confirm — item resolves, disappears from
the list, resolution note correctly saved (spot-check via
`sb.from('manifold_pending_overrides').select('resolution_note').eq('id','<id>').then(...)`
if the row is still queryable, or just trust the audit log entry). Repeat for Approve with a
blank note (should succeed - note is optional there).

- [ ] **Step 5: Verify "Fix reading"**

Seed one more pending item. Tap "Fix reading". Confirm: navigates into Manifold capture for
the correct branch (not necessarily the Manager's own login branch — test with a
Manager/Owner viewing a DIFFERENT branch's pending item if possible) and correct stage tab;
the Adjust tool opens with the correction screen for THAT EXACT cylinder already showing
(current value pre-filled), not the section/line picker. Apply a correction. Confirm: the
underlying value changes (spot-check via `store.manifold` or a re-fetch), the item is STILL
PENDING back on the Pending Overrides screen (not auto-resolved) with the corrected number
now reflected in the card's detail line, and an Adjustments/audit-log entry exists for the
correction, separate from the eventual Approve's own audit entry. Then tap Approve on it —
confirm it resolves normally with the corrected value.

- [ ] **Step 6: Regression-check**

Confirm every other Pending Overrides behaviour is unaffected: the branch-scoped visibility
for a restricted Manager (only sees their own branches' items), the race-guard on two people
resolving the same item at once (`.eq('status','PENDING')` still gates the update), the
badge count on Admin/wherever it's shown still updates correctly after a resolution.

- [ ] **Step 7: Push**

```bash
git push origin main
```
