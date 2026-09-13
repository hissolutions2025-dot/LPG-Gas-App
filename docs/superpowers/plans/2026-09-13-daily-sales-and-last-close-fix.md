# Daily Sales/Returns + Last-Actual-Close Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two independent fixes to the LPG-Gas-App stock balancing system:
1. **Daily Sales/Returns** — a new Manager/Owner capture screen turning "Estimated Sold" from an inferred mass-balance guess into real, captured data (per-size Sold/Returned/Diff, plus in-house Private Refill kg), replacing the inference wherever it's shown once real data exists for that day.
2. **Last-actual-close fix** — every "compare against yesterday" mechanism in this app (blind Opening-count mismatch, Manifold's carry-forward baseline, the report's own prev-close comparison, and the mismatch-correction hand-off) currently looks at literally `today - 1 day`. On a day following a non-working day (Sunday, a holiday), no close exists for that literal date, so the comparison silently finds nothing instead of correctly reaching back to the last day the branch actually closed.

**Architecture:** Sales/Returns is a new table (`daily_sales`, one row per branch+date, jsonb per-size lines, upsert-on-resubmit) and a new screen modeled on Stock Transfer's simple per-size grid (not its multi-stage dispatch/receipt/approval workflow, which doesn't apply here). The single-day report and Date-Range Stock Balance both gain a "check for real data first, fall back to the existing inference" step. The last-close fix is a single new query helper (`_lastCloseDate`, `.lt('date',beforeDate).order('date',{ascending:false}).limit(1)`) replacing `_dayBefore(x)` + an exact-date lookup at every one of its 6 existing call sites.

**Tech Stack:** Vanilla JS (`index.html`), Supabase (Postgres + RLS).

**Depends on:** nothing new — reuses `day_closes` (already live), Private Refill's existing `filledBy` field, and the existing single-day report / Date-Range Stock Balance code.

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/<timestamp>_daily_sales.sql` | new table + RLS |
| `index.html` — near `_dayBefore` | new `_lastCloseDate(br,beforeDate)` helper |
| `index.html` — 6 existing call sites | switched from `_dayBefore`+exact-date to `_lastCloseDate` |
| `index.html` — new screen block | Daily Sales capture (tile, gate, grid, commit) |
| `index.html` — `buildCountDocAsync` (both HTML and CSV/plain-export branches) | real-data override for "Estimated Stock Sales & Cylinder Exchange" |
| `index.html` — `fetchRangeStockBalance`/`rbRenderReport` | real-data override for `estSold` |

---

### Task 1: `_lastCloseDate` helper + rewire the 6 existing call sites

**Files:**
- Modify: `index.html` — `_dayBefore` (search `function _dayBefore`), and every call site listed below.

- [ ] **Step 1: Add the helper**

Place it right after `_dayBefore` (search `function _dayBefore(dateStr)`):

```javascript
// Returns the most recent date (strictly before `beforeDate`) that `br` actually closed, or
// null if none exists. Replaces the naive "always literally yesterday" pattern every
// prev-close comparison in this file used to follow (_dayBefore(x) + an exact-date lookup) -
// on a day following a non-working day (Sunday, a holiday - no Close Day happened), that
// naive pattern silently found nothing and every blind-mismatch/baseline/report comparison
// just didn't fire, instead of correctly reaching back to the last real close (e.g. Saturday).
function _lastCloseDate(br,beforeDate){
  return sb.from('day_closes').select('date').eq('branch',br).lt('date',beforeDate)
    .order('date',{ascending:false}).limit(1).then(function(res){
      if(res.error||!res.data||!res.data.length)return null;
      return res.data[0].date;
    },function(){return null;});
}
```

- [ ] **Step 2: Rewire each call site**

Every one of these currently does `try{yDate=_dayBefore(X);}catch(e){...}` then a separate `sb.from('day_closes')...eq('date',yDate)` fetch. Change each to first resolve `_lastCloseDate(br, X)`, then fetch using whatever date comes back (skip the fetch entirely if it's `null` - same "no prior close" outcome as today, just reached correctly instead of via a literal-yesterday miss).

Re-read the ACTUAL current code at each site before editing (this plan's line numbers will have drifted) - search for these function names:

1. `_fetchManifoldPrevClose(br)` (~line 2094) - Manifold's own baseline carry-forward.
2. `_fetchLiveExpectedOpening(br)` (~line 4803) - Count's blind Opening-mismatch check.
3. Whatever function contains the call at `try{yDate=_dayBefore(myToday);}catch(e){}` (~line 5992) - read its surrounding context to identify and understand what it's for before changing it.
4. The mismatch-resolution "jump to correct that record" hand-off (~line 10660, inside a block starting `if(accepted){`) - this one is special: it must reach the SAME date the mismatch comparison actually used, not independently recompute it. If Steps 3's function already resolved and could expose the actual comparison date it used (e.g. by stashing it on the mismatch object itself, or another accessible place), reuse that value here rather than calling `_lastCloseDate` a second time - use your judgment on the cleanest way to guarantee these two never disagree, but they MUST end up pointing at the same date.
5. `_fetchPrevCloseExpected(br,date)` (~line 11156) - the report's own prev-close comparison (used by `buildCountDocAsync`, two call sites).

For each, apply the same shape as the example below (adapted to that function's own existing structure/comments - don't blindly copy this verbatim if the surrounding code differs, but the query pattern change is the same everywhere):

```javascript
// BEFORE (example - _fetchPrevCloseExpected):
function _fetchPrevCloseExpected(br,date){
  var yDate;
  try{yDate=_dayBefore(date);}catch(e){return Promise.resolve({});}
  return sb.from('day_closes').select('store_snapshot').eq('branch',br).eq('date',yDate).maybeSingle().then(function(res){
    ...
  },function(){return {};});
}

// AFTER:
function _fetchPrevCloseExpected(br,date){
  return _lastCloseDate(br,date).then(function(yDate){
    if(!yDate)return {};
    return sb.from('day_closes').select('store_snapshot').eq('branch',br).eq('date',yDate).maybeSingle().then(function(res){
      ...same body as before...
    },function(){return {};});
  });
}
```

- [ ] **Step 3: Syntax check**

Extract the largest `<script>` block, run `node --check`.

- [ ] **Step 4: Real-data verification**

Using `supabase db query --linked`, confirm real `day_closes` rows exist with at least one genuine multi-day gap (check `select branch,date from day_closes where branch='Helderberg' order by date;` - if the real data happens to have no gap, INSERT a throwaway test row dated a few days before the most recent real close, tagged unmistakably e.g. `branch='TESTGAP-Helderberg'`, to create a controlled gap scenario, then delete it after). Then browser-verify (stub `sb.from('day_closes')` to return this exact real/controlled data shape) that `_lastCloseDate('Helderberg','<the day after the gap>')` returns the date BEFORE the gap, not `null` and not the literal-yesterday date that doesn't exist. Confirm the 6 rewired call sites all still behave correctly for the ordinary NO-gap case too (yesterday exists and IS the last close - must still return yesterday, not skip past it).

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "fix: prev-close comparisons reach the LAST ACTUAL close, not literally yesterday

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: `daily_sales` table

**Files:**
- Create: `supabase/migrations/<timestamp>_daily_sales.sql`

- [ ] **Step 1: Write and apply the migration**

```sql
-- Daily Sales/Returns - closes the "no point-of-sale record" gap the single-day report and
-- Date-Range Stock Balance both explicitly flag today. One row per branch+date, the whole
-- day's per-size tally committed/replaced atomically (Manager fills the grid, hits Commit
-- once - not a per-transaction log, see docs/superpowers/plans/2026-09-13-daily-sales-and-
-- last-close-fix.md for the design discussion).
CREATE TABLE IF NOT EXISTS daily_sales (
  branch text not null,
  date text not null,                -- 'YYYY-MM-DD', same convention as stock_counts.date
  lines jsonb not null,               -- [{size, sold, returned}, ...] - shells only, no brand
  entered_by uuid references profiles(id),
  entered_by_name_snapshot text,
  entered_at timestamptz not null default now(),
  primary key (branch, date)
);
CREATE INDEX IF NOT EXISTS daily_sales_branch_date_idx ON daily_sales (branch, date);
ALTER TABLE daily_sales ENABLE ROW LEVEL SECURITY;
CREATE POLICY daily_sales_select ON daily_sales FOR SELECT TO authenticated USING (true);
CREATE POLICY daily_sales_insert ON daily_sales FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY daily_sales_update ON daily_sales FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
```

Apply via `supabase db query --linked -f <file>` (check `supabase migration list --linked` first for any other unrelated pending migrations before deciding whether `db push` is safe to use instead - same caution this project's other recent migrations have needed). If applied via `db query` rather than `db push`, run `supabase migration repair --status applied <version>` afterward so a future `db push` doesn't re-attempt the non-idempotent `CREATE POLICY` statements.

- [ ] **Step 2: Verify for real**

Insert a test row (`branch:'TEST-Helderberg'`), confirm upsert-on-`(branch,date)` replaces rather than duplicates on a second insert with different `lines`, clean up.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/<file>.sql
git commit -m "feat: daily_sales table for real captured Sales/Returns

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Daily Sales capture screen

**Files:**
- Modify: `index.html` — new tile, new `dailySalesView` screen div, new JS controller.

Depends on Task 2 (table must exist). Independent of Task 1.

- [ ] **Step 1: Tile**

Find the true last tile in the home grid (search `id="tileRangeBalance"` - by now that's the last one from Phase 3) and add after it, matching the real current markup convention exactly (re-read the actual file first - class, `data-key`, icon style, `<p>` wording pattern):

```html
<button class="tile t4" data-key="dailySales" id="tileDailySales" onclick="openDailySales()" style="display:none"><div class="ic">&#128176;</div><h3>Daily Sales</h3><p>Manager/Owner: sold + returned cylinders today</p></button>
```

- [ ] **Step 2: Rollout gate**

In `_finishLogin`'s tile-visibility block, after the `tileRangeBalance`/`_trb` line (search `tileRangeBalance` inside `_finishLogin`):

```javascript
var _tds=document.getElementById('tileDailySales');if(_tds)_tds.style.display=(role==='Manager'||role==='Owner')?'flex':'none';
```

- [ ] **Step 3: Screen markup**

Modeled on Stock Transfer's simple per-size grid (`.brandCard`/`.bLine`, see `openTransfers`'s `xferItemsGrid` for the exact pattern to copy) - deliberately NOT Transfer's multi-tab dispatch/receipt/approval structure, which doesn't apply to a single Manager entering one day's tally:

```html
<!-- DAILY SALES / RETURNS (Manager + Owner) -->
<div id="dailySalesView" class="view">
  <div class="wrap">
    <div class="cgRow"><label>Branch</label><select class="mField" id="dsBranch" style="flex:1;margin:0" onchange="dsLoad()"><option>Helderberg</option><option>Kleinmond</option></select></div>
    <div id="dsGrid"></div>
    <div class="callout" id="dsPrivateKg" style="margin-top:10px"></div>
    <div class="callout" id="dsNetExchange" style="font-weight:800"></div>
    <button class="saveBtn" onclick="dsCommit()" style="margin-top:14px">Commit Daily Sales</button>
  </div>
</div>
```

- [ ] **Step 4: JS controller**

Place near the Transfer code (search `// ===== Branch Transfers` for where that section starts, and add this as its own clearly-separated block after it, or wherever the real current file's structure makes more sense - use your judgment, keep it together, don't scatter):

```javascript
// ===== Daily Sales / Returns (daily_sales) - closes the "no point-of-sale record" gap =====
var _dsRows={}; // size -> {sold, returned}
function openDailySales(){
  if(role!=='Manager'&&role!=='Owner'){toast('Not available for this role',true);return;}
  show('dailySalesView');
  document.getElementById('backBtn').style.display='block';
  document.getElementById('hTitle').textContent='Daily Sales';
  document.getElementById('hSub').textContent='Sold + returned cylinders today';
  document.getElementById('dsBranch').value=(branch||'Helderberg');
  dsLoad();
}
function dsRenderGrid(){
  var g=document.getElementById('dsGrid');
  g.innerHTML=ALLSIZES.map(function(sz){
    var r=_dsRows[sz]||{sold:0,returned:0};
    var diff=num(r.sold)-num(r.returned);
    return '<div class="brandCard"><b style="font-size:12px">'+sz+'</b><div class="bLine" style="margin-top:6px">'+
      '<span style="font-size:11px;font-weight:800;color:var(--navy);text-transform:uppercase;letter-spacing:.4px;width:56px;flex:none">Sold</span>'+
      '<input type="number" min="0" step="1" value="'+num(r.sold)+'" oninput="dsSetLine(\''+sz+'\',\'sold\',this.value)">'+
      '</div><div class="bLine" style="margin-top:4px">'+
      '<span style="font-size:11px;font-weight:800;color:var(--navy);text-transform:uppercase;letter-spacing:.4px;width:56px;flex:none">Back</span>'+
      '<input type="number" min="0" step="1" value="'+num(r.returned)+'" oninput="dsSetLine(\''+sz+'\',\'returned\',this.value)">'+
      '<span style="font-size:11px;color:var(--muted);flex:none">Diff '+(diff>0?'+':'')+diff+'</span>'+
      '</div></div>';
  }).join('');
  dsRenderNetExchange();
}
function dsSetLine(sz,field,val){
  if(!_dsRows[sz])_dsRows[sz]={sold:0,returned:0};
  _dsRows[sz][field]=Math.max(0,Math.round(num(val)));
  dsRenderGrid(); // re-render for the updated Diff readout - cheap, ALLSIZES is small
}
function dsRenderNetExchange(){
  var soldTotal=0,returnedTotal=0;
  ALLSIZES.forEach(function(sz){var r=_dsRows[sz];if(r){soldTotal+=num(r.sold);returnedTotal+=num(r.returned);}});
  var net=soldTotal-returnedTotal;
  document.getElementById('dsNetExchange').textContent='Net Cylinder Exchange: '+(net>0?'+':'')+net+' shells ('+soldTotal+' sold − '+returnedTotal+' back)';
}
function dsLoad(){
  var br=document.getElementById('dsBranch').value;
  _dsRows={};
  // Existing today's entry, if the Manager already committed once and is correcting it.
  sb.from('daily_sales').select('lines').eq('branch',br).eq('date',today).maybeSingle().then(function(res){
    if(res.data&&res.data.lines){
      res.data.lines.forEach(function(l){_dsRows[l.size]={sold:num(l.sold),returned:num(l.returned)};});
    }
    dsRenderGrid();
  },function(){dsRenderGrid();});
  // In-house (filledBy 'Us') Private Refill kg for today, read-only display - already-
  // balanced-against-Manifold data (see manifoldBalance's own privKg filter), not re-entered.
  sb.from('capture_live_rows').select('row').eq('kind','private').eq('branch',br).eq('date',today).then(function(res){
    var kg=((res.data||[]).map(function(r){return r.row||{};}).filter(function(r){return r.filledBy!=='Supplier';})
      .reduce(function(s,r){return s+num(r.pumped);},0));
    document.getElementById('dsPrivateKg').textContent='Private Refill (in-house): '+kg.toFixed(2)+' kg';
  },function(){document.getElementById('dsPrivateKg').textContent='Private Refill (in-house): —';});
}
var _dsCommitBusy=false;
function dsCommit(){
  if(_dsCommitBusy)return;
  var br=document.getElementById('dsBranch').value;
  var lines=ALLSIZES.map(function(sz){var r=_dsRows[sz]||{sold:0,returned:0};return {size:sz,sold:num(r.sold),returned:num(r.returned)};})
    .filter(function(l){return l.sold||l.returned;});
  if(!lines.length){toast('Nothing entered',true);return;}
  _dsCommitBusy=true;
  sb.from('daily_sales').upsert({branch:br,date:today,lines:lines,entered_by:currentProfile&&currentProfile.id,entered_by_name_snapshot:operator},{onConflict:'branch,date'}).then(function(res){
    _dsCommitBusy=false;
    if(res.error){toast('Could not save - try again',true);return;}
    auditLog('Daily Sales committed',br+' - '+lines.length+' size(s)');
    toast('Daily Sales saved');
  },function(){_dsCommitBusy=false;toast('Could not save - try again',true);});
}
```

- [ ] **Step 5: CSS view allow-list entry**

Add `body[data-view="dailySalesView"] #dailySalesView` to the comma-separated allow-list near the top of the file (search `data-view="rangeBalanceView"` for the real current location of this block) - **every prior phase this session forgot this at least once and shipped a blank screen**, do this now and verify it live, don't skip to "looks right."

- [ ] **Step 6: Syntax check + browser verification**

Serve locally, verify: tile shows for Manager/Owner only; opening the screen renders all sizes with 0/0/Diff 0; typing Sold/Returned updates Diff and Net Cylinder Exchange live; the Private Refill line shows a real stubbed kg figure; Commit upserts the expected `{branch,date,lines,entered_by_name_snapshot}` shape (stub `sb.from('daily_sales').upsert` to capture the call); re-opening after a stubbed existing row pre-fills the grid from it (correction flow).

- [ ] **Step 7: Commit**

```bash
git add index.html
git commit -m "feat: Daily Sales/Returns capture screen (Manager/Owner)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Single-day report — real data overrides the inference

**Files:**
- Modify: `index.html` — `buildCountDocAsync`, BOTH the HTML-report branch (search `Estimated Stock Sales &amp; Cylinder Exchange`) and the CSV/plain-export branch (search `Estimated Stock Sales & Cylinder Exchange` without the HTML entity - a separate, near-identical code path, confirmed to exist by direct reading of the current file).

Depends on Task 2 (table exists) and Task 3 (real data can exist to test against).

- [ ] **Step 1: Fetch real Sales data alongside the existing inputs**

`buildCountDocAsync` already gathers its inputs via `Promise.all([...])` near the top (search where `_fetchPrevCloseExpected` is already one of the parallel fetches, around where `pv`/`salesSizes` get computed) - add `sb.from('daily_sales').select('lines').eq('branch',_b).eq('date',src.date).maybeSingle()` as one more parallel fetch, alongside the existing ones. Re-read the actual current structure of this function before editing - it's long, with several `Promise.all` stages; find the right one rather than guessing.

- [ ] **Step 2: Override the section when real data exists**

At the point the HTML branch currently starts with:
```javascript
var soldRowsHtml='',soldTotal=0,soldKg=0,recvBackRowsHtml='',recvBackTotal=0;
salesSizes.forEach(function(sz){
  ...(the existing inference loop)...
});
```

Branch on whether the fetched `daily_sales` row exists. If it does, build `soldRowsHtml`/`recvBackRowsHtml`/`soldTotal`/`recvBackTotal` directly from its `lines` array instead of the inference formula, and change the section's own explanatory paragraph from *"Inferred, not observed..."* to something like *"Captured directly by [entered_by_name_snapshot] - not inferred."* Keep every downstream calculation (`pvAllTot`, `estSoldKgTotal`, `netExchange`) working identically off whichever `soldTotal`/`recvBackTotal`/`soldKg` values were used - real or inferred - so the rest of the section's rendering code doesn't need to change at all. Additionally add the new in-house-only Private Refill line the design calls for:
```javascript
var pvUsTot=pv.filter(function(r){return r.filledBy!=='Supplier';}).reduce(function(a,r){return a+num(r.pumped);},0);
```
and render it as its own row in the Sales section (e.g. `'<tr><td>Private Refill (in-house, part of Sales)</td><td class="n">'+pvUsTot.toFixed(2)+' kg</td></tr>'`), distinct from the existing `pvAllTot` line (which stays as-is, representing all private refill kg for the separate "Estimated gas sold today" figure - do not change that line's meaning).

Apply the identical change to the CSV/plain-export branch (Step 1's second call site) - same override logic, `row(...)` calls instead of HTML string concatenation, matching that branch's own existing style.

- [ ] **Step 3: Syntax check + browser verification**

Serve locally, stub `sb.from('daily_sales')` twice: once resolving with a real row (confirm the report shows "Captured" wording and the exact sold/returned/diff numbers from the stub, not the inference), once resolving with no row (confirm the report falls back to the existing inference calculation, completely unchanged from before this task). Confirm the new in-house Private Refill kg line appears correctly in both cases (it's independent of whether Sales was captured).

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: single-day report uses real Daily Sales data when captured, falls back to inference

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Date-Range Stock Balance — real data overrides the inference

**Files:**
- Modify: `index.html` — `fetchRangeStockBalance` (search `function fetchRangeStockBalance`) and `rbRenderReport` (search `function rbRenderReport`).

Depends on Task 2. Independent of Tasks 3-4 (touches a different report).

- [ ] **Step 1: Fetch real Sales data across the range**

Add near the existing range fetchers (search `_fetchRangeFaulty` for the pattern to match):
```javascript
// Real captured Sales for every day in the range that has one - {date: {sold:{}, returned:{}}}
// per size, summed across the range. Days with no daily_sales row simply contribute nothing
// here (the aggregator below falls back to the existing inference for the whole range if
// this comes back empty - a range can't be "partially captured, partially inferred" per size,
// that would double-count or under-count depending which days had real data).
function _fetchRangeDailySales(br,startDate,endDate){
  return sb.from('daily_sales').select('lines').eq('branch',br).gte('date',startDate).lte('date',endDate).then(function(res){
    if(res.error){console.error('_fetchRangeDailySales failed:',res.error.message);return null;}
    var rows=res.data||[];
    if(!rows.length)return null; // nothing captured anywhere in this range - caller falls back to inference
    var soldBySize={},returnedBySize={};
    rows.forEach(function(r){
      (r.lines||[]).forEach(function(l){
        soldBySize[l.size]=(soldBySize[l.size]||0)+num(l.sold);
        returnedBySize[l.size]=(returnedBySize[l.size]||0)+num(l.returned);
      });
    });
    return {soldBySize:soldBySize,returnedBySize:returnedBySize,daysCaptured:rows.length};
  },function(){return null;});
}
```

- [ ] **Step 2: Wire it into the aggregator and override `estSold`**

Add `_fetchRangeDailySales(br,startDate,endDate)` to `fetchRangeStockBalance`'s existing `Promise.all([...])` array (re-read the current array - it already has 8 entries per the earlier Phase 3 work, this becomes the 9th). In the `.then(function(r){...})` callback, after the existing `estSoldBySize`/`estSoldTotal` inference loop already computes its result, add:

```javascript
var realSales=r[8]; // the new _fetchRangeDailySales result
var salesIsReal=!!realSales;
if(salesIsReal){
  estSoldBySize={}; estSoldTotal=0;
  allSizes.forEach(function(sz){
    var v=(realSales.soldBySize[sz]||0);
    estSoldBySize[sz]=v; estSoldTotal+=v;
  });
}
```

Include `salesIsReal` (and `realSales` itself, for the returned-cylinders figure) in the object `fetchRangeStockBalance` returns, e.g. add `estSold:{bySize:estSoldBySize,total:estSoldTotal,isReal:salesIsReal,daysCaptured:realSales?realSales.daysCaptured:0}` (extending the existing `estSold` field rather than adding a whole new one).

- [ ] **Step 3: Update the render**

In `rbRenderReport(bal)` (search the existing `Estimated sold this range` line), change the wording to reflect real vs inferred:
```javascript
html+='<div class="callout" style="font-weight:800">'+(bal.estSold.isReal?'Sales (captured, '+bal.estSold.daysCaptured+' day(s))':'Estimated sold this range')+': '+bal.estSold.total+' cylinder(s)</div>';
```

- [ ] **Step 4: Syntax check + browser verification**

Serve locally, stub `sb.from('daily_sales')` to return real range data for one test - confirm `estSold.total`/`isReal`/`daysCaptured` reflect it and the report label changes to "Sales (captured...)". Stub it to return nothing - confirm `estSold` falls back to the existing inference exactly as before this task (unchanged numbers, unchanged "Estimated sold this range" wording).

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat: Date-Range Stock Balance uses real Daily Sales data when captured, falls back to inference

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Real-data verification + push

**Files:** none (verification only)

- [ ] **Step 1: Real Supabase round-trip**

Via `supabase db query --linked`: insert a real (tagged, e.g. `TEST6-Helderberg`) `daily_sales` row, confirm it reads back correctly, confirm a second upsert to the same `(branch,date)` replaces rather than duplicates, clean up.

- [ ] **Step 2: Real cross-feature check**

Confirm the Task 1 fix and the Task 3-5 features don't interact badly: e.g. does `_lastCloseDate` get called anywhere inside the new Daily Sales flow (it shouldn't need to - Sales doesn't depend on the prev-close mechanism at all, this is just a sanity check that Task 1 wasn't accidentally wired somewhere it doesn't belong).

- [ ] **Step 3: Push**

```bash
git push -u origin <branch>
```
Then use `superpowers:finishing-a-development-branch`.

---

## Self-Review

- [x] **Spec coverage:** Sunday/non-working-day gap fixed at all 6 real call sites (Task 1) ✓; Daily Sales captures per-size Sold/Returned/Diff + Net Cylinder Exchange, Manager/Owner only (Task 3) ✓; Private Refill in-house-only kg surfaced as part of Sales, not merged into the shell grid (Task 3 Step 4, Task 4 Step 2) ✓; real data replaces the inference in both the single-day report (Task 4) and Date-Range Balance (Task 5), inference kept as fallback for uncaptured days/ranges ✓.
- [x] **Placeholder scan:** no TBD/TODO; every code step has complete code.
- [x] **Type consistency:** `daily_sales.lines` shape (`[{size,sold,returned}]`) is read identically by Task 3's `dsLoad`, Task 4's report override, and Task 5's `_fetchRangeDailySales`. `fetchRangeStockBalance`'s `estSold` field gains `isReal`/`daysCaptured` as an extension, not a breaking shape change - existing `bySize`/`total` keys untouched, so nothing else reading that object needs to change.
- [x] **Known scope boundary, stated explicitly:** a date range where SOME days have captured Sales and others don't uses the captured total for whichever sizes/days have it and treats the rest as zero contribution for this round (no per-day inference-fill-in for partially-captured ranges) - `_fetchRangeDailySales` returning non-null means "use real data for everything summed," full stop, to avoid double-counting a day that has both a real entry and would also contribute to the inference formula. Flagged here so a reviewer doesn't need to rediscover this deliberate simplification.

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-09-13-daily-sales-and-last-close-fix.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, two-stage review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session with checkpoints for review.

Which approach?
