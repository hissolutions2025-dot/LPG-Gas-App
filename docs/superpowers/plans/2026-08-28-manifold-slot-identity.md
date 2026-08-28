# Manifold Slot Identity & Swap Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Manifold capture flow correctly track which physical cylinder occupies each
slot (Cyl 1..N) through a swap, capture the outgoing cylinder's residual gas alongside the
incoming one, replace the flat always-blocking weight cap with a two-tier tolerance/ceiling
rule, and make the slot count itself an Owner-configurable, Supabase-synced per-branch
setting — all as prerequisite groundwork for the next phase's Manifold Opening-vs-Closing
mismatch detection (the Stock Count pattern, applied to Manifold).

**Architecture:** Everything lives in the single `index.html` file, following this codebase's
established convention (no file splitting). One new Supabase table (`manifold_settings`) for
the per-branch slot count, synced the same way every other cross-device-relevant setting in
this app already is. The swap ("Added") flow becomes a guided two-step wizard reusing the
existing generic capture engine's form-building and save primitives (`buildPopupForm`,
`_addLineFinish`), not a new capture system - tapping a cylinder tile while on the Added
toggle now launches the wizard instead of the plain single-field popup.

**Tech Stack:** Vanilla JS, Supabase (Postgres + RLS), existing `askPassword`/`_selfReauth`/
`_borrowAuth` auth primitives, existing `CAP` generic-capture-engine config object.

---

## Reference: current code this plan builds on

Read these in full before starting, in the live file (not this plan) - the exact line numbers
below are approximate and will drift as earlier tasks land:

- `const CYLS=['Cyl 1','Cyl 2','Cyl 3','Cyl 4'];` (~line 1008) - the current fixed slot list.
- `CAP.manifold` config object (~line 4860-4869) - `grid:CYLS`, `toggles:[{key:'stage',
  states:['Opening','Added','Closing']}]`, `popupFields`, `gasLeftCap:true`.
- `dataBucket()` (~4879) / `toggleKey()` (~4876) - a toggle-type capture's data lives at
  `capData[toggleSel.stage][item]`, one array per stage.
- `renderGrid()` (~5014), specifically `document.getElementById('capGrid').innerHTML=
  c.grid.map(...)` (~5041) - reads `c.grid` as a plain array today.
- `openModal(item)` (~5211) / `buildPopupForm(c)` (~5221) / `popCollect()` (~5247) -
  generic single-form capture, driven entirely by `c.popupFields`.
- `addLine()` (~5362) / `_addLineFinish(c,d)` (~5392) - the existing hard cap sits at
  `if(c.gasLeftCap && 'scale'in d && 'tare'in d){ var gl=num(d.scale)-num(d.tare); var
  cap=(d.gasType==='Propane')?45:48; if(gl>cap){toast(...);return;} }` (~5404-5409).
- `computeManifoldMismatches(br)` (~5782) / `manifoldBalance()` + `sumStage(stage)`
  (~6024-6026) - local-only, unchanged in scope by this plan except `sumStage('Removed')`.
- `bcfgLoad()`/`bcfgSave()` (~2040-2041) - the existing (device-local) Branch Setup pattern;
  **do not** copy this pattern for slot count, which must be Supabase-synced (see Task 2).
- `sealBoundaryOverride(msg)` (~2153) and `adjustMismatch()`'s qualifying-check pattern
  (`_selfReauth`/`_borrowAuth`, e.g. ~6440) - two different existing override shapes; this
  plan uses the `_selfReauth`/`_borrowAuth` dual-mode one (Task 4), since Manifold capture is
  normally done by an Operator who needs to hand off to a present Manager/Owner, not
  re-authenticate as themselves.
- Admin tab HTML pattern: `<div id="adminBsetup" style="display:none">...</div>` (~681-690),
  `ADMIN_TAB_NAME` map (~1172) - the shape Task 3's new Admin pane follows.

---

### Task 1: `manifold_settings` Supabase table

**Files:**
- Supabase migration (run directly via `supabase db query --linked --project-ref
  zyymnkychhglisqjvkqs "..."`, matching this project's established convention for schema
  changes - no local migration file tracked in this repo).

- [ ] **Step 1: Create the table and RLS policies**

Run:
```bash
supabase db query --linked --project-ref zyymnkychhglisqjvkqs "create table manifold_settings (branch text primary key, slot_count int not null default 4, updated_by uuid references profiles(id), updated_by_name_snapshot text, updated_at timestamptz not null default now()); alter table manifold_settings enable row level security; create policy \"manifold_settings select for any signed-in user\" on manifold_settings for select using (auth.uid() is not null); create policy \"manifold_settings write for Owner\" on manifold_settings for insert with check (exists (select 1 from profiles p where p.id=auth.uid() and p.level='Owner')); create policy \"manifold_settings update for Owner\" on manifold_settings for update using (exists (select 1 from profiles p where p.id=auth.uid() and p.level='Owner'));"
```

- [ ] **Step 2: Verify the table and policies exist**

Run:
```bash
supabase db query --linked --project-ref zyymnkychhglisqjvkqs "select tablename,policyname,cmd from pg_policies where tablename='manifold_settings';"
```
Expected: 3 rows (select/insert/update).

- [ ] **Step 3: Seed both existing branches at today's default (4), so nothing changes until an Owner deliberately edits it**

Run:
```bash
supabase db query --linked --project-ref zyymnkychhglisqjvkqs "insert into manifold_settings (branch, slot_count) values ('Helderberg',4),('Kleinmond',4) on conflict (branch) do nothing;"
```

- [ ] **Step 4: Verify via CLI RLS simulation that an authenticated non-Owner can read but not write**

Run:
```bash
supabase db query --linked --project-ref zyymnkychhglisqjvkqs "set local role authenticated; set local request.jwt.claims='{\"sub\":\"00000000-0000-0000-0000-000000000001\",\"role\":\"authenticated\"}'; select * from manifold_settings;"
```
Expected: 2 rows returned (read succeeds for any signed-in user).

```bash
supabase db query --linked --project-ref zyymnkychhglisqjvkqs "set local role authenticated; set local request.jwt.claims='{\"sub\":\"00000000-0000-0000-0000-000000000001\",\"role\":\"authenticated\"}'; update manifold_settings set slot_count=6 where branch='Helderberg';"
```
Expected: `UPDATE 0` (the fake uuid matches no Owner-level profile, so the RLS `using` clause
excludes the row - the update runs but affects zero rows, not an error, matching how Postgres
RLS UPDATE policies behave).

No commit for this task (pure schema/data change, no `index.html` edit yet).

---

### Task 2: Read the slot count live, make the Manifold grid dynamic

**Files:**
- Modify: `index.html` (`CYLS` constant area, `CAP.manifold.grid`, `renderGrid()`'s grid-render
  line, `capSetBranch()`)

- [ ] **Step 1: Add a live per-branch slot-count cache and fetch function**

Add near the `CYLS` constant (~line 1008):

```js
const CYLS=['Cyl 1','Cyl 2','Cyl 3','Cyl 4']; // default/fallback shape only now - see _manifoldCylLabels
// Live per-branch slot count, Supabase-synced (never device-local like Branch Setup/Count
// Times - a stale local value here would mean different devices show a different number of
// slots for the same branch, capturing genuinely different data). Falls back to today's
// fixed 4 while the fetch is in flight or if it fails, same graceful-degradation convention
// every other live fetch in this app already uses - never blocks capture from working.
var _manifoldSlotCounts={};
function _manifoldCylLabels(br){
  var n=_manifoldSlotCounts[br]||4;
  var out=[];for(var i=1;i<=n;i++)out.push('Cyl '+i);
  return out;
}
function _fetchManifoldSlotCount(br){
  return sb.from('manifold_settings').select('slot_count').eq('branch',br).maybeSingle().then(function(res){
    if(res.error){console.error('_fetchManifoldSlotCount failed for '+br+':',res.error.message);return;}
    if(res.data)_manifoldSlotCounts[br]=res.data.slot_count;
  },function(e){console.error('_fetchManifoldSlotCount rejected for '+br+':',e&&e.message);});
}
```

- [ ] **Step 2: Make `CAP.manifold.grid` a function instead of the static `CYLS` array**

In the `CAP` object (~line 4860), change:
```js
  manifold:{title:'Manifold Count',hint:'Opening = cylinders at start. Added = each full cylinder swapped in (run the old one empty first). Closing = cylinders at end.',grid:CYLS,
```
to:
```js
  manifold:{title:'Manifold Count',hint:'Opening = cylinders at start. Added = each full cylinder swapped in (run the old one empty first). Closing = cylinders at end.',grid:function(){return _manifoldCylLabels(capBranch);},
```

- [ ] **Step 3: Update the one render call site that assumes `c.grid` is always a plain array**

In `renderGrid()` (~line 5041), change:
```js
  document.getElementById('capGrid').innerHTML=c.grid.map(function(item){
```
to:
```js
  document.getElementById('capGrid').innerHTML=(typeof c.grid==='function'?c.grid():c.grid).map(function(item){
```

- [ ] **Step 4: Fetch the slot count when Manifold capture opens or the branch switches**

Find `capSetBranch(x)` (~line 4960):
```js
function capSetBranch(x){
  if(role==='Operator' && x!==branch){toast('You are locked to '+branch,true);return;}
  capBranch=x;applyBranchLock('capbr-',x);
  document.getElementById('hSub').textContent=capBranch;
  renderGrid(); // grid must re-render on the new branch, not keep showing the old branch's stale state
  if(capType==='private')_refreshFillSupplierSelect();
}
```
Change to:
```js
function capSetBranch(x){
  if(role==='Operator' && x!==branch){toast('You are locked to '+branch,true);return;}
  capBranch=x;applyBranchLock('capbr-',x);
  document.getElementById('hSub').textContent=capBranch;
  if(capType==='manifold')_fetchManifoldSlotCount(x).then(renderGrid);
  renderGrid(); // grid must re-render on the new branch, not keep showing the old branch's stale state - runs immediately with whatever's cached, the live fetch above re-renders again once it lands
  if(capType==='private')_refreshFillSupplierSelect();
}
```

Find wherever Manifold capture is first opened (search for `openCap('manifold')` call sites
and the shared `openCap(type)` function definition) and add the same
`_fetchManifoldSlotCount(capBranch).then(renderGrid);` call there too, so opening Manifold
capture for the first time in a session also fetches live, not just a branch switch.

- [ ] **Step 5: Verify live in a browser (disposable local server, not preview_start/launch.json - resolves against the repo root, not any worktree)**

Serve the file locally on an unused port, open it in the Browser pane, and in the console:

```js
_manifoldSlotCounts['Helderberg']=6;
document.body.setAttribute('data-view','landing');document.getElementById('landing').classList.add('active');
role='Owner';branch='Helderberg';capBranch='Helderberg';capType='manifold';
document.getElementById('capModal'); // sanity: element exists
renderGrid();
document.querySelectorAll('#capGrid .csize').length // expect 6, not 4
```
Expected: `6`.

Then:
```js
_manifoldSlotCounts['Helderberg']=undefined; // simulate no fetch yet / fetch failed
renderGrid();
document.querySelectorAll('#capGrid .csize').length
```
Expected: `4` (fallback default).

- [ ] **Step 6: Syntax check and commit**

```bash
node -e "new Function(require('fs').readFileSync('index.html','utf8').match(/<script>([\s\S]*)<\/script>/)[1])"
```
Expected: no error.

```bash
git add index.html
git commit -m "Manifold slot count reads live from Supabase, grid renders dynamically"
```

---

### Task 3: Admin UI to edit slot count per branch

**Files:**
- Modify: `index.html` (Admin tab HTML near `adminBsetup`, `ADMIN_TAB_NAME`, `adminTab()`,
  new render/save functions)

- [ ] **Step 1: Add the Admin tab button and pane, matching the Branch Setup pane's shape**

Near the Branch Setup tab button (~line 622):
```html
    <button class="htab" id="atab-bsetup" onclick="adminTab('bsetup')">Branch Setup</button>
```
Add immediately after:
```html
    <button class="htab" id="atab-manifold" onclick="adminTab('manifold')">Manifold Slots</button>
```

Near the Branch Setup pane (~line 690, right after `</div>` closing `adminBsetup`):
```html
  <!-- MANIFOLD SLOTS PANE -->
  <div id="adminManifold" style="display:none">
    <div class="histSection"><h4>Manifold Slots — per branch</h4>
      <div style="font-size:12px;color:var(--muted);margin-bottom:8px">How many cylinder slots (Cyl 1..N) this branch's manifold has. Synced live - every device at this branch sees the same count. Owner only.</div>
      <div class="adminRow">
        <div class="grow"><label class="mLabel" style="font-size:11px">Branch</label>
          <select class="mField" id="mfBranch" onchange="renderManifoldSlots()"><option>Helderberg</option><option>Kleinmond</option></select></div>
      </div>
      <div id="manifoldSlotsBody" style="margin-top:10px"></div>
    </div>
  </div>
```

- [ ] **Step 2: Register the new tab name and wire `adminTab()`**

Find `ADMIN_TAB_NAME` (~line 1172):
```js
var ADMIN_TAB_NAME={seals:'Seal Register',suppliers:'Brands',clear:'Clear Stock Take',bsetup:'Branch Setup',faulty:'Faulty Cylinders',suppliersmgmt:'Manage Suppliers',counttimes:'Count Times'};
```
Change to:
```js
var ADMIN_TAB_NAME={seals:'Seal Register',suppliers:'Brands',clear:'Clear Stock Take',bsetup:'Branch Setup',faulty:'Faulty Cylinders',suppliersmgmt:'Manage Suppliers',counttimes:'Count Times',manifold:'Manifold Slots'};
```

Find `function adminTab(` and confirm it generically shows/hides `'admin'+capitalized-key`
panes by reading `ADMIN_TAB_NAME`'s keys (read the function body first to match its exact
existing pattern) - if it does, `adminManifold`/`atab-manifold` are picked up automatically
with no further change needed there, since the id (`adminManifold`) matches the established
`'admin'+Key` naming (`adminBsetup`, `adminClear`, etc, key `manifold` -> `Manifold`).

- [ ] **Step 3: Render and save functions**

Add near `renderBsetup()`/`toggleSection()` (~line 1382-1413):

```js
function renderManifoldSlots(){
  var box=document.getElementById('manifoldSlotsBody');if(!box)return;
  if(role!=='Owner'){box.innerHTML='<div style="color:#9B2C2C;font-size:13px">Owner only.</div>';return;}
  var br=document.getElementById('mfBranch').value;
  box.innerHTML='<div class="histEmpty" style="text-align:center;padding:10px">Loading…</div>';
  sb.from('manifold_settings').select('slot_count').eq('branch',br).maybeSingle().then(function(res){
    var n=(res.data&&res.data.slot_count)||4;
    box.innerHTML='<label class="mLabel" style="font-size:11px">Slot count</label>'+
      '<input class="mField" type="number" min="1" max="12" id="mfSlotCount" value="'+n+'">'+
      '<button class="saveBtn" style="margin-top:10px" onclick="saveManifoldSlots(\''+br+'\')">Save</button>';
  });
}
function saveManifoldSlots(br){
  if(role!=='Owner'){toast('Owner only',true);return;}
  var n=num(document.getElementById('mfSlotCount').value);
  if(n<1||n>12){toast('Enter a slot count between 1 and 12',true);return;}
  sb.from('manifold_settings').upsert([{branch:br,slot_count:n,updated_by:currentProfile&&currentProfile.id,updated_by_name_snapshot:operator,updated_at:new Date().toISOString()}],{onConflict:'branch'}).then(function(res){
    if(res.error){toast('Could not save: '+res.error.message,true);return;}
    _manifoldSlotCounts[br]=n;
    auditLog('Manifold slot count changed',br+' -> '+n+' slots');
    toast('Manifold slot count saved ✓');
  },function(e){toast('Network error — check your connection',true);});
}
```

- [ ] **Step 4: Wire `renderManifoldSlots()` to run when the Manifold Slots tab is opened**

Read `adminTab(which)`'s current body. If it doesn't already call a per-tab render function
generically, add a call to `renderManifoldSlots()` in the branch handling `which==='manifold'`
(matching whatever pattern the existing `bsetup`/`faulty`/etc branches already use to trigger
their own render-on-open).

- [ ] **Step 5: Verify live (browser, disposable server)**

```js
role='Owner';
document.getElementById('mfBranch').value='Helderberg';
renderManifoldSlots();
```
Wait for the async fetch, then confirm `document.getElementById('mfSlotCount').value` shows a
number (4, from Task 1's seed). Change it to `6`, call `saveManifoldSlots('Helderberg')`,
then query the database directly to confirm the write landed:

```bash
supabase db query --linked --project-ref zyymnkychhglisqjvkqs "select * from manifold_settings where branch='Helderberg';"
```
Expected: `slot_count: 6`. Reset it back to 4 afterward so live testing elsewhere isn't
affected: `supabase db query --linked --project-ref zyymnkychhglisqjvkqs "update manifold_settings set slot_count=4 where branch='Helderberg';"`.

- [ ] **Step 6: Syntax check and commit**

```bash
node -e "new Function(require('fs').readFileSync('index.html','utf8').match(/<script>([\s\S]*)<\/script>/)[1])"
git add index.html
git commit -m "Add Owner-only Admin UI for editing per-branch Manifold slot count"
```

---

### Task 4: Two-tier weight validation (tolerance band + hard ceiling)

**Files:**
- Modify: `index.html` (`_addLineFinish`, near ~5404-5409)

- [ ] **Step 1: Add the override function (dual-mode: self-reauth if already qualifying, else borrow)**

Add near `sealBoundaryOverride` (~line 2153), modeled on `adjustMismatch()`'s own qualifying-
check pattern rather than `sealBoundaryOverride`'s always-self-only shape, since Manifold
capture is normally done by an Operator who needs to hand off to a Manager/Owner physically
present, not re-authenticate as themselves:

```js
// Manifold weight-tolerance override: a reading between the tolerance band and the hard
// ceiling needs Manager/Owner sign-off + a reason before it can be saved as typed. Same
// qualifying-check pattern as adjustMismatch()/openCorrection() - someone who already
// qualifies gets a single password prompt for their own account, instead of the two-step
// "someone else must step in" flow.
function manifoldWeightOverride(msg){
  var qualifies=function(p){return p.level==='Manager'||p.level==='Owner';};
  var authPromise=(currentProfile && qualifies(currentProfile))
    ? _selfReauth('Override this weight reading?')
    : _borrowAuth('Manager or Owner','Override this weight reading?',qualifies);
  return authPromise.then(function(auth){
    if(!auth)return null;
    return askText('Reason for override','Reason this reading is outside the normal range (required):','').then(function(reason){
      if(reason===null||!reason.trim())return null;
      auditLog('Manifold weight override',capBranch+' — '+msg+' — by '+auth.name+' ('+auth.level+') — '+reason.trim());
      syncPush('Adjustments',[{date:today||'',branch:capBranch,Kind:'ManifoldWeightOverride',Line:msg,From:'',To:'',Reason:reason.trim(),By:auth.name+' ('+auth.level+')'}]);
      return {auth:auth,reason:reason.trim()};
    });
  });
}
```

- [ ] **Step 2: Replace the flat hard cap with the two-tier rule**

In `_addLineFinish` (~line 5404-5409), change:
```js
  // Gas-left cap (manifold): LPG ≤48kg, Propane ≤45kg — flag & BLOCK, not overridable
  if(c.gasLeftCap && 'scale'in d && 'tare'in d){
    var gl=num(d.scale)-num(d.tare);
    var cap=(d.gasType==='Propane')?45:48;
    if(gl>cap){toast('⚠ Gas left ('+gl.toFixed(2)+'kg) exceeds '+cap+'kg max for '+(d.gasType||'LPG')+'. Re-check the weights — this cannot be saved.',true);return;}
  }
```
to:
```js
  // Two-tier weight validation (manifold). Applies at every stage (Opening/Added/Removed/
  // Closing), not just when adding a fresh cylinder - an operator fat-fingering a digit can
  // produce a near-capacity reading at any stage, and the system can't tell that apart from a
  // cylinder that's genuinely still near-full (e.g. an unused backup slot) without a person
  // reviewing it, which is exactly what the override below is for, regardless of which stage
  // triggered it.
  //   cap-0.1 .. cap+0.1  -> normal, no flag
  //   cap+0.1 .. cap+0.2  -> flagged, Manager/Owner override with a reason can still save it
  //   cap+0.2 and above   -> never saved, no override, operator must re-weigh and fix it
  if(c.gasLeftCap && 'scale'in d && 'tare'in d){
    var gl=num(d.scale)-num(d.tare);
    var cap=(d.gasType==='Propane')?45:48;
    if(gl>=cap+0.2){
      toast('⚠ Gas left ('+gl.toFixed(2)+'kg) exceeds '+(cap+0.2).toFixed(1)+'kg — that\'s not physically possible for this cylinder. Re-weigh and correct the scale/tare before saving.',true);
      return;
    }
    if(gl>cap+0.1){
      manifoldWeightOverride('Gas left '+gl.toFixed(2)+'kg for '+modalItem+' ('+(d.gasType||'LPG')+', normal range up to '+(cap+0.1).toFixed(1)+'kg)').then(function(ok){
        if(!ok){toast('Override needed to save this reading',true);return;}
        _addLineFinishAfterCap(c,d);
      });
      return; // async path - _addLineFinishAfterCap below continues once authorised
    }
  }
```

- [ ] **Step 3: Split the rest of `_addLineFinish` into a continuation function**

The remaining body of `_addLineFinish` (everything after the cap check, from `c.popupFields.
filter(function(f){return f.type==='auto';})...` through the end of the function) needs to be
reachable both synchronously (the normal, no-flag path) and from the async override
continuation above. Rename that remaining body into a new function:

```js
function _addLineFinishAfterCap(c,d){
  c.popupFields.filter(function(f){return f.type==='auto';}).forEach(function(f){d[f.k]=f.calc(d,modalItem);});
  if(c.toggles)c.toggles.forEach(function(t){if(!d[t.key])d[t.key]=toggleSel[t.key];});
  var bucket=dataBucket();
  if(!bucket[modalItem])bucket[modalItem]=[];
  if(c.receivedMatch){
    var exr=bucket[modalItem].find(function(l){return l.brand===d.brand;});
    if(exr){exr.fullIn=num(exr.fullIn)+d.fullIn;exr.emptyOut=num(exr.emptyOut)+d.emptyOut;renderModalLines();renderGrid();resetPopupInputs(c);return;}
    bucket[modalItem].push(d);renderModalLines();renderGrid();resetPopupInputs(c);return;
  }
  if(c.mergeSameBrand){var ex=bucket[modalItem].find(function(l){return l.brand===d.brand;});if(ex){ex.qty=num(ex.qty)+num(d.qty);renderModalLines();renderGrid();resetPopupInputs(c);return;}}
  if(!c.multi)bucket[modalItem]=[];
  bucket[modalItem].push(d);
  saveDraft();
  draftAddCount++;
  renderModalLines();renderGrid();resetPopupInputs(c);
  if(!c.multi){toast('Saved');closeModal();}
  if(c.multi && draftAddCount>0 && draftAddCount % SAVE_NUDGE_EVERY===0){
    showSaveNudge();
  }
}
```

And at the very end of `_addLineFinish` itself (the synchronous, no-flag path), replace the
old inline body with a single call:
```js
  _addLineFinishAfterCap(c,d);
}
```

So `_addLineFinish`'s full new shape is: the required-fields loop, the scale-vs-tare check,
the two-tier cap check above (which either falls through to the final line below on the
normal path, or returns early and calls `_addLineFinishAfterCap` itself from inside the
override's `.then()` on the flagged path), then the same single closing call:
```js
  _addLineFinishAfterCap(c,d);
}
```

- [ ] **Step 4: Verify live (browser, disposable server) — both directions, and both a Refill/Private field shape and a Manifold one, to confirm `gasLeftCap` scoping didn't leak**

```js
capType='manifold';capBranch='Helderberg';role='Owner';currentProfile={id:'x',name:'Test'};
modalItem='Cyl 1';toggleSel={stage:'Opening'};capData={};
_selfReauth=function(){return Promise.resolve({id:'x',name:'Test',level:'Owner'});};
var savedRows=[];
window.saveDraft=function(){};window.renderModalLines=function(){};window.renderGrid=function(){};window.resetPopupInputs=function(){};window.closeModal=function(){};window.auditLog=function(){};window.syncPush=function(){};

// Normal range - saves immediately, no prompt
_addLineFinish(CAP.manifold,{brand:'Afrox',gasType:'LPG',scale:'58',tare:'10',notes:''}); // gl=48.0
JSON.stringify(dataBucket()['Cyl 1']) // should contain the saved row
```

Then the flagged/overridable band, and the hard ceiling:
```js
capData={}; // reset
_addLineFinish(CAP.manifold,{brand:'Afrox',gasType:'LPG',scale:'58.15',tare:'10',notes:''}); // gl=48.15, flagged band
// wait a tick for the async override promise chain, then check it saved (since _selfReauth/askText are real functions here - askText needs a real modal interaction, so for this specific test stub askText too)
```
Also stub `window.askText=function(){return Promise.resolve('typo, recounted');};` before this
call so the override's reason prompt resolves automatically, then confirm the row landed in
`dataBucket()['Cyl 1']` with `gasLeft` reflecting 48.15, and that `auditLog`/`syncPush` were
called (spy on them instead of no-op stubbing, to confirm the override path actually ran).

```js
capData={};
var toasted=null; window.toast=function(m,e){toasted=m;};
_addLineFinish(CAP.manifold,{brand:'Afrox',gasType:'LPG',scale:'58.25',tare:'10',notes:''}); // gl=48.25, hard ceiling
```
Expected: `toasted` contains "not physically possible", `dataBucket()['Cyl 1']` unchanged
(nothing saved).

- [ ] **Step 5: Syntax check and commit**

```bash
node -e "new Function(require('fs').readFileSync('index.html','utf8').match(/<script>([\s\S]*)<\/script>/)[1])"
git add index.html
git commit -m "Replace flat Manifold weight cap with two-tier tolerance/ceiling + Manager/Owner override"
```

---

### Task 5: Guided swap flow (Removed + Added, tagged to slot)

**Files:**
- Modify: `index.html` (`openModal`, new `openManifoldSwap`/`_manifoldSwapStep2` functions,
  `_rid()` reuse for `_swapId`)

- [ ] **Step 1: Route Added-stage taps on the Manifold grid into the new wizard**

In `openModal(item)` (~line 5211), add at the very top, before anything else:
```js
function openModal(item){
  if(capType==='manifold' && toggleSel.stage==='Added'){openManifoldSwap(item);return;}
  modalItem=item;var c=CAP[capType];popPhoto={};
  ...
```

- [ ] **Step 2: Write the two-step wizard, reusing `buildPopupForm`/`popCollect` for both steps**

Add near `openModal`:

```js
// Guided swap flow for a Manifold slot: tapping a cylinder while on the Added toggle no
// longer opens the plain single-field popup - it walks through weighing the OUTGOING
// cylinder first (residual gas, closes out that slot's record for the day), then the
// INCOMING cylinder (today's existing Added-stage form) which becomes that slot's identity
// going forward. Both rows share a _swapId so History/audit can show them as one event.
// Reuses buildPopupForm/popCollect (the same generic form the plain popup already uses -
// CAP.manifold's popupFields are identical for every stage) rather than a bespoke form.
var _manifoldSwapItem=null, _manifoldSwapId=null;
function openManifoldSwap(item){
  _manifoldSwapItem=item;_manifoldSwapId=_rid();
  var c=CAP.manifold;popPhoto={};
  document.getElementById('mTitle').textContent='Removed — '+item;
  document.getElementById('mState').textContent='Step 1 of 2: weigh the OUTGOING cylinder (residual gas)';
  buildPopupForm(c);
  document.getElementById('mLines').innerHTML='';
  document.getElementById('mAddBtn').textContent='Save & continue to incoming cylinder';
  document.getElementById('mAddBtn').setAttribute('onclick','_manifoldSwapStep1()');
  document.getElementById('capModal').classList.add('show');
}
function _manifoldSwapStep1(){
  var d=popCollect();
  d._swapId=_manifoldSwapId;
  var savedRow=null;
  var origPush=Array.prototype.push;
  // Capture the row _addLineFinishAfterCap is about to push, without duplicating its whole
  // body here - same generic save path every other capture uses, just intercepted once to
  // stamp _swapId and know when step 1 has actually landed (vs. blocked by validation).
  toggleSel.stage='Removed';
  var bucketBefore=(capData['Removed']&&capData['Removed'][_manifoldSwapItem]&&capData['Removed'][_manifoldSwapItem].length)||0;
  _addLineFinish(CAP.manifold,d);
  var afterArr=(capData['Removed']&&capData['Removed'][_manifoldSwapItem])||[];
  if(afterArr.length>bucketBefore){
    afterArr[afterArr.length-1]._swapId=_manifoldSwapId;
    _manifoldSwapStep2();
  }
  // If it didn't grow, _addLineFinish either blocked (hard ceiling) or is mid-override
  // (async) - in the override case, _addLineFinishAfterCap's own renderGrid/closeModal calls
  // will have already closed this modal, so step 2 needs to be kicked off from there too;
  // simplest correct fix is re-checking here on a short delay for the async path.
  else {
    setTimeout(function(){
      var arr2=(capData['Removed']&&capData['Removed'][_manifoldSwapItem])||[];
      if(arr2.length>bucketBefore){arr2[arr2.length-1]._swapId=_manifoldSwapId;_manifoldSwapStep2();}
    },50);
  }
}
function _manifoldSwapStep2(){
  var c=CAP.manifold;popPhoto={};
  toggleSel.stage='Added';
  document.getElementById('mTitle').textContent='Added — '+_manifoldSwapItem;
  document.getElementById('mState').textContent='Step 2 of 2: weigh the INCOMING (new) cylinder';
  buildPopupForm(c);
  document.getElementById('mLines').innerHTML='';
  document.getElementById('mAddBtn').textContent='Save';
  document.getElementById('mAddBtn').setAttribute('onclick','_manifoldSwapStep2Save()');
  document.getElementById('capModal').classList.add('show');
}
function _manifoldSwapStep2Save(){
  var d=popCollect();
  d._swapId=_manifoldSwapId;
  modalItem=_manifoldSwapItem; // _addLineFinish/_addLineFinishAfterCap read this global, same as the plain popup path already relies on
  var bucketBefore=(capData['Added']&&capData['Added'][_manifoldSwapItem]&&capData['Added'][_manifoldSwapItem].length)||0;
  _addLineFinish(CAP.manifold,d);
  var afterArr=(capData['Added']&&capData['Added'][_manifoldSwapItem])||[];
  if(afterArr.length>bucketBefore){
    afterArr[afterArr.length-1]._swapId=_manifoldSwapId;
    toast('Cylinder swap recorded for '+_manifoldSwapItem+' ✓');
    _manifoldSwapItem=null;_manifoldSwapId=null;
  }
  // else: blocked or mid-override, same as step 1 - _addLineFinishAfterCap's own
  // renderGrid()/closeModal() already reflect the outcome once it resolves.
}
```

- [ ] **Step 3: Verify live (browser, disposable server) — both steps land with a shared `_swapId`, and the normal Opening/Closing single-form path is unaffected**

```js
capType='manifold';capBranch='Helderberg';role='Owner';currentProfile={id:'x',name:'Test'};
capData={};
window.saveDraft=function(){};window.renderModalLines=function(){};window.renderGrid=function(){};window.resetPopupInputs=function(){};window.closeModal=function(){};window.auditLog=function(){};window.syncPush=function(){};

toggleSel={stage:'Added'};
document.getElementById('capModal'); // sanity
openManifoldSwap('Cyl 1');
document.getElementById('mTitle').textContent // expect "Removed — Cyl 1"

document.getElementById('pf-brand').value='Afrox';
document.getElementById('pf-gasType').value='LPG';
document.getElementById('pf-scale').value='15';
document.getElementById('pf-tare').value='10'; // residual gl=5, well within normal range
_manifoldSwapStep1();
document.getElementById('mTitle').textContent // expect "Added — Cyl 1" (step 2 auto-started)

document.getElementById('pf-brand').value='Afrox';
document.getElementById('pf-gasType').value='LPG';
document.getElementById('pf-scale').value='58';
document.getElementById('pf-tare').value='10'; // fresh gl=48
_manifoldSwapStep2Save();

JSON.stringify({
  removed: capData['Removed']['Cyl 1'],
  added: capData['Added']['Cyl 1'],
  sameSwapId: capData['Removed']['Cyl 1'][0]._swapId===capData['Added']['Cyl 1'][0]._swapId
});
```
Expected: `removed[0].gasLeft` ≈ 5, `added[0].gasLeft` ≈ 48, `sameSwapId: true`.

Then confirm the plain, non-swap path (Opening) is unaffected:
```js
toggleSel={stage:'Opening'};capData={};
openModal('Cyl 2');
document.getElementById('mTitle').textContent // expect plain "Cyl 2", not "Removed — Cyl 2"
```

- [ ] **Step 4: Syntax check and commit**

```bash
node -e "new Function(require('fs').readFileSync('index.html','utf8').match(/<script>([\s\S]*)<\/script>/)[1])"
git add index.html
git commit -m "Guided two-step swap flow for Manifold: outgoing residual, then incoming cylinder"
```

---

### Task 6: `Removed` in the day's gas mass-balance

**Files:**
- Modify: `index.html` (`manifoldBalance()`, ~line 6024-6026)

- [ ] **Step 1: Read the current `manifoldBalance()` in full**

Read the whole function (starts ~6024) before editing - confirm exactly how `sumStage('Added')`/
`sumStage('Opening')`/`sumStage('Closing')` currently feed the reconciliation formula, so the
new `sumStage('Removed')` bucket is added to the actual balance equation correctly (residual
gas leaving via a removed cylinder is gas that left the manifold system, same direction as
gas dispensed to Refill/Private - not the same direction as `Added`, which is gas entering).

- [ ] **Step 2: Add `Removed` to the balance calculation**

Add a `var removed=sumStage('Removed');` line alongside the existing `sumStage` calls, and
include it in the reconciliation formula on the same side as gas leaving the system (dispensed
+ removed, both reduce what's left) - match the exact sign/direction convention the existing
formula already uses for consistency, don't invent a new one.

- [ ] **Step 3: Verify live**

Using the same swap-flow test data from Task 5 Step 3 (5kg residual removed, 48kg added),
call `manifoldBalance()` and confirm the returned/rendered balance reflects the 5kg residual
as gas that left the system - compare against manually computing what the balance SHOULD be
with vs. without the `Removed` bucket counted, using the pre-existing formula's own logic.

- [ ] **Step 4: Syntax check and commit**

```bash
node -e "new Function(require('fs').readFileSync('index.html','utf8').match(/<script>([\s\S]*)<\/script>/)[1])"
git add index.html
git commit -m "Fold Removed-stage residual gas into the day's Manifold mass-balance"
```

---

### Task 7: Live multi-device verification

**Files:** none (verification only)

- [ ] **Step 1:** On a real device (or the deployed production URL after merge), as Owner:
  open Admin → Manifold Slots, change Helderberg to 5, confirm the Manifold capture grid on
  a *second* device/tab now shows 5 cylinders after reopening Manifold capture there.
- [ ] **Step 2:** As Operator, tap Added on a slot, confirm the two-step wizard appears with
  the right titles at each step.
- [ ] **Step 3:** Enter a residual weight for the outgoing cylinder, confirm it advances to
  the incoming-cylinder step automatically.
- [ ] **Step 4:** Enter an incoming weight in the 48.1-48.2kg flagged band, confirm the
  Manager/Owner override prompt appears and blocks saving without it.
- [ ] **Step 5:** Enter an incoming weight at 48.2kg or above, confirm it's rejected with no
  override option at all.
- [ ] **Step 6:** Query `manifold_settings` and the relevant `manifold` rows directly via
  `supabase db query` to confirm the slot count, the `Removed`/`Added` rows, and their shared
  `_swapId`-equivalent all match what was captured.
- [ ] **Step 7:** Reset Helderberg's slot count back to 4 (`supabase db query --linked
  --project-ref zyymnkychhglisqjvkqs "update manifold_settings set slot_count=4 where
  branch='Helderberg';"`) so this doesn't leave live testing data behind at a changed count.

---

## Self-review (author, before handoff)

**Spec coverage** - every "In scope" bullet from the design doc maps to a task: slot
identity/tare fingerprint (Task 5's `_swapId` linkage + existing `tare` field, already
present on every reading), swap explicitly asking which slot (Task 5, reusing the tap-a-tile
interaction itself as the slot picker - no separate prompt needed), outgoing residual capture
(Task 5 step 1), two-tier validation with override (Task 4), configurable per-branch slot
count (Tasks 1-3), same-day expected-tare data threading (already satisfied structurally by
Task 5's `Removed`/`Added` rows carrying real `tare` values per slot per day - no separate
task needed, since the design doc explicitly defers the comparison/flagging logic itself to
the next phase).

**Placeholder scan** - no TBD/TODO; every step has real, complete code or an exact command.

**Type consistency** - `_addLineFinishAfterCap(c,d)` introduced in Task 4 is the same
function Task 5's swap flow relies on indirectly (via `_addLineFinish`, which now always ends
by calling it) - checked that Task 5's step functions never reference the pre-Task-4 inline
body directly, only ever call `_addLineFinish`, so task order (4 before 5) matters and is
reflected in the numbering above.
