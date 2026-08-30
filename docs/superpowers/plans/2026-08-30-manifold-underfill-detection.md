# Manifold Underfill Detection & Used-Cylinder Override Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an operator weighs in the INCOMING (Added-stage) cylinder during a Manifold
swap, catch two distinct real-world problems the current two-tier validation (upper bound
only) can't see: (1) a "fresh" cylinder that's actually underfilled by the supplier — flag it,
let the operator recheck their entry, and if confirmed correct, route them straight into the
existing Faulty Cylinders tool, pre-filled; (2) a genuinely used/partially-filled cylinder
being deliberately installed (e.g. one recovered from a customer) — let the operator declare
this upfront and require a Manager/Owner override to accept it, skipping the underfill flag
entirely since a partial fill is then expected, not a defect.

**Architecture:** Everything lives in `index.html`, same file, same conventions as the rest of
this feature area. Two real pieces of new behavior sit on top of infrastructure that already
exists: a new segmented-control ("tabs") field on the Added-cylinder form (an existing field
type, already used elsewhere), and a reuse of the existing `manifoldWeightOverride()`
Manager/Owner password-and-reason flow for the used-cylinder case. The one genuinely new piece
of plumbing is making `CAP.manifold.popupFields` vary by WHICH STEP of the swap wizard is
currently on screen (not just by live toggle state, since the wizard's two steps both run
while the live Stage toggle stays on "Added" the whole time) — this requires generalizing 8
call sites that currently read `c.popupFields` as a plain array, mirroring the exact pattern
Task 2 of the prior plan already established for `c.grid`.

**Tech Stack:** Vanilla JS, existing `CAP` generic-capture-engine config object, existing
`manifoldWeightOverride()` override-auth flow, existing Faulty Cylinders admin tool.

---

## Reference: current code this plan builds on

Read these in full in the live file before starting — line numbers below are approximate and
will drift as earlier tasks in this plan land; search for the function/variable names instead.

- `CAP.manifold` config object (~line 4961-4970) — `popupFields` is currently a **plain array**:
  `brand, gasType, scale, tare, gasLeft(auto), photo(opt), notes(opt)`.
- `buildPopupForm(c)` (~5338) / `popCollect()` (~5364) / `_photoMaxFor(key)` (~5506) /
  `popCalc()` (~5528, two separate `c.popupFields` reads inside it) / `_addLineFinish`'s
  required-field loop (~5674) / `_addLineFinishAfterCap`'s auto-calc loop (~5744) /
  `resetPopupInputs(c)` (~5766) — **8 total call sites** that currently do `c.popupFields...`
  assuming a plain array. This mirrors exactly the `c.grid` situation Task 2 of the prior plan
  (`docs/superpowers/plans/2026-08-28-manifold-slot-identity.md`) already solved — same
  `(typeof x==='function'?x():x)` pattern, applied to a different property.
- `openManifoldSwap(item)` (~5419) / `_manifoldSwapStep1()` (~5451) / `_manifoldSwapStep2()`
  (~5468) / `_manifoldSwapStep2Save()` (~5478) — the guided swap wizard. **Critical fact this
  plan depends on:** live `toggleSel.stage` stays `'Added'` for the ENTIRE wizard (both steps)
  — it never actually becomes `'Removed'`. `buildPopupForm(c)` is called once in
  `openManifoldSwap()` (for step 1, the OUTGOING/Removed cylinder) and once in
  `_manifoldSwapStep2()` (for step 2, the INCOMING/Added cylinder) — both while live
  `toggleSel.stage==='Added'`. So the new toggle field (which must appear ONLY on step 2, the
  true incoming-cylinder capture) **cannot** be gated on live `toggleSel.stage` — it needs an
  explicit "which step is this" signal passed into `buildPopupForm` at each call site.
- `addLine()` (~5619) — already sets `d._addedBranch`, `d._capturedModalItem`,
  `d._capturedToggleSel` before calling `_addLineFinish(c,d)`, specifically to survive the
  async override gap without a stale-global race. This plan's new lower-bound check and
  used-cylinder toggle need the SAME captured-at-submit-time treatment for the same reason —
  the used-cylinder override is itself async (password + reason).
- `_addLineFinish(c,d,onDone)` (~5668) — the two-tier upper-bound check already lives here
  (~5680-5729), including the `manifoldOverrideBusy` re-entrancy guard and the
  `manifoldWeightOverride(msg)` call. This plan's new lower-bound check slots in right after
  it, inside the same `if(c.gasLeftCap && 'scale'in d && 'tare'in d){...}` block.
- `manifoldWeightOverride(msg)` (~2252) — the existing dual-mode (self-reauth / borrow-auth)
  Manager-or-Owner password+reason override, already used by the upper flagged-band case. This
  plan reuses it as-is for the used-cylinder case, just with a different `msg`.
- `popSetTabField(key,val)` (~5496) and the `f.type==='tabs'` branch inside `buildPopupForm`
  (~5343-5350) — an existing, already-built segmented-control field type (used today by
  Private Refill's "Filled by: Us / Supplier" toggle). This plan's new "Cylinder condition"
  field reuses this exact mechanism — no new UI component needed.
- `f.showIf` (checked in `popCalc()` ~5531 and `_addLineFinish`'s required-field loop ~5676) —
  conditional field visibility based on ANOTHER FIELD'S VALUE within the same form (`d[k]===
  eq`). Not used by this plan directly (the new toggle field's own visibility is controlled by
  which popupFields ARRAY is active, not by showIf), but the mechanism stays available for any
  field that should only apply when `cylState==='Used / partial'` or similar, if needed.
- Faulty Cylinders tool: `faultyCaptureInit()` (~1622), `faultySetBranch(b)` (~1631),
  `faultyBrandChanged()` (~1637), `faultyReasonChanged()` (~1641), `faultySetState(s)` (~1645),
  `faultyCalcUpdate()` (~1651), `faultySubmit()` (~1661), `faultyResetForm()` (~1690).
  Fields: `fcBrand` (hardcoded `<option>Afrox</option><option>Oryx</option><option
  value="Other">Other</option>` — narrower than Manifold's `BRANDS` list), `fcBrandOther`
  (text, shown when `fcBrand==='Other'`), `fcSize` (populated from `COUNT_ITEMS`, includes
  `'48kg-DV'` and `'45kg-Prop-DV'` — the exact DV/donor-cylinder sizes Manifold uses),
  `fcScale`/`fcTare` (number), `fcReason` (hardcoded `<option>Leaking valve</option>
  <option>Damaged</option><option>Rusted</option><option value="Other">Other</option>` — no
  "Underfilled" option yet), `fcReasonOther` (text, shown when `fcReason==='Other'`), `fcNote`
  (text), `fcQty` (number, defaults to 1 via `faultyResetForm()`), `fcSeal` (text, N/A here).
  `FAULTY_NOMINAL` (~1578) confirms `'48kg-DV':48` and `'45kg-Prop-DV':45` — correct nominal
  values matching Manifold's own `cap` constants.
- `openAdmin()` (~1195) / `adminTab(t)` (~1212) / `_adminTabShow(t)` (~1237): `adminTab('faulty')`
  is **not** password-gated (unlike every other Admin tab) — routine daily task, same
  reasoning as Stock Count. Requires `perm('faultyCapture')`, which every role (including
  Operator) has by default (`permPreset('Operator')`, ~2103, has `faultyCapture:1`). Deep-link
  sequence: `openAdmin(); adminTab('faulty');` is enough to land an Operator on the Log Faulty
  form with no extra prompt.
- `closeModal()` (~5775): `document.getElementById('capModal').classList.remove('show');
  renderGrid();` — closes the capture popup. Needed before navigating to Admin.
- The existing orphaned-`Removed`-row safety net (from the prior plan's whole-branch-review
  fix, in `capReview()` and `closeDay()`) already blocks committing/closing the day on an
  unpaired `Removed` row with no matching `Added` `_swapId`. **This plan deliberately relies on
  that existing mechanism** rather than building a new one: when an underfill is confirmed and
  routed to Faulty Cylinders, the incoming cylinder's `Added` row is simply never saved for
  that attempt, leaving exactly the state that safety net already catches.

---

### Task 1: Generalize `c.popupFields` to support a function, threaded through a stage override

**Files:**
- Modify: `index.html` (`buildPopupForm`, `popCollect`, `_photoMaxFor`, `popCalc`,
  `_addLineFinish`, `_addLineFinishAfterCap`, `resetPopupInputs`, `addLine`,
  `_manifoldSwapStep1`, `_manifoldSwapStep2`, `_manifoldSwapStep2Save`)

This task is pure infrastructure — `CAP.manifold.popupFields` stays a plain array after this
task (Task 2 turns it into a function). The point of this task is to make every call site
tolerant of `c.popupFields` becoming a function later, and to introduce the "what fields does
the currently-open form actually have" tracking this plan's stage-conditional field needs,
without changing behavior for anything yet.

- [ ] **Step 1: Add a tracked "current form's fields" variable**

Find `var popPhoto={};` (~line 5503, just above `_photoMaxFor`) and add immediately after it:

```js
// The RESOLVED popupFields array for whatever form is currently on screen. Sits between
// CAP.<type>.popupFields (which can now be a function - see buildPopupForm below) and every
// other function that needs "does this form have field X" (popCollect, popCalc,
// _photoMaxFor, resetPopupInputs) - those all run synchronously against whatever's CURRENTLY
// displayed, so reading this tracked value is correct and simpler than re-resolving
// c.popupFields(...) themselves, especially for the Manifold swap wizard where step 1 and
// step 2 show DIFFERENT fields while live toggleSel.stage stays 'Added' for both - see
// buildPopupForm's stageOverride param and openManifoldSwap()/'_manifoldSwapStep2()below.
var _popupFieldsCurrent=null;
```

- [ ] **Step 2: `buildPopupForm` resolves and stores it, accepts an optional stage override**

Find `function buildPopupForm(c){` (~5338):
```js
function buildPopupForm(c){
  var box=document.getElementById('mForm');var html='';
  c.popupFields.forEach(function(f){
```
Change to:
```js
function buildPopupForm(c,stageOverride){
  var box=document.getElementById('mForm');var html='';
  _popupFieldsCurrent=(typeof c.popupFields==='function')?c.popupFields(stageOverride):c.popupFields;
  _popupFieldsCurrent.forEach(function(f){
```

- [ ] **Step 3: `popCollect`, `_photoMaxFor`, `popCalc` (both spots), `resetPopupInputs` read the tracked value**

Find `function popCollect(){var c=CAP[capType];var d={};c.popupFields.forEach(function(f){` (~5364):
```js
function popCollect(){var c=CAP[capType];var d={};c.popupFields.forEach(function(f){if(f.type==='photo'){d[f.k]=(popPhoto[f.k]||[]).slice();return;}var el=document.getElementById('pf-'+f.k);if(el)d[f.k]=el.value;});return d;}
```
Change to:
```js
function popCollect(){var d={};(_popupFieldsCurrent||[]).forEach(function(f){if(f.type==='photo'){d[f.k]=(popPhoto[f.k]||[]).slice();return;}var el=document.getElementById('pf-'+f.k);if(el)d[f.k]=el.value;});return d;}
```
(`c` is now unused here — dropped, matching this file's habit of not keeping dead locals.)

Find `function _photoMaxFor(key){` (~5506):
```js
function _photoMaxFor(key){
  var c=CAP[capType];if(!c)return 3;
  var f=c.popupFields.filter(function(x){return x.k===key && x.type==='photo';})[0];
  return (f&&f.max)?f.max:3;
}
```
Change to:
```js
function _photoMaxFor(key){
  var f=(_popupFieldsCurrent||[]).filter(function(x){return x.k===key && x.type==='photo';})[0];
  return (f&&f.max)?f.max:3;
}
```

Find `function popCalc(){` (~5528) and its two `c.popupFields` reads:
```js
function popCalc(){
  var c=CAP[capType];var d=popCollect();
  // conditional showIf fields (e.g. Other brand name)
  c.popupFields.forEach(function(f){
```
Change the second line's read (keep `c` — still used lower down in `popCalc` for
`capType==='refill'` and Private's brand-filtering logic, which this task doesn't touch):
```js
function popCalc(){
  var c=CAP[capType];var d=popCollect();
  // conditional showIf fields (e.g. Other brand name)
  (_popupFieldsCurrent||[]).forEach(function(f){
```
And further down in the same function:
```js
  c.popupFields.filter(function(f){return f.type==='auto';}).forEach(function(f){
    var el=document.getElementById('pf-'+f.k);var val=f.calc(popCollect(),modalItem);
```
Change to:
```js
  (_popupFieldsCurrent||[]).filter(function(f){return f.type==='auto';}).forEach(function(f){
    var el=document.getElementById('pf-'+f.k);var val=f.calc(popCollect(),modalItem);
```

Find `function resetPopupInputs(c){popPhoto={};c.popupFields.forEach(function(f){` (~5766):
```js
function resetPopupInputs(c){popPhoto={};c.popupFields.forEach(function(f){
  if(f.type==='tabs')return; // sticky across Add - e.g. Private's Us/Supplier tab stays selected until the user picks a different tab themselves, not reset on every add
  var el=document.getElementById('pf-'+f.k);if(el&&f.type!=='auto')el.value=(f.default!==undefined?f.default:'');
  var th=document.getElementById('pf-'+f.k+'-thumb');if(th)th.innerHTML='';
});popCalc();}
```
Change to:
```js
function resetPopupInputs(c){popPhoto={};(_popupFieldsCurrent||[]).forEach(function(f){
  if(f.type==='tabs')return; // sticky across Add - e.g. Private's Us/Supplier tab stays selected until the user picks a different tab themselves, not reset on every add
  var el=document.getElementById('pf-'+f.k);if(el&&f.type!=='auto')el.value=(f.default!==undefined?f.default:'');
  var th=document.getElementById('pf-'+f.k+'-thumb');if(th)th.innerHTML='';
});popCalc();}
```
(`c` param kept for call-site compatibility even though unused now — every existing call site
passes it; removing the parameter would be pure churn for no benefit.)

- [ ] **Step 4: Capture the resolved fields at submit time, for the async override gap**

Find `addLine()` (~5619), right where it already captures `d._capturedModalItem`:
```js
  d._capturedModalItem=modalItem;
  if(c.toggles)d._capturedToggleSel=Object.assign({},toggleSel);
```
Add immediately after:
```js
  d._capturedPopupFields=_popupFieldsCurrent;
```

Find `_manifoldSwapStep1()` (~5451) and `_manifoldSwapStep2Save()` (~5478), each already doing:
```js
  d._capturedModalItem=_manifoldSwapItem;
  d._capturedToggleSel={stage:'Removed'};  // or {stage:'Added'} in step2Save
```
Add immediately after in BOTH functions:
```js
  d._capturedPopupFields=_popupFieldsCurrent;
```

- [ ] **Step 5: `_addLineFinish`'s required-field loop and `_addLineFinishAfterCap`'s auto-calc loop read the captured value**

Find `_addLineFinish(c,d,onDone)`'s required-field loop (~5673-5677):
```js
    for(var i=0;i<c.popupFields.length;i++){var f=c.popupFields[i];if(f.type==='auto'||f.opt||f.type==='tabs')continue;
```
Change to:
```js
    var _pf=d._capturedPopupFields||(typeof c.popupFields==='function'?c.popupFields():c.popupFields);
    for(var i=0;i<_pf.length;i++){var f=_pf[i];if(f.type==='auto'||f.opt||f.type==='tabs')continue;
```

Find `_addLineFinishAfterCap(c,d,onDone)`'s auto-calc loop (~5744):
```js
  c.popupFields.filter(function(f){return f.type==='auto';}).forEach(function(f){d[f.k]=f.calc(d,item);});
```
Change to:
```js
  (d._capturedPopupFields||(typeof c.popupFields==='function'?c.popupFields():c.popupFields)).filter(function(f){return f.type==='auto';}).forEach(function(f){d[f.k]=f.calc(d,item);});
```

- [ ] **Step 6: Verify live (browser, disposable server) — no behavior change yet for ANY capture type**

Since `CAP.manifold.popupFields` is still a plain array after this task, `typeof
c.popupFields==='function'` is always false everywhere, so every one of the above changes is a
pure no-op in terms of behavior. Verify this holds:

Serve the current worktree's `index.html` on a disposable local port (pattern used throughout
this project: a tiny Node static server + `mcp__Claude_Browser__preview_start` with a `url`,
not `name`/launch.json). Confirm via the browser console:

```js
// Plain Opening capture for Manifold - should render/save exactly as before
role='Owner';branch='Helderberg';capBranch='Helderberg';currentProfile={id:'x',name:'Test',level:'Owner'};
capType='manifold';toggleSel={stage:'Opening'};capData={};
openModal('Cyl 1');
document.getElementById('mForm').innerHTML.indexOf('pf-brand')>-1 // expect true - form still renders
```

Then run the full Manifold swap wizard end to end (tap a slot on Added, complete step 1,
complete step 2) and confirm it still saves both rows correctly with a matching `_swapId`,
exactly as before this task. Then switch `capType` to `'private'` or `'refill'` and confirm
THEIR popups still render/save/delete lines correctly too (these never have a function-typed
`popupFields`, so this is purely a regression check on the generalized helper functions).

- [ ] **Step 7: Syntax check and commit**

```bash
node -e "new Function(require('fs').readFileSync('index.html','utf8').match(/<script>([\s\S]*)<\/script>/)[1])"
```
Expected: no error.

```bash
git add index.html
git commit -m "Generalize c.popupFields call sites to support a function, mirroring c.grid"
```

---

### Task 2: The "Cylinder condition" toggle field, shown only on the incoming-cylinder step

**Files:**
- Modify: `index.html` (`CAP.manifold`, `openManifoldSwap`, `_manifoldSwapStep2`)

- [ ] **Step 1: Split `CAP.manifold.popupFields` into a base array plus an Added-only extra field**

Find `CAP.manifold`'s definition (~4961-4970):
```js
  manifold:{title:'Manifold Count',hint:'Opening = cylinders at start. Added = tap a slot to swap it — weigh the outgoing cylinder\'s residual first, then the incoming cylinder. Closing = cylinders at end.',grid:function(){return _manifoldCylLabels(capBranch);},
    header:[], gate:[], multi:false,
    toggles:[{key:'stage',label:'Stage',states:['Opening','Added','Closing']}],
    popupFields:[{k:'brand',label:'Brand',type:'select',opts:BRANDS},
      {k:'gasType',label:'Gas type',type:'select',opts:['LPG','Propane']},
      {k:'scale',label:'Scale weight (kg)',type:'number'},{k:'tare',label:'Tare weight (kg)',type:'number'},
      {k:'gasLeft',label:'Gas left (auto)',type:'auto',calc:function(d,item){return num(d.scale)-num(d.tare);}},
      {k:'photo',label:'Photo of scale & tare',type:'photo',opt:true},
      {k:'notes',label:'Note',type:'text',opt:true}],
    weigh:true, gridLabel:'cylinder', gasLeftCap:true, multiStage:true },
```
Change to:
```js
  manifold:{title:'Manifold Count',hint:'Opening = cylinders at start. Added = tap a slot to swap it — weigh the outgoing cylinder\'s residual first, then the incoming cylinder. Closing = cylinders at end.',grid:function(){return _manifoldCylLabels(capBranch);},
    header:[], gate:[], multi:false,
    toggles:[{key:'stage',label:'Stage',states:['Opening','Added','Closing']}],
    // A function, not a plain array, because the guided swap wizard's two steps (step 1:
    // outgoing/Removed, step 2: incoming/Added) both run while live toggleSel.stage stays
    // 'Added' the whole time - see openManifoldSwap()/_manifoldSwapStep2() below, which pass
    // an explicit stageOverride ('Removed'/'Added') into buildPopupForm rather than relying on
    // the live toggle. The "Cylinder condition" field only makes sense for the INCOMING
    // cylinder (step 2 / true Added) - a fresh-vs-used declaration on the OUTGOING cylinder's
    // residual weigh-out (step 1) wouldn't mean anything.
    popupFields:function(stage){
      stage=stage||toggleSel.stage;
      var base=[{k:'brand',label:'Brand',type:'select',opts:BRANDS},
        {k:'gasType',label:'Gas type',type:'select',opts:['LPG','Propane']}];
      if(stage==='Added'){
        base=base.concat([{k:'cylState',label:'Cylinder condition',type:'tabs',opts:['Fresh (full)','Used / partial'],default:'Fresh (full)'}]);
      }
      return base.concat([
        {k:'scale',label:'Scale weight (kg)',type:'number'},{k:'tare',label:'Tare weight (kg)',type:'number'},
        {k:'gasLeft',label:'Gas left (auto)',type:'auto',calc:function(d,item){return num(d.scale)-num(d.tare);}},
        {k:'photo',label:'Photo of scale & tare',type:'photo',opt:true},
        {k:'notes',label:'Note',type:'text',opt:true}]);
    },
    weigh:true, gridLabel:'cylinder', gasLeftCap:true, multiStage:true },
```

- [ ] **Step 2: Pass the correct stage override at each wizard call site**

Find `openManifoldSwap(item)`'s `buildPopupForm(c);` call (~5445, inside the step-1 setup
block, right after `document.getElementById('mState').textContent='Step 1 of 2: ...`):
```js
  buildPopupForm(c);
  renderModalLines({stage:'Removed'});
```
Change to:
```js
  buildPopupForm(c,'Removed');
  renderModalLines({stage:'Removed'});
```

Find `_manifoldSwapStep2()`'s `buildPopupForm(c);` call (~5472):
```js
  buildPopupForm(c);
  renderModalLines({stage:'Added'});
```
Change to:
```js
  buildPopupForm(c,'Added');
  renderModalLines({stage:'Added'});
```

(The plain, non-wizard `openModal()` path's own `buildPopupForm(c)` call — used for Opening
and Closing — is left with NO override, correctly falling back to live `toggleSel.stage`
inside the `popupFields` function, which is always `'Opening'` or `'Closing'` there since
Manifold's Added stage always routes into the wizard instead, per `openModal`'s existing
routing check.)

- [ ] **Step 3: Verify live**

Confirm via the browser: open the swap wizard, step 1 ("Removed — Cyl X") does **NOT** show a
"Cylinder condition" toggle; advancing to step 2 ("Added — Cyl X") **DOES** show it, defaulted
to "Fresh (full)"; tapping "Used / partial" updates `document.getElementById('pf-cylState')
.value` to `'Used / partial'` and toggles the segmented control's `.on` class correctly (reuse
the existing `popSetTabField` mechanism — this should already just work, since it's the same
field type Private Refill already uses). Confirm a plain Opening/Closing popup for Manifold
never shows this field either.

- [ ] **Step 4: Syntax check and commit**

```bash
node -e "new Function(require('fs').readFileSync('index.html','utf8').match(/<script>([\s\S]*)<\/script>/)[1])"
git add index.html
git commit -m "Add Cylinder condition (Fresh/Used) toggle to the incoming-cylinder swap step"
```

---

### Task 3: Underfill detection with recheck-or-log-faulty routing

**Files:**
- Modify: `index.html` (`_addLineFinish`, new `_openFaultyFromManifoldUnderfill` function)

- [ ] **Step 1: Add the lower-bound check inside `_addLineFinish`'s existing gasLeftCap block**

Find the existing upper-tier block in `_addLineFinish` (~5689-5728), ending with:
```js
    if(gl>cap+0.1){
      // Re-entrancy guard: ...
      if(manifoldOverrideBusy){toast('An override is already pending for another reading — wait for it to finish, then try again',true);if(onDone)onDone(false);return;}
      manifoldOverrideBusy=true;
      manifoldWeightOverride('Gas left '+gl.toFixed(2)+'kg for '+modalItem+' ('+(d.gasType||'LPG')+', normal range up to '+(cap+0.1).toFixed(1)+'kg)').then(function(ok){
        if(!ok){toast('Override needed to save this reading',true);if(onDone)onDone(false);return;}
        _addLineFinishAfterCap(c,d,onDone);
      }).catch(function(){toast('Something went wrong processing the override — please try again',true);if(onDone)onDone(false);})
      .finally(function(){manifoldOverrideBusy=false;});
      return; // async path - _addLineFinishAfterCap below continues once authorised
    }
  }
```
Insert a new block AFTER the closing `}` of the `if(gl>cap+0.1){...}` block, still INSIDE the
outer `if(c.gasLeftCap && ...){` block (i.e. replace that final `  }` with the code below,
which ends with its own `  }`):

```js
    if(gl>cap+0.1){
      // Re-entrancy guard: ...
      if(manifoldOverrideBusy){toast('An override is already pending for another reading — wait for it to finish, then try again',true);if(onDone)onDone(false);return;}
      manifoldOverrideBusy=true;
      manifoldWeightOverride('Gas left '+gl.toFixed(2)+'kg for '+modalItem+' ('+(d.gasType||'LPG')+', normal range up to '+(cap+0.1).toFixed(1)+'kg)').then(function(ok){
        if(!ok){toast('Override needed to save this reading',true);if(onDone)onDone(false);return;}
        _addLineFinishAfterCap(c,d,onDone);
      }).catch(function(){toast('Something went wrong processing the override — please try again',true);if(onDone)onDone(false);})
      .finally(function(){manifoldOverrideBusy=false;});
      return; // async path - _addLineFinishAfterCap below continues once authorised
    }
    // Underfill detection - INCOMING cylinder only (Added stage), and only when the operator
    // hasn't already declared this a deliberate used/partial cylinder (that path is handled
    // separately below, via a Manager/Owner override instead of this recheck-or-faulty flow).
    // Tolerance: 0.2kg under nominal (47.8kg LPG / 44.8kg Propane) - below that, a "fresh"
    // cylinder almost certainly wasn't fully filled by the supplier, which is either a data
    // entry mistake (recheck fixes it) or a genuine supplier defect (log it as faulty, don't
    // silently accept it as this slot's new baseline).
    var toggles=d._capturedToggleSel;
    var isIncoming=toggles && toggles.stage==='Added';
    var isUsedPartial=d.cylState==='Used / partial';
    if(isIncoming && !isUsedPartial && gl<(cap-0.2)){
      var wantsFaulty=confirm('Gas left ('+gl.toFixed(2)+'kg) is below the expected fill level for a fresh cylinder from the supplier ('+(cap-0.2).toFixed(1)+'kg minimum for '+(d.gasType||'LPG')+').\n\nPress Cancel to recheck your scale/tare entry — nothing has been saved yet.\nPress OK if the numbers are correct — you\'ll be taken straight to logging this as a faulty cylinder.');
      if(!wantsFaulty){if(onDone)onDone(false);return;} // stay on this step, values untouched, operator corrects and resubmits
      _openFaultyFromManifoldUnderfill(d,d._capturedModalItem,cap,gl);
      if(onDone)onDone(false); // never saved as a Manifold row for this attempt - the swap is intentionally left with only its Removed row, caught by the existing orphaned-row safety net if not otherwise resolved
      return;
    }
    // Used/partial cylinder, deliberately declared - skip the underfill flag entirely (any
    // low reading is expected), but require Manager/Owner sign-off before accepting it, same
    // reasoning and mechanism as the flagged-band override above (just a different trigger and
    // message) - the override is on the DECISION to use a non-fresh cylinder here at all, not
    // on any specific weight value, so it applies regardless of how low or how close-to-normal
    // the reading is.
    if(isIncoming && isUsedPartial){
      if(manifoldOverrideBusy){toast('An override is already pending for another reading — wait for it to finish, then try again',true);if(onDone)onDone(false);return;}
      manifoldOverrideBusy=true;
      manifoldWeightOverride('Used/partial cylinder declared for '+modalItem+' — gas left '+gl.toFixed(2)+'kg ('+(d.gasType||'LPG')+')').then(function(ok){
        if(!ok){toast('Override needed to save this reading',true);if(onDone)onDone(false);return;}
        _addLineFinishAfterCap(c,d,onDone);
      }).catch(function(){toast('Something went wrong processing the override — please try again',true);if(onDone)onDone(false);})
      .finally(function(){manifoldOverrideBusy=false;});
      return;
    }
  }
```

- [ ] **Step 2: Write `_openFaultyFromManifoldUnderfill`**

Add this new function near `manifoldWeightOverride` (or anywhere convenient near the other
Manifold-specific helpers — search for `function manifoldWeightOverride` and add it after):

```js
// Deep-links from an underfilled-cylinder confirmation (inside the Manifold swap wizard's
// incoming-cylinder step) straight into the existing Faulty Cylinders tool, pre-filled with
// what was already captured, so the operator doesn't have to re-enter brand/scale/tare by
// hand. Leaves the swap itself with only its Removed row saved (the Added row for THIS
// attempt is intentionally never saved) - the existing orphaned-Removed-row safety net in
// capReview()/closeDay() catches that if the operator doesn't otherwise resolve it (e.g. by
// getting a real replacement cylinder and completing the swap properly).
function _openFaultyFromManifoldUnderfill(d,item,cap,gl){
  closeModal();
  openAdmin();
  adminTab('faulty');
  var knownBrands=['Afrox','Oryx'];
  var brand=d.brand;
  var fcBrandEl=document.getElementById('fcBrand'), fcBrandOtherEl=document.getElementById('fcBrandOther');
  if(fcBrandEl){
    if(knownBrands.indexOf(brand)>-1){fcBrandEl.value=brand;}
    else{fcBrandEl.value='Other';if(fcBrandOtherEl)fcBrandOtherEl.value=brand||'';}
    faultyBrandChanged();
  }
  var sizeKey=(d.gasType==='Propane')?'45kg-Prop-DV':'48kg-DV';
  var fcSizeEl=document.getElementById('fcSize');
  if(fcSizeEl){
    if(!fcSizeEl.options.length)fcSizeEl.innerHTML=COUNT_ITEMS.map(function(s){return '<option value="'+s+'">'+s+'</option>';}).join('');
    fcSizeEl.value=sizeKey;
  }
  var fcScaleEl=document.getElementById('fcScale'), fcTareEl=document.getElementById('fcTare');
  if(fcScaleEl)fcScaleEl.value=d.scale;
  if(fcTareEl)fcTareEl.value=d.tare;
  var fcReasonEl=document.getElementById('fcReason');
  if(fcReasonEl){fcReasonEl.value='Underfilled';faultyReasonChanged();}
  var fcNoteEl=document.getElementById('fcNote');
  if(fcNoteEl)fcNoteEl.value='Auto-logged from Manifold '+item+' — incoming cylinder weighed at '+gl.toFixed(2)+'kg gas left, below the '+(cap-0.2).toFixed(1)+'kg minimum expected for a fresh '+(d.gasType||'LPG')+' cylinder.';
  faultySetState('Full');
  faultyCalcUpdate();
  toast('Recheck the details below, then Log faulty cylinder to record this delivery issue');
}
```

- [ ] **Step 3: Add "Underfilled" to the Faulty Cylinders reason list**

Find the `fcReason` select's HTML (search for `id="fcReason"` — the plan's earlier research
found it around line 768):
```html
<select class="mField" id="fcReason" onchange="faultyReasonChanged()"><option>Leaking valve</option><option>Damaged</option><option>Rusted</option><option value="Other">Other</option></select>
```
Change to:
```html
<select class="mField" id="fcReason" onchange="faultyReasonChanged()"><option>Leaking valve</option><option>Damaged</option><option>Rusted</option><option>Underfilled</option><option value="Other">Other</option></select>
```

- [ ] **Step 4: Verify live**

Run the swap wizard's step 2 with a deliberately low, "Fresh (full)"-tagged reading (e.g.
LPG scale=57.5, tare=10 → gl=47.5, below the 47.8 threshold). Confirm the `confirm()` prompt
appears. Test BOTH branches:
- **Cancel** ("let me recheck"): confirm the wizard stays on step 2, the entered scale/tare
  values are still in the form, nothing was saved (`capData['Added']['Cyl X']` unchanged),
  `onDone(false)` fired (no swap-complete toast).
- **OK** ("numbers are correct"): confirm the capture modal closes, Admin → Faulty Cylinders
  → Log faulty opens with `fcBrand`/`fcSize`/`fcScale`/`fcTare`/`fcReason`/`fcNote`
  correctly pre-filled matching what was entered in the swap step, and that `capData['Added']
  ['Cyl X']` is still empty (nothing was saved as a Manifold row). Then navigate back to
  Manifold capture and confirm `capReview()`/`closeDay()`'s existing orphaned-row check
  correctly still flags this slot's unpaired `Removed` row (proving the existing safety net
  from the prior plan naturally covers this new path with no changes needed to it).

Also test the boundary (gl exactly 47.8 → should NOT trigger, since the check is `gl<(cap-0.2)`
strictly-less-than) and the Propane cap (44.8 threshold).

- [ ] **Step 5: Syntax check and commit**

```bash
node -e "new Function(require('fs').readFileSync('index.html','utf8').match(/<script>([\s\S]*)<\/script>/)[1])"
git add index.html
git commit -m "Detect underfilled incoming cylinders, route confirmed ones to Faulty Cylinders"
```

---

### Task 4: Used/partial cylinder override

**Files:** none new — Task 3 Step 1 already implemented this branch (`isIncoming &&
isUsedPartial` in `_addLineFinish`) alongside the underfill check, since both live in the same
conditional structure and needed to be written together to get the `if/else if` ordering right
against the underfill check. **This task is verification-only**, confirming that branch in
isolation.

- [ ] **Step 1: Verify the used/partial override live**

On the swap wizard's step 2, set "Cylinder condition" to "Used / partial", enter a low reading
(e.g. LPG scale=25, tare=10 → gl=15kg — well below the underfill threshold). Confirm:
- The underfill `confirm()` prompt from Task 3 does **NOT** appear (the `isUsedPartial` guard
  correctly short-circuits it).
- `manifoldWeightOverride(...)` IS invoked instead — confirm via spying (not stubbing away)
  `manifoldWeightOverride` in the console, matching the verification approach used for the
  upper-tier override in the prior plan's Task 4.
- Approving the override (simulate a qualifying Manager/Owner + a reason, same stubbing
  pattern as before) correctly saves the row with `gl=15` into `capData['Added']['Cyl X']`,
  and `auditLog`/`syncPush` were called with a message clearly identifying this as a
  used/partial-cylinder override (not confusable with the upper flagged-band override's
  message).
- Declining/cancelling the override correctly leaves nothing saved, same as every other
  override-declined path in this file.
- The upper hard-ceiling (48.2kg+) still applies even when "Used / partial" is selected —
  confirm a reading at or above the ceiling is still rejected outright, no override offered,
  regardless of the cylinder-condition toggle (physical impossibility doesn't become possible
  just because the operator says the cylinder is used).
- `manifoldOverrideBusy` still correctly guards this path the same way it guards the upper
  flagged-band path (both branches set/check the same shared flag) — a second concurrent
  override attempt (either kind) while one is pending is rejected cleanly, matching the
  existing re-entrancy protection.

No commit for this task (no code changes beyond what Task 3 already committed).

---

### Task 5: Live multi-device verification

**Files:** none (verification only)

- [ ] **Step 1:** As Operator on a real device, start a Manifold swap, weigh the outgoing
  cylinder normally, then weigh the incoming cylinder at a genuinely underfilled level (or ask
  someone to under-fill a test cylinder if practical — otherwise simulate via the same
  browser-console technique used in Task 3's own verification, on the real production build
  after merge). Confirm the recheck-or-faulty prompt appears and both paths behave as
  designed.
- [ ] **Step 2:** Confirm the Faulty Cylinders form, once deep-linked into, saves correctly via
  its own existing `faultySubmit()` flow (unchanged by this plan) — i.e. confirm this plan's
  pre-fill doesn't break that tool's own existing save path.
- [ ] **Step 3:** As Operator, declare a cylinder "Used / partial" and confirm a Manager/Owner
  physically present can approve it via the override prompt, and that the resulting swap
  record is visible in Count History same as any other swap (per the prior plan's Removed/
  Added visibility fix — no changes needed there, just confirming it still applies).
- [ ] **Step 4:** Confirm a normal, fresh, in-range incoming cylinder reading (no underfill, no
  used/partial) still saves immediately with no extra prompts — the common case, unaffected.

---

## Self-review (author, before handoff)

**Spec coverage** — both scenarios from the user's confirmed design are covered: supplier
underfill detection with recheck-then-Faulty-Cylinders routing (Task 3), and the used/partial
cylinder Manager/Owner override (Task 3 + Task 4). Both confirmed sub-decisions are reflected
exactly: operator declares condition upfront via a toggle (Task 2), not inferred after the
fact; underfill routing deep-links into the existing Faulty Cylinders tool pre-filled (Task 3),
not a new parallel logging path.

**Placeholder scan** — no TBD/TODO; every step has complete, real code referencing actual
function names, field IDs, and constants confirmed present in the live file during planning.

**Type/naming consistency** — `d.cylState` (the new toggle field's key) is used identically in
Task 2 (field definition) and Task 3 (the `isUsedPartial` check) — checked for drift, none
found. `_capturedPopupFields` is introduced once (Task 1) and consumed consistently in both of
Task 1's own remaining steps and nowhere else needs it. `_openFaultyFromManifoldUnderfill`'s
parameter order and usage matches between its Task 3 Step 2 definition and its Task 3 Step 1
call site.
