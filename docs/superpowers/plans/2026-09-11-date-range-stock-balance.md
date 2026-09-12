# Date-Range Stock Balance (Phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Management pick any date range (This Week / This Month / This Quarter / This Year / Custom) and get the same kind of stock balance the daily report already gives for one day — Opening → flows → Closing, Manifold Opening-vs-Closing, and any Verified Stock Take checkpoints inside that window — so drift that's invisible day-to-day (each day's small "acceptable" variance) becomes visible over a longer stretch.

**Architecture:** A new read-only aggregation layer over data that already exists and is already live (Phase 1's `verified_stock_takes`, Phase 2's `stock_transfers`, and the existing `stock_counts`/`manifold_live_rows`/`capture_live_rows` tables) — no new capture flow, no new role, no new signing, no RLS changes. One new Manager/Owner screen with a branch + date-range picker, built on a handful of **ranged** Supabase queries (not a day-by-day loop — see the deliberate refinement below) plus one new Apps Script read action for Faulty Cylinders, which has no live Supabase mirror and can only be queried through the Sheets proxy.

**Tech Stack:** Vanilla JS (single-file `index.html`), Supabase (Postgres, read-only for this phase), Google Apps Script (one new read-only action).

**Deliberate refinement of the spec:** the spec (`docs/superpowers/specs/2026-09-09-stock-balance-management-design.md`, Phase 3) describes the aggregator as "fetching each day's snapshot... and summing in the browser... just looped across more days." That's not what this plan does. `capture_live_rows`/`stock_transfers` both support `.gte('date',start).lte('date',end)` directly — a single ranged query returns every row in the window in one round trip, and the summing happens in JS over that one result set exactly the way the single-day report already sums one day's rows. Opening and Closing don't need a range at all — they're each a single point query (`stock_counts` Opening on the range's first day, Closing on its last day), the same query the single-day report already makes, just pointed at different dates. Net effect: this whole feature makes roughly 8 Supabase queries **regardless of how long the range is** (a week or a year cost the same), not N-days-worth of queries. This is strictly better than what the spec described and needed no scope trade-off to get — flagged here only so a reviewer doesn't go looking for a day-by-day loop that was deliberately not built.

**Depends on:** Phase 1 (Verified Stock Takes) and Phase 2 (Branch Transfers), both already merged to `main`.

**Rollout note:** the spec's real target audience for this screen is Manager + Owner. Same discipline as Phases 1 and 2: gated to `role==='Owner'` only for this build, opened to Manager in a small follow-up once proven live — not because Managers shouldn't have it, but because every prior phase this session shipped at least one real bug that only surfaced in review, and nothing here should reach a wider audience unverified.

## The Faulty Cylinders wrinkle (read this before Task 1)

Every other data source this plan reads is a live Supabase table with a `date` column, so a ranged query is trivial. **Faulty Cylinders is not** — it lives only in the Google Sheet's `Faulty` tab, reached through the Apps Script proxy, and the only existing read action (`faultyListOpen`) returns *currently* Faulty-Held cylinders with no date filter and no `Timestamp`/`DateClosed` fields in its response at all (confirmed by reading the live v17 script — see Task 1). That's the right question for the daily report ("what's faulty right now"); it's not answerable for a past date range. Task 1 adds one new Apps Script action that returns the fields a range actually needs, filtered server-side to the window, so this phase doesn't have to ship years of Faulty rows to the browser just to filter them client-side.

## File Structure

| File | Responsibility |
|---|---|
| the bound Apps Script (external, pasted by owner) | one new `faultyListRange` action, v18 (Task 1) |
| `index.html` — new block near `_fetchFaultyHeld`/`_fetchCaptureLiveRows` | range-aggregation data layer (Task 2) |
| `index.html` — new `rangeBalanceView` screen div + controller | branch/date-range picker + report render (Task 3) |
| `index.html` — same screen's render function | Verified checkpoint markers (Task 4) |
| `index.html` — tile markup, `_finishLogin` gate | tile + Owner-only rollout gate (Task 5) |

---

### Task 1: Apps Script — `faultyListRange` action (v18)

**Files:**
- Modify: the bound Apps Script (external — owner pastes the full updated file, same workflow as v15/v16/v17).

- [ ] **Step 1: Add the action**

In `doPost`, add a new branch (put it next to `faultyLog`/`faultyListOpen`/`faultyUpdate`'s existing `if(type==='faultyLog'||...)` block):

```javascript
// ===================== v18 NEW: FAULTY CYLINDERS - DATE-RANGE READ =====================
// faultyListOpen answers "what's faulty right now" (no date filter, no Timestamp/
// DateClosed in its response) - correct for the daily report, unanswerable for a past
// date range. This returns every Faulty row relevant to a [startDate,endDate] window,
// filtered server-side so the client never has to ship/filter years of rows:
//   - rows whose Timestamp falls inside the window (logged during the range), OR
//   - rows still Status='Faulty-Held' with Timestamp <= endDate (held as of the range's
//     end, regardless of when they were originally logged - mirrors what "Faulty
//     Cylinders" already means on the daily report, generalized to "as of range end"
//     instead of "right now").
// Read-only, no schema change, no migration.
if(type==='faultyListRange'){
  return _handleFaultyListRange(body);
}
// ===================== end v18 NEW =====================
```

- [ ] **Step 2: Add the handler**

Put this near `_handleFaulty` (same section of the file):

```javascript
// body: {branch, startDate, endDate}  (dates 'YYYY-MM-DD')
function _handleFaultyListRange(body){
  var sh=_faultySheet();
  var last=sh.getLastRow();
  if(last<2) return _json({ok:true, rows:[]});
  var vals=sh.getRange(2,1,last-1,FAULTY_HEADERS.length).getValues();
  var tz=Session.getScriptTimeZone();
  var start=body.startDate, end=body.endDate;
  var rows=vals.filter(function(row){
    if(String(row[2])!==String(body.branch)) return false; // Branch column
    var ts=row[1] instanceof Date ? Utilities.formatDate(row[1],tz,'yyyy-MM-dd') : String(row[1]||'').slice(0,10);
    var loggedInRange=(ts>=start && ts<=end);
    var status=row[16];
    var heldAsOfEnd=(status==='Faulty-Held' && ts<=end);
    return loggedInRange||heldAsOfEnd;
  }).map(function(row){
    var dateClosed=row[19];
    return {
      id:row[0],
      timestamp: row[1] instanceof Date ? Utilities.formatDate(row[1],tz,'yyyy-MM-dd') : String(row[1]||'').slice(0,10),
      Branch:row[2], Brand:row[4], Size:row[5], Qty:row[6], State:row[7],
      GasRemaining:row[13], Nominal:row[14], GasLoss:row[15], Status:row[16],
      dateClosed: dateClosed instanceof Date ? Utilities.formatDate(dateClosed,tz,'yyyy-MM-dd') : (dateClosed?String(dateClosed).slice(0,10):'')
    };
  });
  return _json({ok:true, rows:rows});
}
```

(Read the ACTUAL current `FAULTY_HEADERS` array and `_faultySheet()`/`_handleFaulty` in the live script first to confirm column indices — `FAULTY_HEADERS` is `['ID','Timestamp','Branch','Operator','Brand','Size','Qty','State','SealNumber','FaultReason','FaultDetail','CylScale','CylTare','GasRemaining','Nominal','GasLoss','Status','UpliftDN','ReturnDN','DateClosed','OperatorNote']` as of v17 — confirm this hasn't changed before trusting the column indices above.)

- [ ] **Step 3: Bump version, deploy**

`doGet` message → `'Gas Sales v18 endpoint live'`. Add a v18 changelog paragraph explaining the Faulty date-range read (same style as v15-v17's changelog entries). Deploy → Manage deployments → New version → Deploy. Confirm `/exec` returns `{"ok":true,"msg":"Gas Sales v18 endpoint live"}`.

- [ ] **Step 4: Spot-check against real data**

Once deployed, this can be exercised directly (no auth token needed for a manual check beyond the shared `SECRET` — POST `{token:'<SECRET>',type:'faultyListRange',branch:'Helderberg',startDate:'2026-09-01',endDate:'2026-09-30'}` to the `/exec` URL, e.g. via `Invoke-RestMethod` in PowerShell) against whatever real Faulty rows exist for Helderberg this month, and confirm the returned rows' `timestamp`/`dateClosed`/`Status` fields look right. This is optional at this stage (Task 6 does a full real-data pass) but cheap to do now while the script is fresh in the editor.

---

### Task 2: Range-aggregation data layer

**Files:**
- Modify: `index.html` — new self-contained block. Placement: near `_fetchFaultyHeld`/`_fetchCaptureLiveRows`/`_fetchManifoldLiveRows` (search `function _fetchCaptureLiveRows`).

- [ ] **Step 1: Add the ranged fetch helpers**

```javascript
// ===== Date-Range Stock Balance (Phase 3) - read-only aggregation over data Phases 1/2
// and the existing daily flow already write. No day-by-day loop: Opening/Closing are
// each one point query (same query the single-day report already makes, at different
// dates); every "summed across the range" figure is ONE ranged Supabase query
// (.gte('date',start).lte('date',end)), summed in JS over that one result set - the
// same shape the single-day report already sums one day's rows, just a wider window.
// Cost is flat regardless of range length (~8 queries whether the range is a week or a
// year), not proportional to the number of days picked.

// Opening: the Operator's own Opening count on the range's FIRST day. Point query,
// mirrors _refreshSharedCounts's shape.
function _fetchRangeOpeningCounts(br,startDate){
  return sb.from('stock_counts').select('*').eq('branch',br).eq('date',startDate).eq('count_type','Opening').then(function(res){
    if(res.error||!res.data)return [];
    return res.data;
  },function(){return [];});
}
// Closing: the Operator's own Closing count on the range's LAST day.
function _fetchRangeClosingCounts(br,endDate){
  return sb.from('stock_counts').select('*').eq('branch',br).eq('date',endDate).eq('count_type','Closing').then(function(res){
    if(res.error||!res.data)return [];
    return res.data;
  },function(){return [];});
}
// Received/Refill/Private summed across the whole range - ONE query per kind, not one
// per day. capture_live_rows.row is the same local-store-shaped object
// _fetchCaptureLiveRows already unwraps for a single day; this does the same unwrap
// for every row in the range at once.
function _fetchRangeCaptureLiveRows(kind,br,startDate,endDate){
  return sb.from('capture_live_rows').select('row,date').eq('kind',kind).eq('branch',br).gte('date',startDate).lte('date',endDate).then(function(res){
    if(res.error){console.error('_fetchRangeCaptureLiveRows('+kind+') failed:',res.error.message);return [];}
    return (res.data||[]).map(function(r){return r.row||{};});
  },function(){return [];});
}
// Manifold: latest reading per slot WITHIN each stage, at range start (Opening) and
// range end (Closing) - same latest-per-slot logic the single-day report's own
// Manifold Opening-vs-Closing table already uses, just pointed at two different dates
// instead of one.
function _fetchRangeManifold(br,startDate,endDate){
  return Promise.all([
    sb.from('manifold_live_rows').select('row').eq('branch',br).eq('date',startDate).then(function(res){return (res.data||[]).map(function(r){return r.row||{};});},function(){return [];}),
    sb.from('manifold_live_rows').select('row').eq('branch',br).eq('date',endDate).then(function(res){return (res.data||[]).map(function(r){return r.row||{};});},function(){return [];})
  ]).then(function(results){
    function latestPerSlot(rows,stage){
      var bySlot={};
      rows.filter(function(m){return (m.stage||'Opening')===stage;}).forEach(function(m){
        var cur=bySlot[m.cyl];
        if(!cur||(m._time||'')>(cur._time||''))bySlot[m.cyl]=m;
      });
      return Object.keys(bySlot).sort().map(function(k){return bySlot[k];});
    }
    return {opening:latestPerSlot(results[0],'Opening'), closing:latestPerSlot(results[1],'Closing')};
  });
}
// Transfers touching this branch, approved, dispatched within the range. Split
// in/out by which side of the transfer this branch was on. Uses dispatch_at (when
// the stock physically moved), not approved_at (when the paperwork caught up).
function _fetchRangeTransfers(br,startDate,endDate){
  return sb.from('stock_transfers').select('from_branch,to_branch,items,dispatch_at')
    .or('from_branch.eq.'+br+',to_branch.eq.'+br)
    .eq('status','approved')
    .gte('dispatch_at',startDate+'T00:00:00').lte('dispatch_at',endDate+'T23:59:59')
    .then(function(res){
      if(res.error){console.error('_fetchRangeTransfers failed:',res.error.message);return {inBySize:{},outBySize:{}};}
      var inBySize={},outBySize={};
      (res.data||[]).forEach(function(t){
        var target=(t.to_branch===br)?inBySize:(t.from_branch===br?outBySize:null);
        if(!target)return;
        (t.items||[]).forEach(function(it){
          var qty=(it.qtyReceived!=null)?it.qtyReceived:it.qtyDispatched; // prefer confirmed-received qty when known
          target[it.size]=(target[it.size]||0)+num(qty);
        });
      });
      return {inBySize:inBySize,outBySize:outBySize};
    },function(){return {inBySize:{},outBySize:{}};});
}
// Faulty: needs the new v18 Apps Script action, since Faulty has no live Supabase
// mirror at all (Sheet-only). Returns {loggedInRangeCount, gasLossBookedInRange,
// heldAsOfEndCount, heldAsOfEndGasRemaining} - the two figures the balance formula
// and the "on hand at range end" figure respectively need.
function _fetchRangeFaulty(br,startDate,endDate){
  return apiPost('faultyListRange',{branch:br,startDate:startDate,endDate:endDate}).then(function(res){
    if(!res||!res.ok)return {loggedInRangeCount:0,gasLossBookedInRange:0,heldAsOfEndCount:0,heldAsOfEndGasRemaining:0};
    var loggedInRangeCount=0,gasLossBookedInRange=0,heldAsOfEndCount=0,heldAsOfEndGasRemaining=0;
    (res.rows||[]).forEach(function(r){
      if(r.timestamp>=startDate&&r.timestamp<=endDate)loggedInRangeCount+=num(r.Qty)||1;
      if(r.Status==='Not Replaced'&&r.dateClosed&&r.dateClosed>=startDate&&r.dateClosed<=endDate)gasLossBookedInRange+=num(r.GasLoss);
      if(r.Status==='Faulty-Held'){heldAsOfEndCount+=num(r.Qty)||1;heldAsOfEndGasRemaining+=num(r.GasRemaining);}
    });
    return {loggedInRangeCount:loggedInRangeCount,gasLossBookedInRange:gasLossBookedInRange,heldAsOfEndCount:heldAsOfEndCount,heldAsOfEndGasRemaining:heldAsOfEndGasRemaining};
  },function(){return {loggedInRangeCount:0,gasLossBookedInRange:0,heldAsOfEndCount:0,heldAsOfEndGasRemaining:0};});
}
```

- [ ] **Step 2: Add the aggregator that ties it all together**

```javascript
// Runs every fetch above in parallel and reduces to the range balance shape the
// report (Task 3) renders. sizeTotals(rows,'fullIn') etc. mirror the exact reduction
// _receivedFromStore/the single-day report already do per-day, just over the wider
// row set this range query returned in one shot.
function sumBySize(rows,field){
  var out={};
  rows.forEach(function(r){ if(r.size)out[r.size]=(out[r.size]||0)+num(r[field]); });
  return out;
}
function totalOfSizeMap(m){return Object.keys(m).reduce(function(s,k){return s+m[k];},0);}
function fetchRangeStockBalance(br,startDate,endDate){
  return Promise.all([
    _fetchRangeOpeningCounts(br,startDate),
    _fetchRangeClosingCounts(br,endDate),
    _fetchRangeCaptureLiveRows('received',br,startDate,endDate),
    _fetchRangeCaptureLiveRows('refill',br,startDate,endDate),
    _fetchRangeCaptureLiveRows('private',br,startDate,endDate),
    _fetchRangeManifold(br,startDate,endDate),
    _fetchRangeTransfers(br,startDate,endDate),
    _fetchRangeFaulty(br,startDate,endDate)
  ]).then(function(r){
    var openingRows=r[0], closingRows=r[1], receivedRows=r[2], refillRows=r[3], privateRows=r[4],
        manifold=r[5], transfers=r[6], faulty=r[7];

    var openingFullBySize={}, openingEmptyBySize={}, closingFullBySize={}, closingEmptyBySize={};
    openingRows.forEach(function(c){var t=(c.state==='Empty')?openingEmptyBySize:openingFullBySize; t[c.size]=(t[c.size]||0)+num(c.qty);});
    closingRows.forEach(function(c){var t=(c.state==='Empty')?closingEmptyBySize:closingFullBySize; t[c.size]=(t[c.size]||0)+num(c.qty);});

    var receivedFullIn=sumBySize(receivedRows,'fullIn');
    var receivedEmptyOut=sumBySize(receivedRows,'emptyOut');
    var refilledCount=refillRows.length, refilledKg=refillRows.reduce(function(s,r){return s+num(r.pumped);},0);
    var privateKg=privateRows.reduce(function(s,r){return s+num(r.pumped);},0);
    var privateUsKg=privateRows.filter(function(r){return r.filledBy!=='Supplier';}).reduce(function(s,r){return s+num(r.pumped);},0);

    var manOpeningKg=manifold.opening.reduce(function(s,m){return s+num(m.gasLeft);},0);
    var manClosingKg=manifold.closing.reduce(function(s,m){return s+num(m.gasLeft);},0);

    // Estimated Sold, per the spec's formula: Opening + Received + Refilled + Transfers In
    // - Transfers Out - Faulty(logged in range) = ... vs Closing. Computed per-size then
    // summed, same shape the single-day report's "Estimated Stock Sales" section uses.
    var allSizes=ALLSIZES;
    var estSoldBySize={}, estSoldTotal=0;
    allSizes.forEach(function(sz){
      var openF=openingFullBySize[sz]||0, closeF=closingFullBySize[sz]||0;
      var recvIn=receivedFullIn[sz]||0, tIn=transfers.inBySize[sz]||0, tOut=transfers.outBySize[sz]||0;
      var sold=openF+recvIn+tIn-tOut-closeF; // faulty is a total-only figure (no size breakdown from the Sheet), applied below
      estSoldBySize[sz]=sold; estSoldTotal+=sold;
    });
    estSoldTotal-=faulty.loggedInRangeCount;

    return {
      branch:br, startDate:startDate, endDate:endDate,
      opening:{full:openingFullBySize,empty:openingEmptyBySize,fullTotal:totalOfSizeMap(openingFullBySize),emptyTotal:totalOfSizeMap(openingEmptyBySize),hasData:openingRows.length>0},
      closing:{full:closingFullBySize,empty:closingEmptyBySize,fullTotal:totalOfSizeMap(closingFullBySize),emptyTotal:totalOfSizeMap(closingEmptyBySize),hasData:closingRows.length>0},
      received:{fullIn:receivedFullIn,emptyOut:receivedEmptyOut,fullInTotal:totalOfSizeMap(receivedFullIn),emptyOutTotal:totalOfSizeMap(receivedEmptyOut)},
      refilled:{count:refilledCount,kg:refilledKg},
      private:{kg:privateKg,usKg:privateUsKg},
      transfers:{inBySize:transfers.inBySize,outBySize:transfers.outBySize,inTotal:totalOfSizeMap(transfers.inBySize),outTotal:totalOfSizeMap(transfers.outBySize)},
      manifold:{openingKg:manOpeningKg,closingKg:manClosingKg,diffKg:manOpeningKg-manClosingKg,hasOpening:manifold.opening.length>0,hasClosing:manifold.closing.length>0},
      faulty:faulty,
      estSold:{bySize:estSoldBySize,total:estSoldTotal}
    };
  });
}
```

- [ ] **Step 3: Syntax check + commit**

Syntax check (same `node --check`-on-largest-`<script>`-block command every prior task used). Then:
```bash
git add index.html
git commit -m "feat: Date-Range Stock Balance aggregation layer (ranged queries, no day-by-day loop)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Browser verification**

Serve the worktree, stub `sb`/`apiPost` with a small synthetic dataset spanning 3 fake "days" (a few Opening rows dated `startDate`, a few Closing rows dated `endDate`, a couple of `received`/`refill`/`private` rows scattered across the range, one manifold row per stage/date, one approved transfer with `dispatch_at` inside the range, one faulty row with `timestamp` inside the range). Call `fetchRangeStockBalance(...)` directly and confirm every field in the returned object matches hand-computed expectations from the synthetic data — especially: `estSold.total` matches a hand calculation, `transfers.inTotal`/`outTotal` only count the transfer once (in on the receiving branch's call, out on the sending branch's call — test with the SAME branch as both `from` and `to` isn't possible since `from!==to` is enforced elsewhere, but confirm a transfer FROM the test branch shows up in `outBySize` and one TO it shows up in `inBySize`, not both), `faulty.loggedInRangeCount` vs `heldAsOfEndCount` are computed from the right condition (don't confuse "logged in range" with "held at range end" - a cylinder could be one, the other, both, or neither).

---

### Task 3: Screen shell — branch/date-range picker + report render

**Files:**
- Modify: `index.html` — new `<div id="rangeBalanceView" class="view">` (with the other screen divs — **remember the CSS allow-list entry, Task 3 Step 4 below, every single prior phase this session needed it**). New JS controller after Task 2's aggregator.

- [ ] **Step 1: Add the screen markup**

```html
<div id="rangeBalanceView" class="view">
  <div class="wrap">
    <label>Branch</label>
    <select id="rbBranch" onchange="rbLoad()"><option>Helderberg</option><option>Kleinmond</option></select>
    <div class="histTabs">
      <button class="htab" onclick="rbSetPreset('week')">This Week</button>
      <button class="htab" onclick="rbSetPreset('month')">This Month</button>
      <button class="htab" onclick="rbSetPreset('quarter')">This Quarter</button>
      <button class="htab" onclick="rbSetPreset('year')">This Year</button>
    </div>
    <label>From</label>
    <input id="rbStart" type="date" onchange="rbLoad()">
    <label>To</label>
    <input id="rbEnd" type="date" onchange="rbLoad()">
    <div id="rbReport"></div>
  </div>
</div>
```

- [ ] **Step 2: Add the preset/date-range helpers + open function**

```javascript
function rbSetPreset(kind){
  var end=new Date(); var start=new Date();
  if(kind==='week'){ start.setDate(end.getDate()-((end.getDay()+6)%7)); } // Monday this week
  else if(kind==='month'){ start=new Date(end.getFullYear(),end.getMonth(),1); }
  else if(kind==='quarter'){ start=new Date(end.getFullYear(),Math.floor(end.getMonth()/3)*3,1); }
  else if(kind==='year'){ start=new Date(end.getFullYear(),0,1); }
  function iso(d){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
  document.getElementById('rbStart').value=iso(start);
  document.getElementById('rbEnd').value=iso(end);
  rbLoad();
}
function openRangeBalance(){
  if(role!=='Owner'){toast('Owner only',true);return;} // rollout gate - flip to Manager+Owner once verified live
  show('rangeBalanceView');
  document.getElementById('backBtn').style.display='block';
  document.getElementById('hTitle').textContent='Stock Balance';
  document.getElementById('hSub').textContent='Any date range';
  document.getElementById('rbBranch').value=(branch||'Helderberg');
  rbSetPreset('month'); // also calls rbLoad()
}
```

- [ ] **Step 3: Add `rbLoad` + the render function**

```javascript
var _rbLoadToken=0;
function rbLoad(){
  var br=document.getElementById('rbBranch').value;
  var start=document.getElementById('rbStart').value, end=document.getElementById('rbEnd').value;
  if(!start||!end){return;}
  if(start>end){toast('From date must be before To date',true);return;}
  var myToken=++_rbLoadToken; // last-request-wins guard against a slow earlier fetch clobbering a newer one
  document.getElementById('rbReport').innerHTML='Loading…';
  fetchRangeStockBalance(br,start,end).then(function(bal){
    if(myToken!==_rbLoadToken)return; // a newer rbLoad() call already superseded this one
    document.getElementById('rbReport').innerHTML=rbRenderReport(bal);
  });
}
function rbRenderReport(bal){
  function kg(n){return (n||0).toFixed(2)+' kg';}
  var html='';
  html+='<div class="callout">Opening ('+bal.startDate+'): <b>'+bal.opening.fullTotal+'</b> full, <b>'+bal.opening.emptyTotal+'</b> empty'+(bal.opening.hasData?'':' <span style="color:#B9761F">— no Opening count found for this date</span>')+'</div>';
  html+='<div class="callout">Closing ('+bal.endDate+'): <b>'+bal.closing.fullTotal+'</b> full, <b>'+bal.closing.emptyTotal+'</b> empty'+(bal.closing.hasData?'':' <span style="color:#B9761F">— no Closing count found for this date</span>')+'</div>';
  html+='<div class="callout">Received: <b>'+bal.received.fullInTotal+'</b> full in, <b>'+bal.received.emptyOutTotal+'</b> empty out</div>';
  html+='<div class="callout">Refilled: <b>'+bal.refilled.count+'</b> cylinder(s), '+kg(bal.refilled.kg)+'</div>';
  html+='<div class="callout">Private Refill: '+kg(bal.private.kg)+' ('+kg(bal.private.usKg)+' by us)</div>';
  html+='<div class="callout">Transfers: <b>'+bal.transfers.inTotal+'</b> in, <b>'+bal.transfers.outTotal+'</b> out</div>';
  html+='<div class="callout">Faulty: <b>'+bal.faulty.loggedInRangeCount+'</b> logged this range, '+kg(bal.faulty.gasLossBookedInRange)+' booked loss, <b>'+bal.faulty.heldAsOfEndCount+'</b> still held as of '+bal.endDate+'</div>';
  html+='<h2>Manifold</h2><table><tr><th></th><th>kg</th></tr>'+
    '<tr><td>Opening ('+bal.startDate+')</td><td class="n">'+(bal.manifold.hasOpening?kg(bal.manifold.openingKg):'—')+'</td></tr>'+
    '<tr><td>Closing ('+bal.endDate+')</td><td class="n">'+(bal.manifold.hasClosing?kg(bal.manifold.closingKg):'—')+'</td></tr>'+
    '<tr><td><b>Diff</b></td><td class="n"><b>'+((bal.manifold.hasOpening&&bal.manifold.hasClosing)?kg(bal.manifold.diffKg):'—')+'</b></td></tr></table>';
  html+='<div class="callout" style="font-weight:800">Estimated sold this range: '+bal.estSold.total+' cylinder(s)</div>';
  return html;
}
```

- [ ] **Step 4: Add the CSS view allow-list entry**

Add `body[data-view="rangeBalanceView"] #rangeBalanceView` to the comma-separated allow-list near the top of the file (~line 100). **Every single phase this session forgot this at least once and shipped a blank screen until caught in review — do this now, as its own step, and verify it live in Step 5, don't skip straight to "looks right."**

- [ ] **Step 5: Syntax check + browser verification + commit**

Syntax check. Then serve, stub the Task 2 fetchers to resolve instantly with a small synthetic `fetchRangeStockBalance`-shaped object, set `role='Owner'`, call `openRangeBalance()`, and confirm — with real values:
- `getComputedStyle(document.getElementById('rangeBalanceView')).display` is `'block'`, not `'none'`
- `rbSetPreset('month')` sets `#rbStart`/`#rbEnd` to the 1st of the current month and today
- changing `#rbStart` or `#rbEnd` triggers a reload (`rbLoad` fires)
- `#rbReport` contains the rendered figures matching the stub data
- rapidly calling `rbLoad()` twice in a row with different stub delays (simulate a slow first fetch, fast second) — confirm the FIRST (slower) response does NOT overwrite the SECOND (faster, more recent) one once both resolve, i.e. the `_rbLoadToken` guard actually works
- `role='Operator'` → `openRangeBalance()` → "Owner only" toast, no navigation

Commit:
```bash
git add index.html
git commit -m "feat: Date-Range Stock Balance screen (branch/date-range picker, presets, report render)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Verified checkpoints inline

**Files:**
- Modify: `index.html` — extends `rbRenderReport`/`rbLoad` (Task 3).

- [ ] **Step 1: Fetch verified takes inside the range**

Add near the Task 2 aggregator (or directly in the Task 3 controller block — either is fine, keep it near whichever it reads most naturally alongside):

```javascript
function _fetchVerifiedTakesInRange(br,startDate,endDate){
  return sb.from('verified_stock_takes').select('*').eq('branch',br).gte('date',startDate).lte('date',endDate).order('date').then(function(res){
    if(res.error)return [];
    return res.data||[];
  },function(){return [];});
}
```

- [ ] **Step 2: Wire it into `rbLoad` and render markers**

In `rbLoad`, fetch this alongside `fetchRangeStockBalance` (`Promise.all([fetchRangeStockBalance(...), _fetchVerifiedTakesInRange(...)])`), and for each take found, reuse Task 4 of the Verified Stock Takes plan's own `_fetchVerifiedTakeComparison(br,take.date,take.count)` (already built and live from Phase 1 — don't re-derive this math) to get that checkpoint's diff-vs-Closing-that-day, then render a marker per take:

```javascript
function rbRenderCheckpoints(takes,comparisons){
  if(!takes.length)return '';
  var html='<h2>Verified checkpoints in this range</h2>';
  takes.forEach(function(t,i){
    var cmp=comparisons[i];
    var summary=!cmp||!cmp.hasClosing ? 'no Closing count that day to compare against'
      : (!cmp.lines.length ? 'matched Closing exactly' : cmp.lines.length+' size(s) differed from Closing');
    html+='<div class="histSection" style="border:1.5px solid var(--steel);border-radius:10px;padding:8px;margin-bottom:8px">'+
      '<b>'+t.date+'</b> — '+t.mode+' take by '+t.auditor_name_snapshot+(t.operator_name_snapshot?(' + '+t.operator_name_snapshot):'')+
      '<div style="font-size:12px;color:#777">'+summary+'</div></div>';
  });
  return html;
}
```

Update `rbLoad` to fetch both, then append `rbRenderCheckpoints(...)`'s output to `#rbReport`'s innerHTML after the existing report body.

- [ ] **Step 3: Syntax check + browser verification + commit**

Serve, stub `verified_stock_takes` to return 2 fake takes inside the picked range (one solo, one joint) plus a stubbed `_fetchVerifiedTakeComparison`, call `rbLoad()`, confirm both checkpoints render with the right date/mode/names and the right summary line (test both a "matched exactly" case and a "N sizes differed" case). Confirm a take OUTSIDE the picked range does NOT appear (adjust the date range and reload).

```bash
git add index.html
git commit -m "feat: Date-Range Stock Balance shows Verified Stock Take checkpoints inline

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Tile + rollout gate

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Add the Home tile**

After whichever tile is currently last in the `tileAdmin`-adjacent run (by now that's `tileTransfer` then `tileVerifiedTake`, both merged from Phases 1/2 — read the actual current markup and append after the true last one):
```html
<button class="tile t3" data-key="rangeBalance" id="tileRangeBalance" onclick="openRangeBalance()" style="display:none"><div class="ic">&#128202;</div><h3>Stock Balance</h3><p>Owner: balance stock over any date range</p></button>
```

- [ ] **Step 2: Tile visibility (Owner-only rollout gate)**

In `_finishLogin`'s tile-visibility run, after the `tileVerifiedTake`/`_tvt` line:
```javascript
// rollout gate — flip to (role==='Manager'||role==='Owner') once verified live, per the spec's real intended audience.
var _trb=document.getElementById('tileRangeBalance');if(_trb)_trb.style.display=(role==='Owner')?'flex':'none';
```

- [ ] **Step 3: Confirm no section-restore entry**

Verification-only, same as every prior phase: confirm `openRangeBalance()` doesn't call `_saveCurrentSection(...)` and `_restoreCurrentSection()` has no `rangeBalance` case. If either exists, STOP and escalate rather than fix silently.

- [ ] **Step 4: Syntax check + browser verification + commit**

Serve, verify `role='Owner'` → tile `flex` and opens the screen; `role='Manager'`/`'Operator'`/`'Auditor'` → tile `'none'` for all three. Confirm Step 3's findings.

```bash
git add index.html
git commit -m "feat: Stock Balance tile + Owner-only rollout gate (no section-restore entry)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Real-data verification + push

**Files:** none (verification only)

- [ ] **Step 1: Confirm the Apps Script v18 action is live**

Once the owner has pasted and deployed it (Task 1) — POST a real `faultyListRange` request for a branch/date-range known to have at least one Faulty row (Helderberg, a range covering a known faulty cylinder logged earlier this project) and confirm the response shape matches what `_fetchRangeFaulty` expects.

- [ ] **Step 2: Real-Supabase range test**

Using `supabase db query --linked`, independently compute (by hand, via SQL) what `fetchRangeStockBalance` SHOULD return for a real branch + a range covering real data already in the linked project (e.g. Helderberg, `2026-09-09` to whatever today's date is by the time this task runs — there's real Opening/Closing/Received/Refill/Private/Manifold/Transfer/Verified-Take data from this session's earlier work to check against):
- `select count_type,size,sum(qty::numeric) from stock_counts where branch='Helderberg' and date='<range start>' and count_type='Opening' group by count_type,size;` and the equivalent for Closing on the range end date.
- Sum `capture_live_rows` rows in the range for `kind in ('received','refill','private')` and compare against what the app's own aggregator produces via a browser test against the REAL (not stubbed) Supabase project.
- Confirm `stock_transfers` with `status='approved'` and `dispatch_at` in the range are correctly split in/out.
- Confirm any real `verified_stock_takes` in the range show up as checkpoints.

Then run the actual app (served locally, logged in as a real Owner, real Supabase) and confirm `openRangeBalance()`'s rendered numbers match the by-hand SQL totals.

- [ ] **Step 3: Push + finish the branch**

```bash
git push -u origin <branch>
```
Then use `superpowers:finishing-a-development-branch` (push + PR, matching Phases 1/2).

---

## Self-Review

- [x] **Spec coverage:** any date range via presets + custom (Task 3) ✓; Opening→flows→Closing balance (Task 2) ✓; Manifold Opening-vs-Closing-vs-Diff over the range (Task 2/3) ✓; Verified checkpoints shown inline (Task 4) ✓; Transfers correctly excluded from being mistaken for sales (Task 2's `estSold` formula nets transfers separately from Received) ✓; Owner-only rollout gate + no section-restore (Task 5) ✓; flat query cost regardless of range length (explicitly called out as a refinement over the spec's day-by-day description) ✓.
- [x] **Placeholder scan:** no TBD/TODO; every code step has complete code.
- [x] **Type consistency:** `fetchRangeStockBalance`'s returned shape (`opening/closing/received/refilled/private/transfers/manifold/faulty/estSold`) is used identically by `rbRenderReport` (Task 3) and unaffected by Task 4's addition (checkpoints are fetched and rendered separately, appended after). `_fetchRangeFaulty`'s returned keys (`loggedInRangeCount`/`gasLossBookedInRange`/`heldAsOfEndCount`/`heldAsOfEndGasRemaining`) match what `fetchRangeStockBalance` reads and what `rbRenderReport` displays.
- [x] **Known scope boundary, stated explicitly:** `estSold`'s per-size breakdown does NOT subtract Faulty per-size (the Sheet gives no per-size Faulty breakdown, only a range-wide count/gas-loss) — only the range-wide total is Faulty-adjusted. This mirrors a real limitation of the underlying data (Faulty has no live per-size Supabase source), not an oversight; flagged in Task 2's own code comment so a reviewer doesn't need to rediscover it.

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-09-11-date-range-stock-balance.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, two-stage review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session with checkpoints for review.

Which approach?
