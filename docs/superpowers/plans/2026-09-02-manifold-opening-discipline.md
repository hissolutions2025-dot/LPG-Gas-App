# Manifold Opening Discipline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Manifold's Opening stage stays fully manual/blind (no pre-fill, no lock), but gets
a live, zero-tolerance, per-field flag against yesterday's Closing (Brand/Gas Type/Tare/Gas
Left), plus a hard-blocked sequential order lock (Cyl 1 before Cyl 2, and so on) — both
confirmed explicitly by the user as operational-discipline and leak-detection requirements.

**Architecture:** Reuses every existing mechanism this session already built for the same
class of problem — the tare-mismatch live-warning idiom (`popCalc()`), the flag-stamp +
audit-log-on-save-anyway pattern (`addLine()`), and the same-day Opening lock's grid-tile
disabling shape (`renderGrid()`) — extended, not reinvented. The one new data need (yesterday's
Scale/Gas Left, not just Brand/Gas Type/Tare) extends the existing `_fetchManifoldPrevClose`
cache already built for the Removed-step baseline chain.

**Tech Stack:** Vanilla JS (single-file `index.html`), no build step, no test framework —
verification is a syntax-check script (`new Function()` over each extracted `<script>` block)
plus live verification, this project's own established convention.

**Reference:** `docs/superpowers/specs/2026-09-02-manifold-opening-discipline-design.md`

---

### Task 1: Extend `_fetchManifoldPrevClose` to carry Scale and Gas Left

**Files:**
- Modify: `index.html`, `_fetchManifoldPrevClose(br)` (search for
  `function _fetchManifoldPrevClose(br){` — line numbers have shifted since this plan was
  written, search for exact text).

- [ ] **Step 1: Add the two fields**

Find:
```javascript
    ((res.data.store_snapshot&&res.data.store_snapshot.manifold)||[]).filter(function(r){return r.stage==='Closing';}).forEach(function(r){
      exp[r.cyl]={brand:r.brand,gasType:r.gasType,tare:num(r.tare)};
    });
```
Change to:
```javascript
    ((res.data.store_snapshot&&res.data.store_snapshot.manifold)||[]).filter(function(r){return r.stage==='Closing';}).forEach(function(r){
      // scale/gasLeft added for the Opening-discipline live check (see popCalc()) - the
      // Removed-step baseline chain that originally built this cache only ever needed
      // brand/gasType/tare, gasLeft is derived defensively (r.gasLeft may be absent on an
      // older row that predates the field) rather than assumed present.
      exp[r.cyl]={brand:r.brand,gasType:r.gasType,tare:num(r.tare),scale:num(r.scale),gasLeft:(r.gasLeft!==undefined?num(r.gasLeft):(num(r.scale)-num(r.tare)))};
    });
```

- [ ] **Step 2: Syntax-check**

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

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: extend _fetchManifoldPrevClose with scale/gasLeft for Opening-discipline check"
```

---

### Task 2: Warning-message elements for Brand and Gas Type fields

**Files:**
- Modify: `index.html`, `buildPopupForm(c,stageOverride)` (search for
  `function buildPopupForm(c,stageOverride){`).

Brand (`type==='select'`) and Gas Type (`type==='gasType'`) currently get no `pf-<field>-warn`
element at all — only `type==='auto'` fields and the hand-coded `tare` field do. Add one to
each, unconditionally (matching the tare field's own precedent — the div is harmless/hidden
whenever nothing needs to populate it, for every capType this form is shared by, not just
Manifold's Opening stage).

- [ ] **Step 1: Add the warn div to the `select` branch's unlocked case**

Find:
```javascript
      } else {
        var _opts=(typeof f.opts==='function')?f.opts():f.opts; html+='<select class="mField" id="pf-'+f.k+'" onchange="popCalc()"><option value="">Select…</option>'+_opts.map(function(o){return '<option'+(f.default!==undefined&&o===f.default?' selected':'')+'>'+o+'</option>';}).join('')+'</select>';
      }
```
Change to:
```javascript
      } else {
        var _opts=(typeof f.opts==='function')?f.opts():f.opts; html+='<select class="mField" id="pf-'+f.k+'" onchange="popCalc()"><option value="">Select…</option>'+_opts.map(function(o){return '<option'+(f.default!==undefined&&o===f.default?' selected':'')+'>'+o+'</option>';}).join('')+'</select>'+
          // Live warning slot for the Manifold Opening-discipline check (see popCalc()) - same
          // shape as the tare field's own -warn div below, harmlessly hidden/unused for every
          // other field/capType/stage this shared form renders.
          '<div class="mNote" id="pf-'+f.k+'-warn" style="display:none"></div>';
      }
```

- [ ] **Step 2: Add the warn div to the `gasType` branch**

Find:
```javascript
    else if(f.type==='gasType')html+='<select class="mField" id="pf-'+f.k+'" onchange="popCalc()"><option value="">Select…</option></select><div class="mNote" id="pf-gasNote"></div>';
```
Change to:
```javascript
    else if(f.type==='gasType')html+='<select class="mField" id="pf-'+f.k+'" onchange="popCalc()"><option value="">Select…</option></select><div class="mNote" id="pf-gasNote"></div>'+
      '<div class="mNote" id="pf-'+f.k+'-warn" style="display:none"></div>';
```

- [ ] **Step 3: Syntax-check** (same command as Task 1). Expected: `ALL SCRIPT BLOCKS OK`

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: add live-warning elements for Brand/Gas Type fields"
```

---

### Task 3: Live per-field Opening-discipline checks in `popCalc()`

**Files:**
- Modify: `index.html`, `popCalc()` — search for the existing tare-mismatch block (the exact
  text below).

- [ ] **Step 1: Add the new block right after the existing tare-mismatch block**

Find:
```javascript
    if(_tareBaseline && d.tare!==''){
      var tareLive=Math.round(num(d.tare)*100)/100, tareExp=Math.round(_tareBaseline.tare*100)/100;
      if(tareLive!==tareExp){
        tareEl.classList.add('glWarnFlag');
        if(tareWarnEl){tareWarnEl.textContent='⚠ Doesn\'t match this slot\'s tare — expected '+tareExp.toFixed(2)+'kg';tareWarnEl.style.color='var(--amber)';tareWarnEl.style.display='block';}
      }
    }
  }
  if(capType==='refill')_refillSealHint(d);
}
```
Change to:
```javascript
    if(_tareBaseline && d.tare!==''){
      var tareLive=Math.round(num(d.tare)*100)/100, tareExp=Math.round(_tareBaseline.tare*100)/100;
      if(tareLive!==tareExp){
        tareEl.classList.add('glWarnFlag');
        if(tareWarnEl){tareWarnEl.textContent='⚠ Doesn\'t match this slot\'s tare — expected '+tareExp.toFixed(2)+'kg';tareWarnEl.style.color='var(--amber)';tareWarnEl.style.display='block';}
      }
    }
  }
  // Opening-discipline live flags (Manifold Opening stage only) - zero tolerance, blind entry
  // (never pre-filled/locked - see design doc). As the operator types, compares what they
  // just entered against yesterday's Closing for this exact slot. Brand/Gas Type/Tare/Gas
  // Left each get their own independent flag - a wrong brand and a leaking cylinder are two
  // different problems, both worth surfacing separately. Purely informational, never blocks
  // Save - addLine()'s own save-time re-derivation of this same check is what actually
  // stamps/audit-logs a save-anyway (see there).
  if(capType==='manifold' && toggleSel.stage==='Opening'){
    var _prevClose=_getManifoldPrevClose(capBranch,modalItem);
    [
      {k:'brand',match:function(){return d.brand===_prevClose.brand;},exp:function(){return _prevClose.brand;}},
      {k:'gasType',match:function(){return d.gasType===_prevClose.gasType;},exp:function(){return _prevClose.gasType;}},
      {k:'tare',match:function(){return Math.round(num(d.tare)*100)/100===Math.round(_prevClose.tare*100)/100;},exp:function(){return num(_prevClose.tare).toFixed(2)+'kg';}}
    ].forEach(function(fld){
      var fEl=document.getElementById('pf-'+fld.k), fWarnEl=document.getElementById('pf-'+fld.k+'-warn');
      if(!fEl)return;
      fEl.classList.remove('glWarnFlag');
      if(fWarnEl){fWarnEl.style.display='none';fWarnEl.textContent='';}
      if(_prevClose && d[fld.k]!=='' && d[fld.k]!==undefined && !fld.match()){
        fEl.classList.add('glWarnFlag');
        if(fWarnEl){fWarnEl.textContent='⚠ Doesn\'t match yesterday\'s close — expected '+fld.exp();fWarnEl.style.color='var(--amber)';fWarnEl.style.display='block';}
      }
    });
    // Gas Left shares the auto field's existing warning slot (pf-gasLeft/pf-gasLeft-warn,
    // already populated above by the ceiling/flagged-band block) - only writes to it if that
    // block left it untouched, so a physically-impossible reading (hard-ceiling/flagged-band)
    // always keeps priority over a same-severity consistency flag, matching this file's
    // existing "explicit priority, not accidental clobbering" convention (e.g. .timerisk
    // yielding to an inline bad-data style elsewhere in this same file).
    var glEl=document.getElementById('pf-gasLeft'), glWarnEl=document.getElementById('pf-gasLeft-warn');
    if(glEl && _prevClose && d.scale!=='' && d.tare!=='' && !glEl.classList.contains('glWarnBad') && !glEl.classList.contains('glWarnFlag')){
      var glLiveOD=Math.round((num(d.scale)-num(d.tare))*100)/100, glExpOD=Math.round(num(_prevClose.gasLeft)*100)/100;
      if(glLiveOD!==glExpOD){
        glEl.classList.add('glWarnFlag');
        if(glWarnEl){glWarnEl.textContent='⚠ Doesn\'t match yesterday\'s close — expected '+glExpOD.toFixed(2)+'kg';glWarnEl.style.color='var(--amber)';glWarnEl.style.display='block';}
      }
    }
  }
  if(capType==='refill')_refillSealHint(d);
}
```

- [ ] **Step 2: Syntax-check** (same command as Task 1). Expected: `ALL SCRIPT BLOCKS OK`

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: live per-field Opening-discipline flags in popCalc()"
```

---

### Task 4: Save-time stamping and audit log in `addLine()`

**Files:**
- Modify: `index.html`, `addLine()` — search for the existing Closing tare-stamp block (the
  exact text below).

- [ ] **Step 1: Add the Opening-discipline stamp right after the existing tare-stamp block**

Find:
```javascript
  var _tareMismatchNow=false, _enteredTare, _expectedTare;
  if(capType==='manifold' && toggleSel.stage==='Closing' && _manifoldTareEnabled(capBranch) && _manifoldClosingBaseline && d.tare!==''){
    _enteredTare=Math.round(num(d.tare)*100)/100;_expectedTare=Math.round(_manifoldClosingBaseline.tare*100)/100;
    if(_enteredTare!==_expectedTare){d._tareFlag='MISMATCH';_tareMismatchNow=true;}
  }
```
Change to:
```javascript
  var _tareMismatchNow=false, _enteredTare, _expectedTare;
  if(capType==='manifold' && toggleSel.stage==='Closing' && _manifoldTareEnabled(capBranch) && _manifoldClosingBaseline && d.tare!==''){
    _enteredTare=Math.round(num(d.tare)*100)/100;_expectedTare=Math.round(_manifoldClosingBaseline.tare*100)/100;
    if(_enteredTare!==_expectedTare){d._tareFlag='MISMATCH';_tareMismatchNow=true;}
  }
  // Opening-discipline stamp - same mechanism as the Closing tare-stamp just above: stamp d
  // now so it rides along if the row DOES end up saved, defer the audit-log call itself to
  // the onDone(saved) callback below (this same d could still be hard-blocked or pending a
  // gas-left override for reasons unrelated to Opening-discipline). Reuses _tareFlag for the
  // tare mismatch specifically (same meaning as the Removed/Closing checks - "didn't match
  // what it should have"), and three new flags for Brand/Gas Type/Gas Left, since those are
  // Opening-discipline-specific concerns _tareFlag/_residualFlag don't cover.
  var _odMismatchNow=false, _odDetails=[];
  if(capType==='manifold' && toggleSel.stage==='Opening'){
    var _odPrevClose=_getManifoldPrevClose(capBranch,d._capturedModalItem||modalItem);
    if(_odPrevClose){
      if(d.brand!==_odPrevClose.brand){d._openingBrandFlag='MISMATCH';_odMismatchNow=true;_odDetails.push('brand '+d.brand+' (expected '+_odPrevClose.brand+')');}
      if(d.gasType!==_odPrevClose.gasType){d._openingGasTypeFlag='MISMATCH';_odMismatchNow=true;_odDetails.push('gas type '+d.gasType+' (expected '+_odPrevClose.gasType+')');}
      var _odTareEntered=Math.round(num(d.tare)*100)/100, _odTareExp=Math.round(_odPrevClose.tare*100)/100;
      if(d.tare!=='' && _odTareEntered!==_odTareExp){d._tareFlag='MISMATCH';_odMismatchNow=true;_odDetails.push('tare '+_odTareEntered.toFixed(2)+'kg (expected '+_odTareExp.toFixed(2)+'kg)');}
      if(d.scale!=='' && d.tare!==''){
        var _odGlEntered=Math.round((num(d.scale)-num(d.tare))*100)/100, _odGlExp=Math.round(num(_odPrevClose.gasLeft)*100)/100;
        if(_odGlEntered!==_odGlExp){d._openingGasLeftFlag='MISMATCH';_odMismatchNow=true;_odDetails.push('gas left '+_odGlEntered.toFixed(2)+'kg (expected '+_odGlExp.toFixed(2)+'kg)');}
      }
    }
  }
```

- [ ] **Step 2: Add the audit log call in the `onDone(saved)` callback**

Find:
```javascript
    if(saved && _tareMismatchNow)auditLog('Manifold tare mismatch',capBranch+' — '+d._capturedModalItem+' — entered '+_enteredTare.toFixed(2)+'kg, expected '+_expectedTare.toFixed(2)+'kg (saved anyway)');
  });
}
```
Change to:
```javascript
    if(saved && _tareMismatchNow)auditLog('Manifold tare mismatch',capBranch+' — '+d._capturedModalItem+' — entered '+_enteredTare.toFixed(2)+'kg, expected '+_expectedTare.toFixed(2)+'kg (saved anyway)');
    if(saved && _odMismatchNow)auditLog('Manifold Opening discipline mismatch',capBranch+' — '+d._capturedModalItem+' — '+_odDetails.join(', ')+' (saved anyway)');
  });
}
```

**IMPORTANT:** `_odDetails`/`_odMismatchNow` must be declared in the same enclosing function
scope as the `onDone` callback closure (same as `_tareMismatchNow`/`_enteredTare`/
`_expectedTare` already are) - confirm this before editing, don't just pattern-match blindly.

- [ ] **Step 3: Syntax-check** (same command as Task 1). Expected: `ALL SCRIPT BLOCKS OK`

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: save-time stamping and audit log for Opening-discipline mismatches"
```

---

### Task 5: Sequential order lock in `renderGrid()`

**Files:**
- Modify: `index.html`, `renderGrid()` — search for the exact text below.

- [ ] **Step 1: Add the doneMap computation and the per-tile lock check**

Find:
```javascript
  var _rejectedCyls={}, _approvedCyls={};
  if(capType==='manifold'){
    var _curStage=(toggleSel&&toggleSel.stage)||'Opening';
    (store.manifold||[]).forEach(function(r){
      if(r.branch!==capBranch || (r._date||today)!==today || (r.stage||'Opening')!==_curStage)return;
      if(r._overrideStatus==='REJECTED')_rejectedCyls[r.cyl]=true;
      else if(r._overrideStatus==='APPROVED')_approvedCyls[r.cyl]=true;
    });
  }
  document.getElementById('capGrid').innerHTML=(typeof c.grid==='function'?c.grid():c.grid).map(function(item){
```
Change to:
```javascript
  var _rejectedCyls={}, _approvedCyls={};
  if(capType==='manifold'){
    var _curStage=(toggleSel&&toggleSel.stage)||'Opening';
    (store.manifold||[]).forEach(function(r){
      if(r.branch!==capBranch || (r._date||today)!==today || (r.stage||'Opening')!==_curStage)return;
      if(r._overrideStatus==='REJECTED')_rejectedCyls[r.cyl]=true;
      else if(r._overrideStatus==='APPROVED')_approvedCyls[r.cyl]=true;
    });
  }
  var _gridItems=(typeof c.grid==='function'?c.grid():c.grid);
  // Sequential order lock (Manifold Opening stage only) - operational discipline, confirmed
  // explicitly: "operator subjected to discipline [rather] than confusion trying to figure
  // out what fits where" - hard-blocked, no override. Pre-computed once per render as a
  // doneMap (same "done" definition _manifoldOpeningAlreadyCaptured/the existing done check
  // already use - draft OR committed counts), not re-derived per tile, so each tile's lock
  // check is just a backward scan through this map instead of recomputing "is slot X done"
  // from scratch for every other tile on every render.
  var _openingDoneMap={};
  if(capType==='manifold' && toggleSel.stage==='Opening'){
    _gridItems.forEach(function(gi){
      var giLines=(bucket[gi]||[]).filter(function(l){return (l._addedBranch||capBranch)===capBranch;});
      _openingDoneMap[gi]=giLines.length>0;
    });
  }
  document.getElementById('capGrid').innerHTML=_gridItems.map(function(item,_idx){
```

- [ ] **Step 2: Add the lock check and early-return inside the tile-building callback**

Find:
```javascript
    var act=canUseItem(branch||'Helderberg',_secKey,item);
    if(!act){
      return '<button class="csize" style="background:#EDEDED;color:#B0B0B0;opacity:.7;cursor:not-allowed" onclick="toast(\''+item+' is deactivated for this branch/user\',true)"><span class="sz" style="color:#B0B0B0">'+item+'</span><span class="det" style="font-size:10px">—</span></button>';
    }
```
Change to:
```javascript
    var act=canUseItem(branch||'Helderberg',_secKey,item);
    if(!act){
      return '<button class="csize" style="background:#EDEDED;color:#B0B0B0;opacity:.7;cursor:not-allowed" onclick="toast(\''+item+' is deactivated for this branch/user\',true)"><span class="sz" style="color:#B0B0B0">'+item+'</span><span class="det" style="font-size:10px">—</span></button>';
    }
    if(capType==='manifold' && toggleSel.stage==='Opening'){
      var _orderBlocker=null;
      for(var _pi=0;_pi<_idx;_pi++){ if(!_openingDoneMap[_gridItems[_pi]]){_orderBlocker=_gridItems[_pi];break;} }
      if(_orderBlocker){
        return '<button class="csize" style="background:#EDEDED;color:#B0B0B0;opacity:.7;cursor:not-allowed" onclick="toast(\'Complete '+_orderBlocker+' first — Opening must be captured in order\',true)"><span class="sz" style="color:#B0B0B0">'+item+'</span><span class="det" style="font-size:10px">locked — do '+_orderBlocker+' first</span></button>';
      }
    }
```

- [ ] **Step 3: Syntax-check** (same command as Task 1). Expected: `ALL SCRIPT BLOCKS OK`

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: sequential order lock for Manifold Opening capture"
```

---

### Task 6: History table and Count Doc markers

**Files:**
- Modify: `index.html` — the Manifold table row template in `openHistory()` and the matching
  one in the Count Doc builder (search for the exact text below; both are near-identical,
  edit both).

- [ ] **Step 1: `openHistory()`'s Manifold table row**

Find:
```javascript
      man.filter(function(m){return (m.stage||'Opening')===stg;}).forEach(function(m){html+='<tr><td><b>'+stg+'</b></td><td>'+m.cyl+'</td><td>'+(m.gasType||'')+'</td><td class="n">'+(+m.scale).toFixed(2)+'</td><td class="n">'+(+m.tare).toFixed(2)+(m._tareFlag?' <span style="color:var(--amber)" title="Didn\'t match this slot\'s expected tare when saved">⚠</span>':'')+'</td><td class="n">'+(+m.gasLeft).toFixed(2)+(m._residualFlag?' <span style="color:var(--amber)" title="Leftover gas confirmed on removal - logged in Residual Gas">⚠</span>':'')+'</td><td>'+(m.cylState||'—')+'</td><td>'+(m.notes||'—')+'</td><td>'+(function(){var ph=Array.isArray(m.photo)?m.photo:(m.photo?[m.photo]:[]);return ph.length?ph.map(function(s){return '<img src="'+s+'" style="max-height:40px;border-radius:4px;margin:1px">';}).join(''):'—';})()+'</td></tr>';});
```
Change to (only the Gas cell and the Left cell's condition change — Cyl/Scale/Tare/Condition/
Note/Photo cells are untouched):
```javascript
      man.filter(function(m){return (m.stage||'Opening')===stg;}).forEach(function(m){html+='<tr><td><b>'+stg+'</b></td><td>'+m.cyl+'</td><td>'+(m.gasType||'')+(m._openingGasTypeFlag?' <span style="color:var(--amber)" title="Didn\'t match yesterday\'s Closing gas type when saved">⚠</span>':'')+'</td><td class="n">'+(+m.scale).toFixed(2)+'</td><td class="n">'+(+m.tare).toFixed(2)+(m._tareFlag?' <span style="color:var(--amber)" title="Didn\'t match this slot\'s expected tare when saved">⚠</span>':'')+'</td><td class="n">'+(+m.gasLeft).toFixed(2)+((m._residualFlag||m._openingGasLeftFlag)?' <span style="color:var(--amber)" title="'+(m._residualFlag?'Leftover gas confirmed on removal - logged in Residual Gas':'Didn\'t match yesterday\'s Closing gas left when saved')+'">⚠</span>':'')+'</td><td>'+(m.cylState||'—')+'</td><td>'+(m.notes||'—')+'</td><td>'+(function(){var ph=Array.isArray(m.photo)?m.photo:(m.photo?[m.photo]:[]);return ph.length?ph.map(function(s){return '<img src="'+s+'" style="max-height:40px;border-radius:4px;margin:1px">';}).join(''):'—';})()+'</td></tr>';});
```

- [ ] **Step 2: Count Doc's matching Manifold table row**

Find:
```javascript
      man.filter(function(m){return (m.stage||'Opening')===stg;}).forEach(function(m){rows+='<tr><td><b>'+stg+'</b></td><td>'+m.cyl+'</td><td>'+(m.gasType||'')+'</td><td class="n">'+(+m.scale).toFixed(2)+'</td><td class="n">'+(+m.tare).toFixed(2)+(m._tareFlag?' <span style="color:#B5533B" title="Did not match this slot\'s expected tare when saved">⚠</span>':'')+'</td><td class="n">'+(+m.gasLeft).toFixed(2)+(m._residualFlag?' <span style="color:#B5533B" title="Leftover gas confirmed on removal - logged in Residual Gas">⚠</span>':'')+'</td><td>'+(m.cylState||'—')+'</td><td>'+(m.notes||'—')+'</td><td>'+_photoCell(m)+'</td></tr>';});
```
Change to:
```javascript
      man.filter(function(m){return (m.stage||'Opening')===stg;}).forEach(function(m){rows+='<tr><td><b>'+stg+'</b></td><td>'+m.cyl+'</td><td>'+(m.gasType||'')+(m._openingGasTypeFlag?' <span style="color:#B5533B" title="Did not match yesterday\'s Closing gas type when saved">⚠</span>':'')+'</td><td class="n">'+(+m.scale).toFixed(2)+'</td><td class="n">'+(+m.tare).toFixed(2)+(m._tareFlag?' <span style="color:#B5533B" title="Did not match this slot\'s expected tare when saved">⚠</span>':'')+'</td><td class="n">'+(+m.gasLeft).toFixed(2)+((m._residualFlag||m._openingGasLeftFlag)?' <span style="color:#B5533B" title="'+(m._residualFlag?'Leftover gas confirmed on removal - logged in Residual Gas':'Did not match yesterday\'s Closing gas left when saved')+'">⚠</span>':'')+'</td><td>'+(m.cylState||'—')+'</td><td>'+(m.notes||'—')+'</td><td>'+_photoCell(m)+'</td></tr>';});
```

**Note (explicitly scoped, not a gap to fix here):** neither table has a Brand column today,
so a Brand mismatch is not shown visually in History/Count Doc — it's still fully captured in
the row's own `_openingBrandFlag` field and named in the audit log entry (Task 4), which is
sufficient traceability for this phase. Adding a Brand column would be a larger, separate
layout change out of scope here.

- [ ] **Step 3: Syntax-check** (same command as Task 1). Expected: `ALL SCRIPT BLOCKS OK`

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: Gas Type/Gas Left mismatch markers in History and Count Doc"
```

---

### Task 7: Live verification and push

No automated test suite exists — verification is live and direct.

- [ ] **Step 1: Verify blind entry (no pre-fill/lock)**

Open Manifold Opening for a branch/slot that has a Closing recorded yesterday. Confirm Brand,
Gas Type, Scale, Tare are all open, empty/default, and fully editable — nothing pre-filled,
nothing locked.

- [ ] **Step 2: Verify live per-field flags**

Type a Brand different from yesterday's close → confirm the Brand field flags immediately.
Same for Gas Type. Type a Tare that differs at all → flags. Type a Scale/Tare combination
whose Gas Left differs from yesterday's close → the Gas Left field flags. Confirm all four
can be flagged simultaneously and independently. Confirm typing the CORRECT values (matching
yesterday's close exactly) shows no flags at all.

- [ ] **Step 3: Verify the ceiling/flagged-band priority rule**

Enter a Scale/Tare that's BOTH an Opening-discipline mismatch AND triggers the existing
hard-ceiling or flagged-band warning — confirm the ceiling/flagged-band message wins (shown),
not silently overwritten by the Opening-discipline message.

- [ ] **Step 4: Verify save-anyway stamping**

Save a flagged reading anyway. Confirm: the row saves (never blocked), the relevant flag
field(s) are set on the row, an audit log entry is written naming exactly which fields
differed and their values, and History/Count Doc show the ⚠ marker on the Gas/Tare/Left
cells as appropriate.

- [ ] **Step 5: Verify the sequential order lock**

With no Opening captured yet today for any slot: confirm Cyl 1 is open/tappable and every
other slot is locked/greyed with the correct "do Cyl N first" toast. Capture Cyl 1 (draft,
not yet committed) → confirm Cyl 2 unlocks, Cyl 3+ still locked. Commit Cyl 1 → confirm the
lock state is unaffected (draft or committed both count as "done"). Confirm Added/Closing/
Removed stages are completely unaffected by this lock (no greying, normal behavior).

- [ ] **Step 6: Verify a slot with no prior Closing data**

For a slot/branch with no Closing recorded yesterday (or ever): confirm no flags fire at all
(no baseline, no check — matching the existing graceful "no baseline" behavior everywhere
else in this feature set) and the sequential order lock still applies normally (order
discipline is independent of whether a prior-close baseline exists).

- [ ] **Step 7: Regression-check**

Confirm every other Manifold feature already shipped this session (tolerances, same-day
Opening lock, Removed/Closing tare-mismatch, hard-ceiling override, remote override approval,
live cross-device data, rejected-reading recheck flow) still behaves exactly as before — none
of this task's code touches their paths, but verify live rather than assume.

- [ ] **Step 8: Push**

```bash
git push origin main
```
