# Remaining Live Cross-Device Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring Stock Received, Refill, Private Refill, Residual Gas, Seal Register, and
Branch Setup/Count Times to the same live cross-device standard Manifold and Stock Count
already have — committed data from one device is visible on any other device the next time
the relevant screen opens, and the Seal Register's duplicate check becomes a real,
server-enforced guarantee instead of a per-device guess.

**Architecture:** Reuse the exact pattern from `manifold_live_rows`. One generic
`capture_live_rows` table (JSONB row + `kind` column) covers Received/Refill/Private/Residual.
Seal Register gets two bespoke tables (`seal_rolls`, `seal_used`) because `seal_used` needs a
real `UNIQUE(roll_id, seal_no)` constraint, not just a mirror. Branch Setup/Count Times share
one small `app_config` key-value table. Every write is additive alongside the existing
Sheets push; every read is a fetch-on-open that replaces only the relevant branch+date slice
of local `store`/localStorage config.

**Tech Stack:** Vanilla JS (single-file `index.html`), Supabase JS client (`sb`), no build
step. Verification convention: extract the main `<script>` block, `node --check` it after
every edit; live-verify via the Claude Browser preview with `sb`/`apiPost` stubbed and seeded
state, same as every other feature this session.

**Reference:** `docs/superpowers/specs/2026-09-07-remaining-live-cross-device-data-design.md`

---

### Task 0: Create the Supabase tables

**Files:** none (schema change — hand the user SQL to run in the Supabase SQL editor).

- [ ] **Step 1: Give the user this SQL**

```sql
-- Received / Refill / Private / Residual: one generic mirror table
CREATE TABLE IF NOT EXISTS capture_live_rows (
  id uuid primary key default gen_random_uuid(),
  kind text not null,             -- 'received' | 'refill' | 'private' | 'residual'
  row_id text,
  branch text not null,
  date text not null,
  row jsonb not null,
  committed_by uuid references profiles(id),
  committed_at timestamptz default now()
);
CREATE INDEX IF NOT EXISTS capture_live_rows_kind_branch_date_idx ON capture_live_rows (kind, branch, date);

ALTER TABLE capture_live_rows ENABLE ROW LEVEL SECURITY;
CREATE POLICY capture_live_rows_select ON capture_live_rows FOR SELECT TO authenticated USING (true);
CREATE POLICY capture_live_rows_insert ON capture_live_rows FOR INSERT TO authenticated WITH CHECK (true);

-- Seal Register: roll config
CREATE TABLE IF NOT EXISTS seal_rolls (
  id text primary key,
  branch text not null,
  brand text,
  start_no integer not null,
  end_no integer not null,
  status text not null,           -- Active | Queued | Depleted | Closed
  warn_at integer default 20,
  created_by uuid references profiles(id),
  created_at timestamptz default now(),
  closed_by uuid references profiles(id),
  closed_at timestamptz,
  close_reason text
);
CREATE INDEX IF NOT EXISTS seal_rolls_branch_idx ON seal_rolls (branch);

ALTER TABLE seal_rolls ENABLE ROW LEVEL SECURITY;
CREATE POLICY seal_rolls_select ON seal_rolls FOR SELECT TO authenticated USING (true);
CREATE POLICY seal_rolls_insert ON seal_rolls FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY seal_rolls_update ON seal_rolls FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

-- Seal Register: used-seal history, the real duplicate guard
CREATE TABLE IF NOT EXISTS seal_used (
  id uuid primary key default gen_random_uuid(),
  roll_id text references seal_rolls(id),
  branch text not null,
  seal_no integer not null,
  used_by uuid references profiles(id),
  used_at timestamptz default now(),
  unique (roll_id, seal_no)
);
CREATE INDEX IF NOT EXISTS seal_used_branch_idx ON seal_used (branch);

ALTER TABLE seal_used ENABLE ROW LEVEL SECURITY;
CREATE POLICY seal_used_select ON seal_used FOR SELECT TO authenticated USING (true);
CREATE POLICY seal_used_insert ON seal_used FOR INSERT TO authenticated WITH CHECK (true);

-- Branch Setup / Count Times config
CREATE TABLE IF NOT EXISTS app_config (
  key text primary key,
  value jsonb not null,
  updated_by uuid references profiles(id),
  updated_at timestamptz default now()
);

ALTER TABLE app_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY app_config_select ON app_config FOR SELECT TO authenticated USING (true);
CREATE POLICY app_config_upsert ON app_config FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY app_config_update ON app_config FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
```

- [ ] **Step 2: Confirm with the user every table was created successfully before continuing**

---

### Task 1: Generic push/queue helpers for `capture_live_rows`

**Files:** Modify `index.html`, add near `_reconcileSharedCountRows`/`_refreshSharedCounts`
(around line 4601, the "shared live data" cluster).

- [ ] **Step 1: Add the push + retry-queue functions**

```javascript
// ===== Generic live cross-device mirror for Received/Refill/Private/Residual =====
// Same pattern as manifold_live_rows (see docs/superpowers/specs/2026-08-31-manifold-live-
// cross-device-data-design.md) generalized with a `kind` column instead of one table per
// capture type, since these four share the exact same additive-event/JSONB-row shape.
function _pushCaptureLiveRows(kind,rows,br){
  if(!rows||!rows.length)return;
  var payload=rows.map(function(row){
    return {kind:kind, row_id:row._rid||null, branch:br, date:row._date||today, row:row, committed_by:currentProfile&&currentProfile.id};
  });
  sb.from('capture_live_rows').insert(payload).then(function(res){
    if(res.error){console.error('_pushCaptureLiveRows('+kind+') failed:',res.error.message);_captureLiveQueue(payload);}
    else{_captureLiveFlush();}
  },function(e){console.error('_pushCaptureLiveRows('+kind+') rejected:',e&&e.message);_captureLiveQueue(payload);});
}
function _captureLiveQueue(payload){
  try{
    var q=JSON.parse(localStorage.getItem('gs_capturelive_queue')||'[]');
    q.push(payload);
    localStorage.setItem('gs_capturelive_queue',JSON.stringify(q.slice(-200)));
  }catch(e){}
}
function _captureLiveFlush(){
  var q;try{q=JSON.parse(localStorage.getItem('gs_capturelive_queue')||'[]');}catch(e){return;}
  if(!q.length)return;
  localStorage.setItem('gs_capturelive_queue','[]');
  q.forEach(function(payload){
    sb.from('capture_live_rows').insert(payload).then(function(res){
      if(res.error)_captureLiveQueue(payload);
    },function(e){_captureLiveQueue(payload);});
  });
}
// Fetch-on-open: pulls kind+branch+date's live rows into store[storeKey], same merge
// _fetchManifoldLiveRows already does (dedup by _rid, preserve any not-yet-synced local
// pending row not yet visible in the live table, leave every other branch/date untouched).
function _fetchCaptureLiveRows(kind,storeKey,br,date){
  return sb.from('capture_live_rows').select('row').eq('kind',kind).eq('branch',br).eq('date',date).then(function(res){
    if(res.error){console.error('_fetchCaptureLiveRows('+kind+') failed for '+br+'/'+date+':',res.error.message);return;}
    var liveRows=(res.data||[]).map(function(r){var row=r.row||{};row._committed=true;return row;});
    var _seenRid={};
    liveRows=liveRows.filter(function(r){
      if(!r._rid)return true;
      if(_seenRid[r._rid])return false;
      _seenRid[r._rid]=true;
      return true;
    });
    var liveRids={};liveRows.forEach(function(r){if(r._rid)liveRids[r._rid]=true;});
    var brField=function(r){return r.branch||r.Branch;};
    var localPending=(store[storeKey]||[]).filter(function(r){
      return brField(r)===br && (r._date||today)===date && r._committed && r._rid && !liveRids[r._rid];
    });
    var others=(store[storeKey]||[]).filter(function(r){return !(brField(r)===br && (r._date||today)===date);});
    store[storeKey]=others.concat(liveRows).concat(localPending);
  },function(e){console.error('_fetchCaptureLiveRows('+kind+') rejected for '+br+'/'+date+':',e&&e.message);});
}
```

- [ ] **Step 2: Syntax-check**

Run (PowerShell):
```powershell
$c = Get-Content -Raw "C:\Users\Freddie Du Plessis\OneDrive\Desktop\LPG-Gas-App\index.html"
$m = [regex]::Match($c, '(?s)function corrLines.*?(?=</script>)')
$m.Value | Out-File -Encoding utf8 "$env:TEMP\_check.js"
node --check "$env:TEMP\_check.js"
Remove-Item "$env:TEMP\_check.js"
```
Expected: no output (success).

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: generic capture_live_rows push/fetch helpers for Received/Refill/Private/Residual"
```

---

### Task 2: Wire Stock Received

**Files:** Modify `index.html` — `rCommitDo` (~line 5665), `openReceived`/`rSetBranch`
(~line 5377-5395).

- [ ] **Step 1: Write path — push after the existing local concat + Sheet push**

In `rCommitDo`, right after:
```javascript
    store.received=(store.received||[]).concat(newRows);
    syncPush('Received',syncRowsReceived(newRows,rBranch));
```
add:
```javascript
    _pushCaptureLiveRows('received',newRows,rBranch);
```

- [ ] **Step 2: Read path — fetch on open and branch switch**

In `openReceived()`, add alongside the existing `_adoptRemoteCloseIfNeeded` call:
```javascript
    (function(br){_fetchCaptureLiveRows('received','received',br,today).then(function(){if(rBranch===br)rRenderGrid();});})(rBranch);
```
In `rSetBranch(x)`, add the same call with `x` in place of `rBranch`, mirroring the existing
`_adoptRemoteCloseIfNeeded` line there.

- [ ] **Step 3: Syntax-check** (same command as Task 1 Step 2)

- [ ] **Step 4: Verify locally**

In the Claude Browser preview, stub `sb.from('capture_live_rows')` to return two seeded rows
for `kind:'received', branch:'Helderberg', date:today` with different `_rid`s than anything
local; call `_fetchCaptureLiveRows('received','received','Helderberg',today)` directly; assert
`store.received` contains both seeded rows plus any pre-existing local rows for other
branches/dates untouched.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat: Stock Received live cross-device data (capture_live_rows)"
```

---

### Task 3: Wire Refill + Private Refill

**Files:** Modify `index.html` — `_capCommitReal` (~line 7543-7548), `openCap`/`capSetBranch`
(~line 5833, 5868).

- [ ] **Step 1: Write path**

In `_capCommitReal`, change:
```javascript
    else if(capType==='refill'){
      // record each seal against the active roll history (dedupe handled inside)
      freshRows.filter(function(r){return r.seal;}).forEach(function(r){sealRecordUse(capBranch,num(r.seal));});
      syncPush('Refills',syncRowsRefill(freshRows,capBranch));
    }
    else if(capType==='private')syncPush('Private',syncRowsPrivate(freshRows,capBranch));
```
to:
```javascript
    else if(capType==='refill'){
      // record each seal against the active roll history (dedupe handled inside)
      freshRows.filter(function(r){return r.seal;}).forEach(function(r){sealRecordUse(capBranch,num(r.seal));});
      syncPush('Refills',syncRowsRefill(freshRows,capBranch));
      _pushCaptureLiveRows('refill',freshRows,capBranch);
    }
    else if(capType==='private'){
      syncPush('Private',syncRowsPrivate(freshRows,capBranch));
      _pushCaptureLiveRows('private',freshRows,capBranch);
    }
```
(Task 5 below revisits `sealRecordUse` itself — no change to this call site's shape.)

- [ ] **Step 2: Read path**

In `openCap(type,opts)`, change the existing manifold-only line:
```javascript
  if(type==='manifold'){_fetchManifoldSlotCount(capBranch).then(renderGrid);_fetchManifoldPrevClose(capBranch);_fetchManifoldLiveRows(capBranch,today).then(renderGrid);}
```
to also cover refill/private, added right after it:
```javascript
  if(type==='refill'||type==='private'){_fetchCaptureLiveRows(type,type,capBranch,today).then(renderGrid);}
```
In `capSetBranch(x)`, same addition right after the existing manifold-only line there:
```javascript
  if(type==='refill'||type==='private'){_fetchCaptureLiveRows(capType,capType,x,today).then(renderGrid);}
```
(Note: inside `capSetBranch`, the active type is `capType`, not a `type` parameter — use
`capType`, matching the existing manifold line's own use of `capType==='manifold'` there.)

- [ ] **Step 3: Syntax-check**

- [ ] **Step 4: Verify locally**

Seed `capture_live_rows` stub with one `kind:'refill'` row and one `kind:'private'` row for
`Helderberg`/today; call `_fetchCaptureLiveRows('refill','refill','Helderberg',today)` and the
`'private'` equivalent directly; assert `store.refill`/`store.private` pick them up. Confirm
`renderGrid()` doesn't throw when called from `openCap`'s new fetch for both types (it's the
same shared grid renderer Manifold already exercises this way).

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat: Refill + Private Refill live cross-device data (capture_live_rows)"
```

---

### Task 4: Wire Residual Gas

**Files:** Modify `index.html` — `residualSubmit` (~line 2484-2497), `openResidual`/
`residualSetBranch` (~line 2288, 2304).

- [ ] **Step 1: Give committed residual rows a `_rid`**

`residualSubmit`'s `committedRows` map currently has no row id (needed for the live table's
`row_id` and the dedup-by-`_rid` logic in `_fetchCaptureLiveRows`). Change:
```javascript
    var committedRows=residualList.map(function(r){
      return {Branch:r.Branch,Brand:r.Brand,Size:r.Size,GasType:r.GasType,CylScale:r.CylScale,CylTare:r.CylTare,Residual:r.Residual,Note:r.Note,_operator:operator,_date:today,_committed:true};
    });
```
to:
```javascript
    var committedRows=residualList.map(function(r){
      return {Branch:r.Branch,Brand:r.Brand,Size:r.Size,GasType:r.GasType,CylScale:r.CylScale,CylTare:r.CylTare,Residual:r.Residual,Note:r.Note,_operator:operator,_date:today,_committed:true,_rid:_rid()};
    });
```

- [ ] **Step 2: Write path**

Right after:
```javascript
    store.residual=(store.residual||[]).concat(committedRows);
```
add:
```javascript
    _pushCaptureLiveRows('residual',committedRows,committedRows[0]&&committedRows[0].Branch);
```
(Residual rows use capitalized `.Branch` — see the existing comment at
`_residualFromStore`/`residualCommittedToday` for why; `_fetchCaptureLiveRows`'s `brField`
helper from Task 1 already reads either case. All rows in one submit share the same branch —
`residualList` is captured per-branch — so `committedRows[0].Branch` is safe.)

- [ ] **Step 3: Read path**

In `openResidual()`, add a fetch-on-open call (mirroring `openReceived`'s shape):
```javascript
  (function(br){_fetchCaptureLiveRows('residual','residual',br,today).then(function(){if(residualBranch===br)renderResidualCommitted();});})(residualBranch);
```
In `residualSetBranch(b)`, the same call with `b` substituted for `residualBranch`.

- [ ] **Step 4: Syntax-check**

- [ ] **Step 5: Verify locally**

Seed one `kind:'residual', branch:'Helderberg'` row via the stub; call
`_fetchCaptureLiveRows('residual','residual','Helderberg',today)`; assert `store.residual`
picks it up and `residualCommittedToday('Helderberg')` (which filters on `.Branch`) sees it.

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "feat: Residual Gas live cross-device data (capture_live_rows)"
```

---

### Task 5: Wire Seal Register

**Files:** Modify `index.html` — `sealRecordUse` (~line 1560), `sealsLoad`/`sealUsedLoad`
callers via a new fetch, `openCap`/`capSetBranch` (refill branch — extend Task 3's addition),
Admin Seal Register tab (`adminTab`/its branch switch), roll-management functions
(`promoteQueued` and wherever a roll is created/closed — locate via `sealsSave` call sites).

- [ ] **Step 1: Add fetch-on-open for seal_rolls + seal_used**

Add near the Seal Register block (after `sealUsedSave`, ~line 1541):
```javascript
// Live cross-device refresh: pulls this branch's roll config and used-seal history from the
// shared tables into the same local blobs sealsLoad()/sealUsedLoad() already read, so
// sealValidate's existing synchronous check sees cross-device history with no change to its
// own logic. Same refresh-on-open shape as every other section in this phase - called from
// the Refill screen (where sealValidate actually runs) and the Admin Seal Register tab.
function _fetchSealLive(br){
  var p1=sb.from('seal_rolls').select('*').eq('branch',br).then(function(res){
    if(res.error){console.error('_fetchSealLive rolls failed:',res.error.message);return;}
    var live=(res.data||[]).map(function(d){return {id:d.id,branch:d.branch,brand:d.brand,start:d.start_no,end:d.end_no,status:d.status,warnAt:d.warn_at,createdBy:d.created_by,createdAt:d.created_at,closedBy:d.closed_by,closedAt:d.closed_at,closeReason:d.close_reason};});
    var others=sealsLoad().filter(function(r){return r.branch!==br;});
    sealsSave(others.concat(live));
  },function(e){console.error('_fetchSealLive rolls rejected:',e&&e.message);});
  var p2=sb.from('seal_used').select('roll_id,seal_no').eq('branch',br).then(function(res){
    if(res.error){console.error('_fetchSealLive used failed:',res.error.message);return;}
    var o=sealUsedLoad();
    // Rebuild only this branch's rolls' used-lists from the live rows - a roll belonging to
    // another branch is never touched here.
    var brRollIds={};sealsLoad().filter(function(r){return r.branch===br;}).forEach(function(r){brRollIds[r.id]=true;});
    Object.keys(o).forEach(function(rid){if(brRollIds[rid])delete o[rid];});
    (res.data||[]).forEach(function(row){
      if(!o[row.roll_id])o[row.roll_id]=[];
      if(o[row.roll_id].indexOf(row.seal_no)===-1)o[row.roll_id].push(row.seal_no);
    });
    sealUsedSave(o);
  },function(e){console.error('_fetchSealLive used rejected:',e&&e.message);});
  return Promise.all([p1,p2]);
}
```

- [ ] **Step 2: Call it from the Refill screen's open/branch-switch**

Extend Task 3's `openCap`/`capSetBranch` additions:
```javascript
  if(type==='refill'||type==='private'){_fetchCaptureLiveRows(type,type,capBranch,today).then(renderGrid);}
  if(type==='refill'){_fetchSealLive(capBranch);}
```
(and the `capSetBranch` equivalent using `x`/`capType`).

- [ ] **Step 3: Call it from the Admin Seal Register tab**

In `_adminTabShow(t)` (~line 1711), change:
```javascript
  if(t==='seals'){fillBrandPicker();renderRolls();}
```
to:
```javascript
  if(t==='seals'){fillBrandPicker();renderRolls();_fetchSealLive(adminBranch).then(function(){renderRolls();renderUsedSeals();});}
```
And in `adminSetBranch(b)` (~line 1717-1720), change:
```javascript
function adminSetBranch(b){
  if(role==='Manager' && (_curUser().branches||[]).indexOf(b)===-1){toast('Not your branch',true);return;}
  adminBranch=b;applyBranchLock('asbr-',b);renderRolls();
}
```
to:
```javascript
function adminSetBranch(b){
  if(role==='Manager' && (_curUser().branches||[]).indexOf(b)===-1){toast('Not your branch',true);return;}
  adminBranch=b;applyBranchLock('asbr-',b);renderRolls();
  _fetchSealLive(adminBranch).then(function(){renderRolls();renderUsedSeals();});
}
```

- [ ] **Step 4: Push roll writes to `seal_rolls`**

Add one small helper near `_fetchSealLive` (Step 1):
```javascript
function _pushSealRoll(r){
  sb.from('seal_rolls').upsert({id:r.id,branch:r.branch,brand:r.brand||null,start_no:r.start,end_no:r.end,status:r.status,warn_at:r.warnAt!==undefined?r.warnAt:20,created_by:currentProfile&&currentProfile.id,closed_by:(r.status==='Closed'||r.status==='Depleted')?(currentProfile&&currentProfile.id):null,closed_at:r.closedAt||null,close_reason:r.closeReason||null},{onConflict:'id'}).then(function(res){
    if(res.error)console.error('seal_rolls upsert failed:',res.error.message);
  });
}
function _deleteSealRoll(id){
  sb.from('seal_rolls').delete().eq('id',id).then(function(res){
    if(res.error)console.error('seal_rolls delete failed:',res.error.message);
  });
}
```
Fire-and-forget, console error on failure only — the roll config isn't the safety-critical
part, `seal_used`'s `UNIQUE` constraint (Step 5) is. Call these at every existing
`sealsSave(...)` site that changes a roll's identity/status, right after that line:

| Function | Line | Change | Call |
|---|---|---|---|
| `sealRecordUse` (auto-deplete branch) | ~1567 | after `sealsSave(rolls);` | `_pushSealRoll(rolls[idx]);` |
| `promoteQueued` | ~1574 | after `sealsSave(rolls);` | `_pushSealRoll(rolls[idx]);` |
| `createRoll` | ~1753 | after `sealsSave(rolls);` | `_pushSealRoll(roll);` |
| `closeRollEarly` | ~1792 | after `sealsSave(rolls);` | `_pushSealRoll(rolls[idx]);` |
| `cancelQueued` | ~1804 | after `sealsSave(rolls);` | `_deleteSealRoll(id);` |
| `editRoll` | ~1824 | after `sealsSave(rolls);` | `_pushSealRoll(r);` |
| `deleteRoll` | ~1844 | after `sealsSave(rolls);` | `_deleteSealRoll(id);` |

Each is a single added line right after the existing `sealsSave(...)` call already on that
line — no other change to any of these seven functions.

- [ ] **Step 5: Make `sealRecordUse`'s write the authoritative duplicate guard**

Change (line ~1560):
```javascript
function sealRecordUse(br,seal){
  var r=activeRoll(br);if(!r)return;
  var o=sealUsedLoad();if(!o[r.id])o[r.id]=[];
  if(o[r.id].indexOf(seal)===-1){o[r.id].push(seal);sealUsedSave(o);}
  // auto-deplete when full
  if(rollUsedCount(r.id)>=rollTotal(r)){
    var rolls=sealsLoad();var idx=rolls.findIndex(function(x){return x.id===r.id;});
    if(idx>-1){rolls[idx].status='Depleted';rolls[idx].closedAt=nowStamp();sealsSave(rolls);
      promoteQueued(br);
      syncPushRoll(rolls[idx],'DEPLETED');}
  }
}
```
to:
```javascript
// Returns a Promise<boolean> - true if this seal was newly recorded (commit should proceed
// for this row), false if the shared table rejected it as a duplicate (commit for THIS row
// only should be treated as failed - see _capCommitReal's caller). Local gs_seal_used is
// still updated optimistically first, same as before, so the existing synchronous
// sealValidate() keeps working unchanged for every other line in the same session - this
// only adds a server round-trip as the final, authoritative word.
function sealRecordUse(br,seal){
  var r=activeRoll(br);if(!r)return Promise.resolve(true);
  var o=sealUsedLoad();if(!o[r.id])o[r.id]=[];
  if(o[r.id].indexOf(seal)===-1){o[r.id].push(seal);sealUsedSave(o);}
  if(rollUsedCount(r.id)>=rollTotal(r)){
    var rolls=sealsLoad();var idx=rolls.findIndex(function(x){return x.id===r.id;});
    if(idx>-1){rolls[idx].status='Depleted';rolls[idx].closedAt=nowStamp();sealsSave(rolls);
      promoteQueued(br);
      syncPushRoll(rolls[idx],'DEPLETED');}
  }
  return sb.from('seal_used').insert({roll_id:r.id,branch:br,seal_no:seal,used_by:currentProfile&&currentProfile.id}).then(function(res){
    if(res.error){
      // Postgres unique_violation is code 23505 - any other error (network, RLS, etc.) is
      // treated as non-fatal and queued instead, same tolerant tier as every other live
      // write in this app; only a confirmed conflict is treated as a real duplicate.
      if(res.error.code==='23505'){console.error('seal_used duplicate for roll '+r.id+' seal '+seal);return false;}
      console.error('seal_used insert failed (non-duplicate):',res.error.message);
      return true;
    }
    return true;
  },function(e){console.error('seal_used insert rejected:',e&&e.message);return true;});
}
```

- [ ] **Step 6: Handle a rejected seal at commit time**

In `_capCommitReal`, the refill branch currently fires `sealRecordUse` without checking its
result:
```javascript
    else if(capType==='refill'){
      // record each seal against the active roll history (dedupe handled inside)
      freshRows.filter(function(r){return r.seal;}).forEach(function(r){sealRecordUse(capBranch,num(r.seal));});
      syncPush('Refills',syncRowsRefill(freshRows,capBranch));
      _pushCaptureLiveRows('refill',freshRows,capBranch);
    }
```
Change to await each seal and un-commit only the rejected row's line (it stays in
`store.refill` with `_committed` cleared, so it reappears in the draft for the operator to
fix, and is excluded from the Sheet push / live mirror actually being trusted as final):
```javascript
    else if(capType==='refill'){
      var sealRows=freshRows.filter(function(r){return r.seal;});
      var sealResults=await Promise.all(sealRows.map(function(r){return sealRecordUse(capBranch,num(r.seal));}));
      var rejected=[];
      sealRows.forEach(function(r,i){if(!sealResults[i]){r._committed=false;rejected.push(r);}});
      var okRows=freshRows.filter(function(r){return rejected.indexOf(r)===-1;});
      if(rejected.length){
        toast(rejected.length+' seal(s) were already used on another device — check '+rejected.map(function(r){return r.seal;}).join(', ')+' and recommit',true);
      }
      if(okRows.length){
        syncPush('Refills',syncRowsRefill(okRows,capBranch));
        _pushCaptureLiveRows('refill',okRows,capBranch);
      }
    }
```
(`_capCommitReal` is already `async` — see its signature at line 7501 — so `await` here is
valid with no further change.)

- [ ] **Step 7: Syntax-check**

- [ ] **Step 8: Verify locally**

Two scenarios against the stub:
1. Normal: `sb.from('seal_used').insert` resolves with no error → `sealRecordUse` resolves
   `true` → row stays committed, both Sheet push and live mirror fire.
2. Duplicate: stub the insert to resolve `{error:{code:'23505'}}` → `sealRecordUse` resolves
   `false` → confirm that row's `_committed` is reset to `false`, it's excluded from
   `okRows`/the Sheet push, and the toast names the duplicated seal. Confirm a second,
   non-duplicate row in the same commit still goes through normally.

- [ ] **Step 9: Commit**

```bash
git add index.html
git commit -m "feat: Seal Register live cross-device data with server-enforced duplicate check"
```

---

### Task 6: Wire Branch Setup + Count Times

**Files:** Modify `index.html` — `bcfgLoad`/`bcfgSet`/`toggleSection`/`toggleItem`
(~line 2646-2710+), `loadCountCutoffCfg`/`saveCountCutoffCfg` (~line 2655-2691), `adminTab`/
`_adminTabShow` (~line 1666-1704).

- [ ] **Step 1: Add fetch-on-open + write-through for `app_config`**

Add near the Branch Setup config block (after `bcfgSave`, ~line 2647):
```javascript
// Live cross-device config: app_config holds one row per key ('branch_setup','count_cutoff').
// Fetched into the same local blobs bcfgLoad()/loadCountCutoffCfg() already read (so every
// existing read call site needs zero changes), written straight through on save - these are
// Owner-edited settings, not a capture stream, so last-write-wins is the correct model, no
// draft/commit split needed.
function _fetchAppConfig(key,localSaveFn){
  return sb.from('app_config').select('value').eq('key',key).maybeSingle().then(function(res){
    if(res.error){console.error('_fetchAppConfig('+key+') failed:',res.error.message);return;}
    if(res.data&&res.data.value)localSaveFn(res.data.value);
  },function(e){console.error('_fetchAppConfig('+key+') rejected:',e&&e.message);});
}
function _pushAppConfig(key,value){
  sb.from('app_config').upsert({key:key,value:value,updated_by:currentProfile&&currentProfile.id,updated_at:new Date().toISOString()},{onConflict:'key'}).then(function(res){
    if(res.error)console.error('_pushAppConfig('+key+') failed:',res.error.message);
  },function(e){console.error('_pushAppConfig('+key+') rejected:',e&&e.message);});
}
```

- [ ] **Step 2: Write-through on Branch Setup save**

`bcfgSet` (the function `toggleSection`/`toggleItem` both call) currently ends with
`bcfgSave(c)`. Find it and add `_pushAppConfig('branch_setup',c);` immediately after the
existing `bcfgSave(c)` call — same function, one extra line, no change to its signature or
callers.

- [ ] **Step 3: Write-through on Count Times save**

In `saveCountCutoffUI()`, immediately after the existing `saveCountCutoffCfg(cfg);` call, add:
```javascript
  _pushAppConfig('count_cutoff',cfg);
```

- [ ] **Step 4: Fetch-on-open for both Admin tabs**

In `_adminTabShow(t)`, add:
```javascript
  if(t==='bsetup'){_fetchAppConfig('branch_setup',bcfgSave).then(renderBsetup);}
  if(t==='counttimes'){_fetchAppConfig('count_cutoff',saveCountCutoffCfg).then(loadCountCutoffUI);}
```
(Placed after the existing `display`/`classList.toggle` lines in that function — the tab is
already visually switched in immediately, then repainted with live data once the fetch
resolves, same "render now with cache, re-render when live data lands" shape every other
fetch-on-open in this app already uses.)

- [ ] **Step 5: Syntax-check**

- [ ] **Step 6: Verify locally**

Seed the stub with an `app_config` row for `key:'branch_setup'` whose `value` differs from
local `gs_bcfg` (e.g. Refill turned off for a branch it's on for locally); call
`_fetchAppConfig('branch_setup',bcfgSave)` directly; assert `bcfgLoad()` now returns the
seeded value. Repeat for `count_cutoff`. Confirm `_pushAppConfig` is called with the right
key/value shape when `toggleSection`/`saveCountCutoffUI` run (spy/stub `sb.from('app_config')
.upsert`).

- [ ] **Step 7: Commit**

```bash
git add index.html
git commit -m "feat: Branch Setup + Count Times live cross-device config (app_config)"
```

---

### Task 7: Final review pass

- [ ] **Step 1:** Re-read the design doc's Success Criteria section and confirm each bullet
  against what was actually built (Received/Refill/Private/Residual visible cross-device;
  seal duplicate rejected server-side; Branch Setup/Count Times visible cross-device; Sheet
  push unaffected everywhere; Manifold/Count untouched).
- [ ] **Step 2:** `git log --oneline` the six feature commits above, confirm none touched
  unrelated code (diff review, same discipline as every other feature this session).
- [ ] **Step 3:** Push: `git push origin main`.
