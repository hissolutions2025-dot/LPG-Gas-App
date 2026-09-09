# Branch Transfers (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture cylinder stock moving between Helderberg and Kleinmond — dispatch → receipt → manager approval, each stage signed — so a transfer nets correctly into stock instead of looking like a phantom sale (sending branch) or an unexplained surplus (receiving branch).

**Architecture:** New `stock_transfers` Supabase table (insert at dispatch, `.update()` at receipt and approval — no RLS/schema changes to any existing table). New Apps Script `Transfers` sheet tab, written via a dedicated `transferDispatch` action at creation and a `transferUpdate` action (mirrors the existing `adjustRow`/RowId pattern) at receipt/approval, so the Sheet shows one row per transfer that fills in over time rather than three separate rows. New Owner-only tile and screen in index.html (three tabs: New Transfer, Awaiting Receipt, Awaiting Approval) reusing the existing size/brand grid pattern (`ALLSIZES`/`BRANDS`) and a lightweight one-shot signature canvas (not the persistent Day-Close-style sig pad — each of the three signatures happens once, immediately, not accumulated over a shift). Close Day gains a new hard-block gate: a branch can't close while a transfer touching it today isn't yet `approved`.

**Tech Stack:** Vanilla JS (single-file `index.html`), Supabase (Postgres + RLS), Google Apps Script (`GAS_MASTER.gs`, deployed as the `sheets-sync` proxy target).

**Rollout note (per the design spec):** the new tile is gated `role==='Owner'` only for this plan — not the real target audience (both branches' Operators for dispatch/receipt, Manager/Owner for approval). Opening it up to Operators is a deliberate small follow-up change *after* this is verified live, not part of this plan.

---

### Task 1: `stock_transfers` Supabase table

**Files:**
- Create: `supabase/migrations/20260910000000_stock_transfers.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Branch Transfers (Phase 2 of docs/superpowers/specs/2026-09-09-stock-balance-management-design.md)
CREATE TABLE IF NOT EXISTS stock_transfers (
  id uuid primary key default gen_random_uuid(),
  row_id text,                         -- client-generated id, mirrors dispatch_sig's Sheet RowId for transferUpdate lookups
  from_branch text not null,
  to_branch text not null,
  items jsonb not null,                -- [{size,brand,state,qtyDispatched,qtyReceived,shortfallReason,note}]
  status text not null default 'pending_receipt', -- 'pending_receipt' | 'received' | 'approved' | 'cancelled'
  note text,
  dispatch_operator_id uuid references profiles(id),
  dispatch_operator_name_snapshot text,
  dispatch_sig text,                   -- data URL
  dispatch_at timestamptz default now(),
  receive_operator_id uuid references profiles(id),
  receive_operator_name_snapshot text,
  receive_sig text,
  receive_at timestamptz,
  manager_id uuid references profiles(id),
  manager_name_snapshot text,
  manager_sig text,
  approved_at timestamptz
);
CREATE INDEX IF NOT EXISTS stock_transfers_branch_status_idx ON stock_transfers (from_branch, to_branch, status);
CREATE INDEX IF NOT EXISTS stock_transfers_dispatch_at_idx ON stock_transfers (dispatch_at);

ALTER TABLE stock_transfers ENABLE ROW LEVEL SECURITY;
CREATE POLICY stock_transfers_select ON stock_transfers FOR SELECT TO authenticated USING (true);
CREATE POLICY stock_transfers_insert ON stock_transfers FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY stock_transfers_update ON stock_transfers FOR UPDATE TO authenticated USING (auth.uid() IS NOT NULL) WITH CHECK (auth.uid() IS NOT NULL);
```

- [ ] **Step 2: Apply it**

Run:
```bash
cd "C:/Users/Freddie Du Plessis/OneDrive/Desktop/LPG-Gas-App"
supabase db push --linked
```
Expected: `Applying migration 20260910000000_stock_transfers.sql...` then success, no errors.

- [ ] **Step 3: Verify the table and policies exist**

Run (PowerShell):
```powershell
supabase db query --linked -o json "select column_name,data_type from information_schema.columns where table_name='stock_transfers' order by ordinal_position;"
supabase db query --linked -o json "select policyname,cmd from pg_policies where tablename='stock_transfers';"
```
Expected: 19 columns matching the migration; 3 policies (`select`,`insert`,`update`).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260910000000_stock_transfers.sql
git commit -m "feat: stock_transfers table for Branch Transfers (Phase 2)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Apps Script — `Transfers` sheet tab + dispatch/update actions

**Files:**
- Modify: the bound Apps Script project behind the `sheets-sync` proxy (same file you pasted into me earlier this session for v15 — call this v16). You'll paste the full updated script the same way as last time.

- [ ] **Step 1: Add the Transfers schema**

In the `TABS`/`HEADERS` section, add a new entry (this one is NOT written through the generic `doPost` TABS writer — see Step 2 — but keeping it in these maps lets `setupSheets()` create the tab with the right header row, same as every other tab):

```javascript
// Added to TABS:
Transfers: ['FromBranch','ToBranch','Size','Brand','State','QtyDispatched','QtyReceived','ShortfallReason','Note','Status','DispatchOperator','ReceiveOperator','Manager','RowId'],
```
```javascript
// Added to HEADERS:
Transfers: ['Timestamp','Date','Time','Branch','FromBranch','ToBranch','Size','Brand','State','Qty Dispatched','Qty Received','Shortfall Reason','Note','Status','Dispatch Operator','Receive Operator','Manager','Row Id'],
```
(`Branch` in META stays blank/unused for this tab — `FromBranch`/`ToBranch` are the meaningful columns; META is still written for every tab so the Timestamp/Date/Time columns stay consistent with the rest of the workbook.)

- [ ] **Step 2: Add the `transferDispatch` and `transferUpdate` actions to `doPost`**

Add these two `if(type===...)` blocks in `doPost`, in the same spot as the other special-cased actions (`faultyLog`/`residualLog`/`photoUpload` etc. — right after the `photoUpload` block, before the generic `PdfArchive` block):

```javascript
// ===================== v16 NEW: BRANCH TRANSFERS =====================
// One row per transfer line item, created at dispatch, filled in over time via
// transferUpdate (mirrors _handleAdjustRow's RowId-match-and-update-in-place pattern
// below) rather than appending new rows for receipt/approval - a human reading the
// Transfers tab sees one row per line item that gains Qty Received / Status /
// Receive Operator / Manager as the transfer progresses, not three disconnected rows.
if(type==='transferDispatch'){
  return _handleTransferDispatch(body);
}
if(type==='transferUpdate'){
  return _handleTransferUpdate(body);
}
// ===================== end v16 NEW =====================
```

Then add the two handler functions (put them near `_handleAdjustRow`, same section of the file):

```javascript
function _handleTransferDispatch(body){
  var rows=body.rows||[];
  if(!rows.length) return _json({ok:false,error:'no rows'});
  var sh=_ss().getSheetByName('Transfers');
  if(!sh||sh.getLastRow()===0){ setupSheets(); sh=_ss().getSheetByName('Transfers'); }
  var keys=['FromBranch','ToBranch','Size','Brand','State','QtyDispatched','QtyReceived','ShortfallReason','Note','Status','DispatchOperator','ReceiveOperator','Manager','RowId'];
  var out=rows.map(function(r){
    var line=_metaCells(r);
    keys.forEach(function(k){ line.push(r[k]!==undefined?r[k]:''); });
    return line;
  });
  var startRow=sh.getLastRow()+1;
  sh.getRange(startRow,1,out.length,out[0].length).setValues(out);
  return _json({ok:true,wrote:out.length});
}
// body: {rowId:'<line's RowId>', updates:{FieldName:newValue, ...}}
// Same shape and same in-place-update-only guarantee as _handleAdjustRow above (never
// appends, so this can never double a line) - kept as its own function rather than
// routed through _handleAdjustRow because Transfers isn't in the generic TABS map
// (transferDispatch writes it directly, not via the generic writer _handleAdjustRow's
// TABS[tab] lookup depends on).
function _handleTransferUpdate(body){
  if(!body.rowId) return _json({ok:false,error:'no rowId supplied'});
  var sh=_ss().getSheetByName('Transfers');
  if(!sh) return _json({ok:false,error:'Transfers sheet not found'});
  var keys=['FromBranch','ToBranch','Size','Brand','State','QtyDispatched','QtyReceived','ShortfallReason','Note','Status','DispatchOperator','ReceiveOperator','Manager','RowId'];
  var ridIdx=keys.indexOf('RowId');
  var last=sh.getLastRow();
  if(last<2) return _json({ok:false,error:'row not found (sheet is empty): '+body.rowId});
  var ridCol=META.length+ridIdx+1;
  var ids=sh.getRange(2,ridCol,last-1,1).getValues();
  var rowIndex=-1;
  for(var i=0;i<ids.length;i++){
    if(String(ids[i][0])===String(body.rowId)){ rowIndex=i+2; break; }
  }
  if(rowIndex===-1) return _json({ok:false,error:'row not found for id: '+body.rowId});
  var updates=body.updates||{};
  var applied=[];
  Object.keys(updates).forEach(function(k){
    var kIdx=keys.indexOf(k);
    if(kIdx===-1) return;
    sh.getRange(rowIndex,META.length+kIdx+1).setValue(updates[k]);
    applied.push(k);
  });
  if(applied.length===0) return _json({ok:false,error:'none of the given field names matched this sheet\'s columns'});
  return _json({ok:true, rowIndex:rowIndex, applied:applied});
}
```

- [ ] **Step 3: Bump the version, deploy**

Change `doGet`'s message to `'Gas Sales v16 endpoint live'` (same one-line convention as every prior version bump), update the file's header comment block the same way v15's was (a v16 changelog paragraph explaining Branch Transfers). Save, **Deploy → Manage deployments → edit existing deployment → New version → Deploy**, confirm the `/exec` URL returns `{"ok":true,"msg":"Gas Sales v16 endpoint live"}`.

- [ ] **Step 4: Verify the Transfers tab was created correctly**

Open the spreadsheet, confirm a new `Transfers` tab exists with the 18-column header row matching Step 1's `HEADERS.Transfers` list, frozen row 1, bold header (same as every other tab — this happens automatically the first time `doPost` calls `setupSheets()` because the tab doesn't exist yet, per Step 2's `if(!sh||sh.getLastRow()===0)` guard).

---

### Task 3: index.html — data layer (push/fetch/update for `stock_transfers`)

**Files:**
- Modify: `index.html` (add near the other live-mirror push/fetch functions — `_pushManifoldLiveRows`/`_fetchManifoldLiveRows` around line 1116-1146 is the closest existing pattern to follow)

- [ ] **Step 1: Add the Supabase push/fetch/update functions**

Add this block right after `_pushManifoldPendingOverrides`'s section (after line 1162's closing, before the `_manifoldPendingQueue`/`_manifoldPendingFlush` functions — same neighbourhood, new self-contained block):

```javascript
// ===== Branch Transfers (stock_transfers) - Phase 2 of the Stock Balance Management
// spec (docs/superpowers/specs/2026-09-09-stock-balance-management-design.md).
// Dispatch = insert. Receipt/Approval = .update() on the same row (Supabase supports
// this directly, unlike the Sheet - see _syncTransferUpdate below for the Sheet side,
// which mirrors _handleAdjustRow's RowId-match pattern via the new transferUpdate
// Apps Script action). A push failure here queues to localStorage and retries at
// login, same convention _pushManifoldLiveRows already uses.
function _pushTransferDispatch(items,fromBranch,toBranch,note){
  var rid='xfer_'+Date.now()+'_'+Math.floor(Math.random()*100000);
  var payload={
    row_id:rid, from_branch:fromBranch, to_branch:toBranch, items:items, note:note||'',
    status:'pending_receipt',
    dispatch_operator_id:currentProfile&&currentProfile.id, dispatch_operator_name_snapshot:operator,
    dispatch_sig:_xferSig.dispatch||''
  };
  return sb.from('stock_transfers').insert(payload).select().then(function(res){
    if(res.error){console.error('_pushTransferDispatch failed:',res.error.message);_transferQueue({kind:'dispatch',payload:payload});return null;}
    syncPush('Transfer',items.map(function(it){
      return {ts:_nowISO(),date:today,branch:fromBranch,FromBranch:fromBranch,ToBranch:toBranch,
        Size:it.size,Brand:it.brand,State:it.state,QtyDispatched:it.qtyDispatched,QtyReceived:'',
        ShortfallReason:'',Note:note||'',Status:'pending_receipt',DispatchOperator:operator,
        ReceiveOperator:'',Manager:'',RowId:rid};
    }),'transferDispatch');
    return (res.data&&res.data[0])||null;
  },function(e){console.error('_pushTransferDispatch rejected:',e&&e.message);_transferQueue({kind:'dispatch',payload:payload});return null;});
}
function _fetchTransfersAwaitingReceipt(br){
  return sb.from('stock_transfers').select('*').eq('to_branch',br).eq('status','pending_receipt').then(function(res){
    if(res.error){console.error('_fetchTransfersAwaitingReceipt failed:',res.error.message);return [];}
    return res.data||[];
  },function(){return [];});
}
function _fetchTransfersAwaitingApproval(){
  return sb.from('stock_transfers').select('*').eq('status','received').then(function(res){
    if(res.error){console.error('_fetchTransfersAwaitingApproval failed:',res.error.message);return [];}
    return res.data||[];
  },function(){return [];});
}
// items = the same array, with qtyReceived/shortfallReason filled in per line
function _confirmTransferReceipt(id,items){
  var patch={items:items,status:'received',receive_operator_id:currentProfile&&currentProfile.id,
    receive_operator_name_snapshot:operator,receive_sig:_xferSig.receive||'',receive_at:new Date().toISOString()};
  return sb.from('stock_transfers').update(patch).eq('id',id).select().then(function(res){
    if(res.error){console.error('_confirmTransferReceipt failed:',res.error.message);return false;}
    var row=(res.data&&res.data[0])||null;
    if(row&&row.row_id){
      items.forEach(function(it){
        apiPost('transferUpdate',{rowId:row.row_id,updates:{QtyReceived:it.qtyReceived,ShortfallReason:it.shortfallReason||'',Status:'received',ReceiveOperator:operator}});
      });
    }
    return true;
  },function(e){console.error('_confirmTransferReceipt rejected:',e&&e.message);return false;});
}
function _approveTransfer(id,rowId){
  var patch={status:'approved',manager_id:currentProfile&&currentProfile.id,manager_name_snapshot:operator,
    manager_sig:_xferSig.approve||'',approved_at:new Date().toISOString()};
  return sb.from('stock_transfers').update(patch).eq('id',id).then(function(res){
    if(res.error){console.error('_approveTransfer failed:',res.error.message);return false;}
    if(rowId)apiPost('transferUpdate',{rowId:rowId,updates:{Status:'approved',Manager:operator}});
    return true;
  },function(e){console.error('_approveTransfer rejected:',e&&e.message);return false;});
}
// Same-day/branch gate for closeDay() - see Task 7.
function _fetchUnapprovedTransfersTouching(br,date){
  return sb.from('stock_transfers').select('id,from_branch,to_branch,status')
    .or('from_branch.eq.'+br+',to_branch.eq.'+br)
    .neq('status','approved').neq('status','cancelled')
    .gte('dispatch_at',date+'T00:00:00').lte('dispatch_at',date+'T23:59:59')
    .then(function(res){
      if(res.error){console.error('_fetchUnapprovedTransfersTouching failed:',res.error.message);return [];}
      return res.data||[];
    },function(){return [];});
}
function _transferQueue(entry){
  try{var q=JSON.parse(localStorage.getItem('gs_transfer_queue')||'[]');q.push(entry);localStorage.setItem('gs_transfer_queue',JSON.stringify(q.slice(-200)));}catch(e){}
}
function _transferFlush(){
  var q;try{q=JSON.parse(localStorage.getItem('gs_transfer_queue')||'[]');}catch(e){return;}
  if(!q.length)return;
  localStorage.setItem('gs_transfer_queue','[]');
  q.forEach(function(entry){
    if(entry.kind==='dispatch'){
      sb.from('stock_transfers').insert(entry.payload).then(function(res){if(res.error)_transferQueue(entry);},function(){_transferQueue(entry);});
    }
  });
}
// One-shot signature capture for the three transfer signers - deliberately NOT the
// persistent Day-Close-style sig pad (sigData/sigUnlocked/sigSignedBy): each of these
// three signatures happens once, immediately, at its own stage, not accumulated over
// a whole shift with lock/unlock/restore-after-reload semantics. Plain canvas, drawn
// then read via toDataURL at submit time.
var _xferSig={dispatch:'',receive:'',approve:''};
function _initXferSigCanvas(canvasId,sigKey){
  var cv=document.getElementById(canvasId);if(!cv||cv._init)return;cv._init=true;
  var ctx=cv.getContext('2d');ctx.lineWidth=2.2;ctx.lineCap='round';ctx.strokeStyle='#16202B';
  var drawing=false,last=null;
  function pos(e){var r=cv.getBoundingClientRect();var t=e.touches?e.touches[0]:e;return {x:(t.clientX-r.left)*(cv.width/r.width),y:(t.clientY-r.top)*(cv.height/r.height)};}
  function start(e){drawing=true;last=pos(e);e.preventDefault();}
  function move(e){if(!drawing)return;var p=pos(e);ctx.beginPath();ctx.moveTo(last.x,last.y);ctx.lineTo(p.x,p.y);ctx.stroke();last=p;_xferSig[sigKey]=cv.toDataURL('image/png');e.preventDefault();}
  function end(){drawing=false;}
  cv.addEventListener('mousedown',start);cv.addEventListener('mousemove',move);cv.addEventListener('mouseup',end);cv.addEventListener('mouseleave',end);
  cv.addEventListener('touchstart',start,{passive:false});cv.addEventListener('touchmove',move,{passive:false});cv.addEventListener('touchend',end);
}
function _xferSigClear(canvasId,sigKey){var cv=document.getElementById(canvasId);if(cv)cv.getContext('2d').clearRect(0,0,cv.width,cv.height);_xferSig[sigKey]='';}
```

- [ ] **Step 2: Call `_transferFlush()` alongside the other queue flushes**

In `_finishLogin` (the same block that already calls `_manifoldLiveFlush(); _manifoldPendingFlush();` around line 3530-3531), add:
```javascript
_transferFlush();
```

- [ ] **Step 3: Syntax check**

```powershell
$content = Get-Content "C:\Users\Freddie Du Plessis\OneDrive\Desktop\LPG-Gas-App\index.html" -Raw
$matches = [regex]::Matches($content, '(?s)<script>(.*?)</script>')
$biggest = $matches | Sort-Object { $_.Groups[1].Value.Length } -Descending | Select-Object -First 1
Set-Content -Path "$env:TEMP\claude\_check.js" -Value $biggest.Groups[1].Value -Encoding utf8
node --check "$env:TEMP\claude\_check.js"
Remove-Item "$env:TEMP\claude\_check.js" -Force
```
Expected: no output (success).

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: Branch Transfers data layer (dispatch/receipt/approval push+fetch, one-shot sig capture)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: index.html — tile, screen shell, New Transfer (dispatch) tab

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Add the Home tile**

Right after the Admin tile (`index.html:324`), add:
```html
<button class="tile t6" data-key="transfer" id="tileTransfer" onclick="openTransfers()" style="display:none"><div class="ic">&#8646;</div><h3>Stock Transfer</h3><p>Owner: move cylinders between branches</p><span class="badge" id="b-transfer" style="display:none">0</span></button>
```

- [ ] **Step 2: Gate its visibility to Owner (rollout-safety gate from the spec)**

Right after `index.html:3518`'s `_tpo` line, add:
```javascript
var _ttr=document.getElementById('tileTransfer');if(_ttr)_ttr.style.display=(role==='Owner')?'flex':'none';
```

- [ ] **Step 3: Add the screen shell (3 tabs) as a new `<div class="view">`**

Add near the other screen divs (same pattern as e.g. the Received or Manifold screen — a `<div id="transferScreen" class="view">` with a `<div class="wrap">` inside). Full markup:

```html
<div id="transferScreen" class="view">
  <div class="wrap">
    <div style="display:flex;gap:8px;margin-bottom:14px">
      <button class="sigClear" id="xferTabNewBtn" onclick="xferShowTab('new')" style="flex:1">New Transfer</button>
      <button class="sigClear" id="xferTabReceiptBtn" onclick="xferShowTab('receipt')" style="flex:1">Awaiting Receipt</button>
      <button class="sigClear" id="xferTabApprovalBtn" onclick="xferShowTab('approval')" style="flex:1">Awaiting Approval</button>
    </div>

    <div id="xferTabNew">
      <label>From branch</label>
      <select id="xferFromBranch" onchange="xferRenderItems()"><option>Helderberg</option><option>Kleinmond</option></select>
      <label>To branch</label>
      <select id="xferToBranch"><option>Kleinmond</option><option>Helderberg</option></select>
      <div id="xferItemsGrid"></div>
      <label>Note (optional)</label>
      <textarea id="xferNote" rows="2" style="width:100%"></textarea>
      <label>Dispatch operator signature</label>
      <canvas id="xferDispatchSig" width="600" height="150" style="border:1.5px solid var(--steel);border-radius:8px;width:100%;touch-action:none"></canvas>
      <button class="sigClear" onclick="_xferSigClear('xferDispatchSig','dispatch')">Clear signature</button>
      <button onclick="xferCommitDispatch()">Dispatch Transfer</button>
    </div>

    <div id="xferTabReceipt" style="display:none">
      <div id="xferReceiptList"></div>
    </div>

    <div id="xferTabApproval" style="display:none">
      <div id="xferApprovalList"></div>
    </div>
  </div>
</div>
```

- [ ] **Step 4: Add the item grid (reuses `ALLSIZES`/`BRANDS`)**

```javascript
var XFER_STATES=['Full','Empty'];
function xferRenderItems(){
  var g=document.getElementById('xferItemsGrid');
  g.innerHTML=ALLSIZES.map(function(sz){
    return '<div style="display:flex;gap:6px;align-items:center;margin-bottom:4px">'+
      '<span style="width:90px;font-size:12px">'+sz+'</span>'+
      '<select id="xfb-'+sz+'" style="flex:1">'+BRANDS.map(function(b){return '<option>'+b+'</option>';}).join('')+'</select>'+
      '<select id="xfs-'+sz+'" style="width:80px">'+XFER_STATES.map(function(s){return '<option>'+s+'</option>';}).join('')+'</select>'+
      '<input id="xfq-'+sz+'" type="number" min="0" value="0" style="width:70px">'+
      '</div>';
  }).join('');
}
function xferShowTab(name){
  ['new','receipt','approval'].forEach(function(n){
    document.getElementById('xferTab'+n[0].toUpperCase()+n.slice(1)).style.display=(n===name)?'block':'none';
    document.getElementById('xferTab'+n[0].toUpperCase()+n.slice(1)+'Btn').classList.toggle('on',n===name);
  });
  if(name==='receipt')xferLoadReceiptList();
  if(name==='approval')xferLoadApprovalList();
}
function openTransfers(){
  show('transferScreen');
  document.getElementById('backBtn').style.display='block';
  greyTiles('transfer');
  xferRenderItems();
  setTimeout(function(){_initXferSigCanvas('xferDispatchSig','dispatch');},50);
  xferShowTab('new');
}
```

- [ ] **Step 5: Commit dispatch**

```javascript
function xferCommitDispatch(){
  var from=document.getElementById('xferFromBranch').value, to=document.getElementById('xferToBranch').value;
  if(from===to){toast('From and To branch must differ',true);return;}
  if(!_xferSig.dispatch){toast('Dispatch operator must sign first',true);return;}
  var items=[];
  ALLSIZES.forEach(function(sz){
    var qty=num(document.getElementById('xfq-'+sz).value);
    if(qty>0){
      items.push({size:sz,brand:document.getElementById('xfb-'+sz).value,state:document.getElementById('xfs-'+sz).value,
        qtyDispatched:qty,qtyReceived:null,shortfallReason:'',note:''});
    }
  });
  if(!items.length){toast('Add at least one line with a quantity',true);return;}
  var note=document.getElementById('xferNote').value||'';
  _pushTransferDispatch(items,from,to,note).then(function(row){
    if(!row){toast('Could not reach the server — queued, will retry at next login',true);return;}
    toast('Transfer dispatched — '+to+' will see it under Awaiting Receipt');
    auditLog('Stock Transfer dispatched',from+' → '+to+' — '+items.length+' line(s)');
    document.getElementById('xferNote').value='';
    _xferSigClear('xferDispatchSig','dispatch');
    xferRenderItems();
  });
}
```

- [ ] **Step 6: Syntax check + browser verification**

Run the same `node --check` command as Task 3 Step 3. Then start the preview (`preview_start` with the `lpg-gas-app` config), stub `sb.from('stock_transfers')`/`apiPost` to just resolve `{ok:true}`/`{data:[{id:'t1',row_id:'xfer_test'}],error:null}`, log in as a test Owner-role profile (or just set `role='Owner'` and call `openTransfers()` directly after setting `operator`/`currentProfile`), confirm the tile shows, the screen opens, the item grid renders all `ALLSIZES`, and `xferCommitDispatch()` with one line + a drawn signature calls the stub and shows the success toast.

- [ ] **Step 7: Commit**

```bash
git add index.html
git commit -m "feat: Stock Transfer tile + New Transfer (dispatch) screen

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: index.html — Awaiting Receipt tab

**Files:**
- Modify: `index.html`

- [ ] **Step 1: List + per-transfer receipt form**

```javascript
function xferLoadReceiptList(){
  var el=document.getElementById('xferReceiptList');
  el.innerHTML='Loading…';
  _fetchTransfersAwaitingReceipt(branch).then(function(rows){
    if(!rows.length){el.innerHTML='<p style="color:#999">Nothing awaiting receipt for '+branch+'.</p>';return;}
    el.innerHTML=rows.map(function(t){
      var itemsHtml=t.items.map(function(it,i){
        return '<div style="display:flex;gap:6px;align-items:center;margin-bottom:4px">'+
          '<span style="width:140px;font-size:12px">'+it.size+' · '+it.brand+' · '+it.state+'</span>'+
          '<span style="width:90px;font-size:12px">Dispatched: '+it.qtyDispatched+'</span>'+
          '<input id="xfr-'+t.id+'-'+i+'" type="number" min="0" value="'+it.qtyDispatched+'" style="width:70px"> received'+
          '</div>';
      }).join('');
      return '<div class="histSection" style="border:1.5px solid var(--steel);border-radius:10px;padding:10px;margin-bottom:10px">'+
        '<b>From '+t.from_branch+'</b> — dispatched by '+t.dispatch_operator_name_snapshot+' ('+_tsHM(t.dispatch_at)+')'+
        (t.note?('<div style="font-size:12px;color:#777">'+t.note+'</div>'):'')+
        '<div style="margin:8px 0">'+itemsHtml+'</div>'+
        '<label>Shortfall reason (if any quantity above differs from dispatched)</label>'+
        '<input id="xfr-'+t.id+'-reason" style="width:100%">'+
        '<label>Receiving operator signature</label>'+
        '<canvas id="xfrSig-'+t.id+'" width="600" height="150" style="border:1.5px solid var(--steel);border-radius:8px;width:100%;touch-action:none"></canvas>'+
        '<button class="sigClear" onclick="_xferSigClear(\'xfrSig-'+t.id+'\',\'receive\')">Clear signature</button>'+
        '<button onclick="xferCommitReceipt(\''+t.id+'\')">Confirm Receipt</button>'+
        '</div>';
    }).join('');
    rows.forEach(function(t){setTimeout(function(){_initXferSigCanvas('xfrSig-'+t.id,'receive');},50);});
    window._xferReceiptCache=rows;
  });
}
function xferCommitReceipt(id){
  if(!_xferSig.receive){toast('Receiving operator must sign first',true);return;}
  var t=(window._xferReceiptCache||[]).filter(function(r){return r.id===id;})[0];
  if(!t)return;
  var reason=document.getElementById('xfr-'+id+'-reason').value||'';
  var items=t.items.map(function(it,i){
    var qtyReceived=num(document.getElementById('xfr-'+id+'-'+i).value);
    var shortfallReason=(qtyReceived!==it.qtyDispatched)?reason:'';
    if(qtyReceived!==it.qtyDispatched && !reason){toast('Shortfall on '+it.size+' — a reason is required',true);throw new Error('missing shortfall reason');}
    return Object.assign({},it,{qtyReceived:qtyReceived,shortfallReason:shortfallReason});
  });
  _confirmTransferReceipt(id,items).then(function(ok){
    if(!ok){toast('Could not confirm receipt — try again',true);return;}
    toast('Receipt confirmed');
    auditLog('Stock Transfer received',t.from_branch+' → '+t.to_branch+' — '+items.length+' line(s)');
    _xferSigClear('xfrSig-'+id,'receive');
    xferLoadReceiptList();
  });
}
```

Note: `xferCommitReceipt`'s inline `throw` inside the `.map()` callback is a deliberate early-exit-with-toast for the first missing-reason line found; it's caught implicitly because the `throw` happens before `_confirmTransferReceipt` is ever called (the `.map()` itself throws synchronously, so the `.then(...)` chain below it never runs) — no separate try/catch needed, but note this in review since it's a slightly unusual control-flow shape for this codebase; a plain early-return before the `.map()` (validate first, then build `items`) is the safer, more conventional rewrite if this feels too clever during review.

- [ ] **Step 2: Syntax check, then browser-verify** (same technique as Task 4 Step 6, this time exercising `xferLoadReceiptList`/`xferCommitReceipt` against a stubbed `stock_transfers` row with one deliberately short-received line, confirming the shortfall-reason validation blocks commit until a reason is entered)

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: Stock Transfer Awaiting Receipt tab (shortfall-with-reason, receiving operator sig)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: index.html — Awaiting Approval tab

**Files:**
- Modify: `index.html`

- [ ] **Step 1: List + manager approval**

```javascript
function xferLoadApprovalList(){
  var el=document.getElementById('xferApprovalList');
  el.innerHTML='Loading…';
  _fetchTransfersAwaitingApproval().then(function(rows){
    if(!rows.length){el.innerHTML='<p style="color:#999">Nothing awaiting approval.</p>';return;}
    el.innerHTML=rows.map(function(t){
      var itemsHtml=t.items.map(function(it){
        var mismatch=(it.qtyReceived!==it.qtyDispatched);
        return '<div style="font-size:12px'+(mismatch?';color:#C0392B;font-weight:700':'')+'">'+
          it.size+' · '+it.brand+' · '+it.state+' — dispatched '+it.qtyDispatched+', received '+it.qtyReceived+
          (mismatch?(' — '+(it.shortfallReason||'no reason given')):'')+'</div>';
      }).join('');
      return '<div class="histSection" style="border:1.5px solid var(--steel);border-radius:10px;padding:10px;margin-bottom:10px">'+
        '<b>'+t.from_branch+' → '+t.to_branch+'</b><br>'+
        'Dispatched by '+t.dispatch_operator_name_snapshot+', received by '+t.receive_operator_name_snapshot+
        '<div style="margin:8px 0">'+itemsHtml+'</div>'+
        '<label>Manager/Owner signature</label>'+
        '<canvas id="xfaSig-'+t.id+'" width="600" height="150" style="border:1.5px solid var(--steel);border-radius:8px;width:100%;touch-action:none"></canvas>'+
        '<button class="sigClear" onclick="_xferSigClear(\'xfaSig-'+t.id+'\',\'approve\')">Clear signature</button>'+
        '<button onclick="xferCommitApproval(\''+t.id+'\',\''+(t.row_id||'')+'\')">Approve Transfer</button>'+
        '</div>';
    }).join('');
    rows.forEach(function(t){setTimeout(function(){_initXferSigCanvas('xfaSig-'+t.id,'approve');},50);});
  });
}
function xferCommitApproval(id,rowId){
  if(!perm('closeday')){toast('Manager/Owner authorisation required',true);return;}
  if(!_xferSig.approve){toast('Signature required',true);return;}
  _approveTransfer(id,rowId).then(function(ok){
    if(!ok){toast('Could not approve — try again',true);return;}
    toast('Transfer approved');
    auditLog('Stock Transfer approved','id '+id);
    _xferSigClear('xfaSig-'+id,'approve');
    xferLoadApprovalList();
  });
}
```

(`perm('closeday')` reused deliberately — it's already the app's existing "Manager or Owner" gate, same permission Close Day itself requires, rather than inventing a new permission key for this one action.)

- [ ] **Step 2: Syntax check, then browser-verify** the full three-stage cycle end to end: dispatch → receipt (with a shortfall) → approval, confirming each stage's stub call fires with the right payload shape and the UI reflects `status` correctly at each step.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: Stock Transfer Awaiting Approval tab (Manager/Owner sign-off closes the loop)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: Close Day gate — block on unapproved transfers

**Files:**
- Modify: `index.html:8290-8298` (right after the existing pending-Manifold-overrides gate in `closeDay()`, before the close-authorisation block)

- [ ] **Step 1: Add the gate**

`closeDay()` already re-fetches-then-recurses once for the pending-overrides check (the `_skipPendingOverridesRefresh` flag). Reuse that exact same one-shot-recursion-guard shape for this gate — add a second flag parameter and a second guarded block right after the existing one (after `index.html:8298`, before the `if(!store._closeAuth){` block):

```javascript
  // #4d BLOCK: any Branch Transfer that touched this branch today and isn't yet
  // 'approved' - same live-refetch-first reasoning as the pending-overrides gate just
  // above (Close Day is irreversible, so a stale local cache here could let a branch
  // close right past a transfer another device just dispatched/received).
  if(!_skipTransfersRefresh){
    _fetchUnapprovedTransfersTouching(branch,today).then(function(rows){closeDay(true,_dayActivitySummary,rows);},function(){closeDay(true,_dayActivitySummary,[]);});
    return;
  }
  if(_unapprovedTransfers&&_unapprovedTransfers.length){
    toast('Cannot close: '+_unapprovedTransfers.length+' Stock Transfer(s) touching '+branch+' today still need Manager/Owner approval — see the Stock Transfer screen.',true);
    return;
  }
```

- [ ] **Step 2: Update `closeDay()`'s signature and the two other call sites**

`closeDay()`'s signature changes from `function closeDay(_skipPendingOverridesRefresh,_dayActivitySummary){` to:
```javascript
function closeDay(_skipPendingOverridesRefresh,_dayActivitySummary,_unapprovedTransfers){
```
and add `var _skipTransfersRefresh=(_unapprovedTransfers!==undefined);` as the first line of the function body (mirrors how `_skipPendingOverridesRefresh` itself is used as both the skip-flag and a parameter — same convention, just one parameter later since `_unapprovedTransfers` needs to carry the fetched rows through the recursive call, not just a boolean).

Find `closeDay()`'s other call sites (the initial "Close Day" button's `onclick` and any other place that calls it with fewer than 3 arguments) via:
```powershell
Select-String -Path "C:\Users\Freddie Du Plessis\OneDrive\Desktop\LPG-Gas-App\index.html" -Pattern "closeDay\("
```
Every call site that isn't inside `closeDay()`'s own recursive calls should be left exactly as-is (calling with 0-2 arguments is fine — `_unapprovedTransfers` defaults to `undefined`, which correctly triggers the live re-fetch on the first pass, same as `_skipPendingOverridesRefresh` already does).

- [ ] **Step 3: Syntax check**

Same command as Task 3 Step 3.

- [ ] **Step 4: Browser-verify the gate**

In the preview, stub `_fetchUnapprovedTransfersTouching` to return one fake pending row, call `closeDay()` (with whatever local state already satisfies every earlier gate — easiest via the same stubbed-`store` technique used throughout this session), confirm it toasts the new message and does **not** proceed to the auth step. Then stub it to return `[]` and confirm `closeDay()` proceeds past this gate normally (into whichever gate comes next / the auth flow).

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat: Close Day blocks on any unapproved Branch Transfer touching that branch today

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: Full live-cycle verification against real Supabase + push

**Files:** none (verification only)

- [ ] **Step 1: Apply the migration to the real linked project** (already done in Task 1 Step 2 — confirm it's still applied: `supabase db query --linked -o json "select count(*) from stock_transfers;"` should return `0`, not an error).

- [ ] **Step 2: End-to-end browser test against the real (not stubbed) Supabase project**

Using the `lpg-gas-app` preview server and a real Owner login: dispatch a small test transfer (Helderberg → Kleinmond, 1 line, e.g. `1kg` — pick a size unlikely to collide with real stock, or clearly mark it `TEST` in the note), confirm the row appears in `stock_transfers` via `supabase db query --linked`, confirm the matching row appears on the `Transfers` Sheet tab with the right `RowId`. Confirm receipt (with a deliberate 1-unit shortfall) updates the same Supabase row and the same Sheet row (not a new one) — verify via:
```powershell
supabase db query --linked -o json "select status,items from stock_transfers where note ilike '%TEST%' order by dispatch_at desc limit 1;"
```
Confirm approval closes it out the same way. Confirm attempting Close Day on Helderberg (or Kleinmond) while this test transfer is anything but `approved` correctly blocks with the new toast.

- [ ] **Step 3: Clean up the test transfer**

```powershell
supabase db query --linked -o json "delete from stock_transfers where note ilike '%TEST%' returning id;"
```
And delete the corresponding test row(s) from the `Transfers` Sheet tab by hand (the generic writer has no delete action, same as every other tab — this is a manual one-off cleanup, not something to script).

- [ ] **Step 4: Push**

```bash
git push
```

- [ ] **Step 5: Report back**

Confirm to the user: migration applied, Apps Script deployed to v16, tile visible under Owner only, full dispatch→receipt→approval cycle verified against real Supabase + the real Sheet, Close Day gate verified blocking and un-blocking correctly, test data cleaned up.
