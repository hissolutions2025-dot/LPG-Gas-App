# Stock Thresholds (Min Full Hold + Extra Allocation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two related, Manager-adjustable per-branch-per-size thresholds: **Minimum Full Stock Hold** (alert Manager+Operator when Closing stock for a size drops below a safety level, since deliveries are weekly) and **Extra Allocation** (flag a size whose Net Cylinder Exchange over a picked Date-Range Balance period is more negative than a configured tolerance — the slow "customers buying spares" pool-creep pattern). Both thresholds are seasonally adjustable by a Manager, not fixed.

**Architecture:** One new `app_config` row (key `'stock_thresholds'`), reusing the EXISTING live cross-device config mechanism (`_fetchAppConfig`/`_pushAppConfig`) Branch Setup and Count Times already use — no new table, no new sync machinery. Value shape: `{Helderberg:{'9kg':{minFullHold:0,extraAllocThreshold:0},...},Kleinmond:{...}}`. Config UI extends the existing Admin/Branch Setup screen. The two alerts are read-only consumers of this config plus data that already exists (Closing counts, Date-Range Stock Balance's Daily Sales rollup).

**Tech Stack:** Vanilla JS (`index.html`), Supabase (`app_config`, already live).

**Depends on:** Daily Sales/Returns (already merged) for Extra Allocation's Net Exchange data.

---

### Task 1: Config storage + admin UI

**Files:**
- Modify: `index.html` — near `bcfgLoad`/`bcfgSave` (search `// ===== BRANCH SETUP CONFIG =====`), and the Branch Setup admin screen (search `function renderBsetup`).

- [ ] **Step 1: Storage helpers**

Add next to `bcfgLoad`/`bcfgSave`:
```javascript
// Stock Thresholds - live cross-device config (app_config key 'stock_thresholds'), same
// mechanism as bcfg/count_cutoff. {branch:{size:{minFullHold, extraAllocThreshold}}}.
// Manager-adjustable (perm('branch_setup')) - seasonally, since demand isn't constant.
function thresholdsLoad(){try{return JSON.parse(localStorage.getItem('gs_stock_thresholds')||'{}');}catch(e){return {};}}
function thresholdsSave(c){localStorage.setItem('gs_stock_thresholds',JSON.stringify(c));}
function thresholdFor(br,sz){
  var t=thresholdsLoad();
  return (t[br]&&t[br][sz])||{minFullHold:0,extraAllocThreshold:0};
}
```

- [ ] **Step 2: Wire into the fetch-on-open pattern**

Find where Branch Setup's admin tab fetches `branch_setup` on open (search `_fetchAppConfig('branch_setup',bcfgSave)`) and add the same pattern for this new key, in the same place:
```javascript
_fetchAppConfig('stock_thresholds',thresholdsSave)
```
(chain/parallel it alongside the existing `branch_setup` fetch at that call site - re-read the actual current code there first to fit it in cleanly, matching whatever `.then(renderBsetup)` / re-render shape already exists.)

- [ ] **Step 3: Admin UI**

Find `renderBsetup()` (the Branch Setup screen's render function) and add a new per-size, per-branch input pair (Min Full Hold, Extra Allocation Threshold) alongside the existing per-item activation checkboxes - read the actual current markup/loop structure first (it already iterates branches × `SECTION_ITEMS`), and add two `<input type="number">` fields per size row, matching its existing style conventions. On change, update the in-memory `thresholdsLoad()`-shaped object and call `_pushAppConfig('stock_thresholds', <value>)` (same save trigger convention the existing per-item checkboxes already use - find and match it, don't invent a new save button/flow if one already exists for this screen).

- [ ] **Step 4: Syntax check + verification**

`node --check`. Browser-verify: set a threshold, confirm `_pushAppConfig` fires with the right shape (stub it), confirm `thresholdFor(br,sz)` returns the right value after a stubbed `_fetchAppConfig` resolves, confirm a size with no configured threshold defaults to `{minFullHold:0,extraAllocThreshold:0}` (i.e. no alert fires for anything not explicitly configured - opt-in, not a surprise default).

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat: Stock Thresholds config (Min Full Hold + Extra Allocation), per branch/size

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Minimum Full Stock Hold alert

**Files:**
- Modify: `index.html` — Home screen banner area (search `closeDayPendingBadge` for the existing banner pattern to match), wherever Closing counts are already summarized per size (search `_dayCompleteness` or the Home screen's own render/refresh function for where per-branch Closing totals are already computed - reuse rather than re-derive).

Depends on Task 1.

- [ ] **Step 1: Compute the check**

Add a function that compares today's Closing full count per size (for the current branch) against `thresholdFor(branch,sz).minFullHold`, returning the list of sizes currently below their minimum. Reuse whatever existing helper already sums Closing-Full-by-size for today (search for one before writing a new one - `_countFullKg`/`totalOf`/`counts.Closing.Full` patterns already exist in this file for the single-day report, confirm whether an equivalent is accessible outside `buildCountDocAsync`'s own closure, or build a small standalone version reading `store.count` directly if not).

- [ ] **Step 2: Render the banner**

Same visual pattern as `#closeDayPendingBadge`/`#countPendingBadge` (amber background, `#8a5a00` text) - visible to whoever's on the Home screen when any size is below its configured minimum for the current branch, listing which sizes. Flag only, never blocks anything. Update it wherever those other Home badges already get refreshed (find that call site, add this alongside it).

- [ ] **Step 3: Syntax check + verification**

`node --check`. Browser-verify: stub Closing counts + a configured threshold, confirm the banner shows the right size(s); confirm a size with `minFullHold:0` (unconfigured/opted-out) never triggers regardless of how low its count is; confirm the banner is empty/hidden when nothing's below threshold.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: Minimum Full Stock Hold alert on Home screen

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Extra Allocation flag in Date-Range Stock Balance

**Files:**
- Modify: `index.html` — `_fetchRangeDailySales`/`fetchRangeStockBalance` (search `function _fetchRangeDailySales`) and `rbRenderReport` (search `function rbRenderReport`).

Depends on Task 1. Independent of Task 2.

- [ ] **Step 1: Surface per-size Net Exchange**

`_fetchRangeDailySales` already internally computes `returnedBySize` but `fetchRangeStockBalance` currently only threads `soldBySize` into `estSold`. Re-read the real current code at both functions first, then add a per-size net-exchange figure to the returned object (e.g. extend `estSold` with `netExchangeBySize:{}` computed as `soldBySize[sz]-returnedBySize[sz]` for real-data ranges - leave it empty/absent when `salesIsReal` is false, since there's no real per-size returned data to compute it from in the inference-fallback case).

- [ ] **Step 2: Flag it in the render**

In `rbRenderReport`, for each size where `netExchangeBySize[sz]` exists and is more negative than `thresholdFor(bal.branch,sz).extraAllocThreshold` (only when that threshold is configured non-zero - zero means opted out, same convention as Task 2), add a visible flag line (e.g. `'<div class="callout" style="color:#C0392B">⚠ '+sz+': Net Exchange '+netExchangeBySize[sz]+' - possible cylinder creep, consider extra allocation</div>'`). Only render this section at all when at least one size is actually flagged.

- [ ] **Step 3: Syntax check + verification**

`node --check`. Browser-verify: stub real Daily Sales range data with one size's net exchange more negative than its configured threshold - confirm the flag renders; confirm a size within tolerance, or with no threshold configured, does not flag; confirm nothing renders at all (no empty flag section) when the range is using the inference fallback (`salesIsReal:false`).

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: Extra Allocation flag in Date-Range Stock Balance (pool-creep detection)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Real verification + push

- [ ] **Step 1:** Real Supabase round-trip on `app_config` key `'stock_thresholds'` via `supabase db query --linked` (insert, read back, upsert-replaces, clean up).
- [ ] **Step 2:** `git push -u origin <branch>`, then `superpowers:finishing-a-development-branch`.

---

## Self-Review

- [x] **Spec coverage:** both thresholds settable per branch+size, Manager-adjustable (Task 1) ✓; Min Full Hold alerts Manager+Operator on Home (Task 2) ✓; Extra Allocation flags pool-creep using real Sales data over a picked range (Task 3) ✓; both default to "off" (0 = unconfigured, no surprise alerts) ✓.
- [x] **Placeholder scan:** no TBD/TODO.
- [x] **Type consistency:** `thresholdFor(br,sz)` used identically by Task 2 and Task 3.

## Execution Handoff

Subagent-Driven, same as every recent feature this session - proceeding directly.
