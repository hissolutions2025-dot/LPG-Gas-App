/**
 * GAS SALES - BOUND Apps Script v17 (v16 + Faulty Cylinders Date-Range Read)
 * Lives INSIDE the master Google Sheet. Writes the full who/when/why schema.
 *
 * v17 changes vs v16:
 *   1. FAULTY CYLINDERS - DATE-RANGE READ: Phase 3's Date-Range Stock Balance report
 *      needs to answer "what was faulty over this date range", not just "what's faulty
 *      right now" - faultyListOpen has no date filter and doesn't return Timestamp or
 *      DateClosed at all, so it can't answer that for a past window. New 'faultyListRange'
 *      action returns every Faulty row relevant to a given [startDate,endDate] window for
 *      a branch, filtered server-side so the client never has to ship/filter years of rows:
 *      rows whose Timestamp falls inside the window (logged during the range), OR rows
 *      still Status='Faulty-Held' with Timestamp <= endDate (held as of the range's end,
 *      regardless of when they were originally logged - mirrors what "Faulty Cylinders"
 *      already means on the daily report, generalized to "as of range end" instead of
 *      "right now"). Read-only, no schema change, no migration/setup function needed.
 *
 * v16 changes vs v15:
 *   1. BRANCH TRANSFERS: new "Transfers" tab tracking cylinder stock moving between
 *      Helderberg and Kleinmond (Phase 2 of the Stock Balance Management project -
 *      docs/superpowers/specs/2026-09-09-stock-balance-management-design.md). Unlike
 *      every other tab, a transfer's row is written once at dispatch and then FILLED IN
 *      over time as it progresses (receipt, then manager approval) - so this does NOT
 *      go through the generic TABS writer in doPost (which only ever appends). Two new
 *      actions instead: 'transferDispatch' (appends the initial row, same shape as the
 *      generic writer) and 'transferUpdate' (finds the row by its RowId and updates only
 *      the named field(s) in place - same never-append, RowId-match pattern
 *      _handleAdjustRow already uses for same-day corrections on the other 4 tabs,
 *      reused here for a different purpose: normal lifecycle progression, not a
 *      correction). A human reading the Transfers tab sees ONE row per line item that
 *      gains Qty Received / Status / Receive Operator / Manager as the transfer moves
 *      through dispatch -> receipt -> approval, not three disconnected rows.
 *      Run setupSheets() (automatic - see doPost's transferDispatch handler, which calls
 *      it itself the first time the Transfers tab doesn't exist yet) - no separate
 *      applyV16Updates() needed, this is a brand new tab, not a column added to an
 *      existing one.
 *
 * v15 changes vs v14:
 *   1. REFILLS PHOTOLINKS: every other capture tab that supports a photo (Private,
 *      Received, Manifold) already had a PhotoLinks/PhotoLink column - Refills never did,
 *      even though the frontend's Refill capture flow (and syncRowsRefill) already sends
 *      a PhotoLinks value (r._photoLink) on every row. Because 'PhotoLinks' was missing
 *      from TABS.Refills, the generic writer in doPost silently dropped it - the value
 *      never reached the sheet at all. TABS.Refills and HEADERS.Refills now both gain a
 *      PhotoLinks / 'Photo Link(s)' column (placed right before RowId, matching the
 *      Private/Received layout convention). _writePhotoLinksRichText already looks up
 *      'PhotoLinks'/'PhotoLink' generically by key, so the existing "📷1, 📷2" short-link
 *      rendering applies to Refills automatically - no other code changes needed.
 *      Run applyV15Updates() ONCE after pasting - it only adds the "Photo Link(s)" header
 *      cell to the Refills tab if missing; existing rows are untouched (their PhotoLinks
 *      cell just stays blank, same as any pre-v15 row - no data was ever there to recover
 *      since the column didn't exist to hold it).
 *
 * v14 changes vs v13:
 *   1. PROTECT ROWID COLUMNS: RowId (Refills/Private/Received/Manifold) is an internal,
 *      app-managed field - no human is meant to ever type into it, and an accidental edit
 *      (blanked, retyped, or worst case matching another row's id) either quietly breaks
 *      that one row's same-day Adjustment lookup (safe - falls back to log-only, same as
 *      any pre-v13 row) or, in the rare case of an accidental duplicate, could misdirect a
 *      correction onto the wrong row. New `protectRowIdColumns()` locks each of those 4
 *      columns (the WHOLE column, not just today's rows, so future rows stay covered too)
 *      via Sheets' native range protection - explicitly strips the default editor list
 *      (simply calling .protect() leaves every existing sheet editor able to edit it,
 *      which would do nothing) so only the sheet's owner can edit it going forward; the
 *      script itself is unaffected since it runs under the deploying account's own
 *      authority (assumes the web app is deployed "Execute as: me", which it already is -
 *      if that's ever changed, the script would start hitting its own protection). Run
 *      `protectRowIdColumns()` ONCE, separately from `applyV13Updates()` (this is a
 *      permissions change, not a schema one) - safe to re-run, it checks for an existing
 *      protection on that exact column before adding another, so re-running never stacks
 *      duplicate protections. Known limits, not fixable from code: the sheet OWNER can
 *      always remove any protection regardless of this setup (Google's permission model,
 *      not something a script can override); deleting and re-inserting the column entirely
 *      sidesteps the protection since it's tied to a range, not a field concept. **Check
 *      Data > Protected sheets and ranges afterward to confirm it actually landed as
 *      intended** - worth eyeballing rather than trusting blindly.
 *
 * v13 changes vs v12:
 *   1. SAME-DAY ROW ADJUSTMENT: the app's Adjustment tool (Refill/Private/Received/
 *      Manifold, before day close) could already correct its own local copy and log an
 *      old->new+reason+who entry to the Adjustments tab, but had no way to correct the
 *      ORIGINAL row on its actual sheet tab - anyone reading Refills/Private/Received/
 *      Manifold directly still saw the uncorrected number, and the only trace of the fix
 *      was a side-note on a different tab. Fixed with a new RowId column on each of those
 *      4 tabs (a client-generated id, stamped on every row from now on by the frontend)
 *      and a new 'adjustRow' action that finds a row by that id and updates ONLY the
 *      specified field(s) IN PLACE - no new row is ever appended, so this can never
 *      produce a duplicate/double entry. A row committed before v13 has no RowId and
 *      can't be targeted this way - the frontend already handles this gracefully (local
 *      fix + Adjustments log only, exactly like before v13, with a toast explaining why
 *      the sheet row itself couldn't be updated). Run applyV13Updates() ONCE after
 *      pasting - it only adds the "Row Id" header cell to each of the 4 tabs if missing;
 *      existing rows are untouched (their RowId cell just stays blank, which is exactly
 *      the "predates row tracking" state the frontend already expects).
 *   2. RESIDUAL GAS PHOTO: Residual Gas can now carry an optional photo per cylinder
 *      (same client-side resize/upload pipeline as Received/Private/Manifold's photos),
 *      written to a new Photo Link(s) column on the ResidualGas tab, shortened to a
 *      linked "📷1" cell the same way those 3 tabs already are. applyV13Updates() also
 *      adds this header cell if missing.
 *
 * v12 changes vs v11:
 *   1. SUPPLIER<->BRANCH LINKING: Manage Suppliers can now also tick which branch(es) a
 *      supplier delivers to (Helderberg, Kleinmond, or both) - Stock Received's "Received
 *      from" dropdown and Private Refill's "Supplier Name" dropdown now only list
 *      suppliers linked to whichever branch is currently selected. A supplier with no
 *      branches ticked stays available at both (same non-breaking convention as the
 *      brand links from v10 - every existing supplier keeps working exactly as before
 *      until someone edits it and ticks a branch). Suppliers sheet gains a 9th column,
 *      "Branches" (comma-separated). Run applyV12Updates() ONCE after pasting - it only
 *      adds the header cell if missing, existing supplier rows are untouched.
 *
 * v11 changes vs v10:
 *   1. SHORT PHOTO LINKS: Received/Private/Manifold's Photo Link(s) column used to store
 *      the raw Google Drive URL (very long, and comma-joined when a row has 2-3 photos) -
 *      it made those columns unreadable and threw off the sheet's layout. Every new photo
 *      row now writes a short rich-text cell instead - "📷1", or "📷1, 📷2" for multiple -
 *      each segment individually hyperlinked to its own photo, so it's still one click to
 *      open, just not a wall of text. Purely a display change - the app's own copy of the
 *      links (photoLinks in the app's local store) is untouched, and this doesn't touch
 *      what the app sends over the wire, only how the cell is rendered once it lands.
 *      Run applyV11Updates() ONCE if you also want EXISTING rows' photo links shortened
 *      (optional, and safe to re-run - it only touches cells that still look like a raw
 *      http(s) link, so an already-shortened cell is left alone). New rows are shortened
 *      automatically from the moment this version is deployed, with no migration needed.
 *
 * v10 changes vs v9:
 *   1. SUPPLIER<->BRAND LINKING: Manage Suppliers can now tick which cylinder brands
 *      each supplier is allowed for (company brands for Stock Received, private brands
 *      for Private Refill's "Filled by Supplier" option). Stock Received's brand picker
 *      and Private Refill's cylinder-brand picker now only show brands linked to the
 *      currently-selected supplier - stops an operator allocating e.g. an Oryx delivery
 *      to a supplier that only ever brings Afrox. A supplier with no brands ticked stays
 *      fully unrestricted (every existing supplier, until someone edits it and ticks
 *      something), so this is non-breaking for every supplier already on file.
 *      Suppliers sheet gains an 8th column, "Brands" (comma-separated). Run
 *      applyV10Updates() ONCE after pasting - it only adds the header cell if missing,
 *      existing supplier rows are untouched (blank Brands = unrestricted, same as today).
 *
 * v9 changes vs v8:
 *   1. FAULTY OPERATOR NOTE: the app has always captured an "Operator note" on the
 *      Faulty Cylinders form and sent it as OperatorNote, but the Faulty sheet's schema
 *      never had a column for it - the value was silently dropped before it even
 *      reached the sheet. FAULTY_HEADERS gains a trailing 'OperatorNote' column,
 *      faultyLog now writes it, faultyListOpen now returns it (so it shows in the
 *      app's own Faulty Register list too, not just the sheet).
 *   2. RECON FORMATTING: v8's block-duplication (copying the 1st Supplier Received
 *      block as a template for 5 more) also copied a merged cell that existed in that
 *      template, so the merge got duplicated into every new block - visible as a
 *      misaligned/centered row. applyV9Updates() unmerges and re-normalises number
 *      formatting/alignment across the whole Supplier Received section on both branch
 *      recon sheets.
 *   3. RECEIVED RUNNING SUMMARY: adds a live, self-updating pivot table to the
 *      Received sheet itself (far right, out of the way of the raw log) showing
 *      cumulative Full In / Empty Out totals per Branch + Brand + Size, built with
 *      QUERY so it never needs manual upkeep as new rows come in.
 *
 * Run applyV9Updates() ONCE after pasting (see bottom of file for details on exactly
 * what it touches). This is on top of everything from v8 (run fixReconSheets() already
 * covered separately, if you haven't run it yet see the v8 section below).
 *
 * v8 changes vs v7: new fixReconSheets() one-off - rebuilds the Supplier Received
 *   section on the branch recon sheets to be driven by the real Supplier column
 *   instead of hardcoded brand names, and adds Faulty/Residual summary sections to
 *   both branch sheets and Daily GROUP Recon. See the v8 section near the bottom.
 *
 * v7 changes vs v6: new shared 'photoUpload' action - takes one base64 photo, saves it to
 *   Drive under "Gas Sales Photos/<branch>/<date>/<category>/", returns a view link. Used
 *   by Manifold, Received and Private capture flows at commit time. Received and Private
 *   schemas gain a PhotoLinks column (comma-separated if more than one photo); Manifold's
 *   existing PhotoLink column (already in the v3 schema, previously always blank) is now
 *   actually populated. Frontend (index.html) must send key PhotoLinks for Received/Private
 *   rows. Run setupSheets after deploy so row-1 headers are rewritten on the live sheet -
 *   this is what actually adds the new "Photo Link(s)" header cells; it only touches row 1,
 *   existing data rows are untouched.
 *
 * v6 changes vs v5: Received schema gains Supplier / Delivery Note / Invoice; Private
 *   schema gains Filled By / Supplier Name / Invoice. HEADERS updated to match
 *   Gas_Sales_Master_v14 exactly. Frontend (index.html, via Claude Code) must send these
 *   exact keys: Received -> Supplier, DeliveryNote, Invoice; Private -> FilledBy
 *   (value "Us" or "Supplier"), SupplierName, Invoice. Any key mismatch = value dropped on sync.
 *   Run setupSheets after deploy so row-1 headers are rewritten on the live sheet.
 *
 * v5 changes vs v4 (three isolated fixes, no schema change, no v13 sheet change needed):
 *   1. RESIDUAL DATE: _handleResidual wrote full datetime into the Date column, so a
 *      recon SUMIFS matching a date cell would never find residual rows. Now writes
 *      midnight into Date (Timestamp + Time still carry full time), matching every other tab.
 *   2. FAULTY ID: _nextFaultyId derived the id from row count, which collides after any
 *      row delete (two cylinders share an id; faultyUpdate hits the wrong one). Now uses
 *      max existing F-nnn + 1 - delete-safe.
 *   3. CLEARDAY GUARD: ClearDay had no restriction and could wipe Faulty/ResidualGas/
 *      Suppliers. Now whitelisted to the daily raw logs only; persistent registers survive.
 *
 * SETUP: Extensions > Apps Script > select all > delete > paste this whole file > Save >
 *        Deploy > Manage deployments > edit existing deployment > New version > Deploy.
 *        Confirm the /exec URL returns "Gas Sales v17 endpoint live".
 *        You're already on v16 live, and v17 needs NO migration function to run either -
 *        faultyListRange is a new read-only action on the existing Faulty sheet, no
 *        schema change, so there's nothing to run by hand for it.
 *        (If setting this up completely fresh: run the older one-off migrations first, in
 *        order - fixReconSheets() from v8, applyV9Updates(), applyV10Updates(),
 *        applyV11Updates(), applyV12Updates(), applyV13Updates(), protectRowIdColumns(),
 *        applyV15Updates() - v16 and v17 need nothing extra.)
 */

var SECRET = '4bV-Qd9UwxAqaImpNUzBY6AKSU6qCriJ';
var PDF_FOLDER_ID = '';
var PDF_FOLDER_NAME = 'Gas Sales Stock Counts';

// ===================== v3 (UNCHANGED) =====================

// Column ORDER per tab = the sheet schema. Keys are the app's field names.
// Timestamp/Date/Time/Branch are handled specially (built from the row). The rest map by key.
var META = ['Timestamp','Date','Time','Branch'];
// v13: RowId appended to the END of Refills/Private/Received/Manifold - a new column,
// existing column positions/order are unaffected (safe for any existing formulas that
// reference these tabs by fixed column letter). Blank on any row committed before v13.
// v15: PhotoLinks added to Refills (right before RowId), matching the Private/Received
// layout convention - existing column positions for everything before it are unaffected.
// v16: Transfers added - NOT written through the generic TABS-driven writer in doPost
// (see _handleTransferDispatch/_handleTransferUpdate), but kept in this map anyway so
// setupSheets() creates the tab with the right header row like every other tab, and so
// _handleTransferUpdate can reuse this same keys array for its RowId-match-and-update.
var TABS = {
  Counts:      ['Operator','Role','CountType','State','Size','Brand','Qty','Note','Adjusted','AdjustedBy','OverrideReason'],
  Refills:     ['Operator','Role','Size','Brand','GasType','Scale','Tare','GasLeft','Pumped','Seal','SealFlag','FlagReason','Notes','PhotoLinks','RowId'],
  Private:     ['Operator','Role','CylBrand','OtherBrand','GasType','Pumped','Customer','FilledBy','SupplierName','Invoice','PhotoLinks','RowId'],
  Received:    ['Operator','Role','Size','Brand','FullIn','EmptyOut','Note','OverrideReason','Supplier','DeliveryNote','Invoice','PhotoLinks','RowId'],
  Manifold:    ['Operator','Role','Stage','Cylinder','Brand','GasType','Scale','Tare','GasLeft','FillCheck','Note','PhotoLink','RowId'],
  DayClose:    ['Operator','Role','Authoriser','SignedOp','SignedMgr','ManifoldBalance','OverrideReason'],
  SealRange:   ['Brand','Start','End','Status','Kind','WarnAt','By','Notes'],
  Adjustments: ['Kind','Line','From','To','Reason','By'],
  ClearDay:    ['ClearTab','Areas','By','Reason'],
  PdfArchive:  ['Operator','Filename','PdfLink','CsvLink','AuditReport'],
  Transfers:   ['FromBranch','ToBranch','Size','Brand','State','QtyDispatched','QtyReceived','ShortfallReason','Note','Status','DispatchOperator','ReceiveOperator','Manager','RowId']
};
// Human-readable headers written to row 1 (must match master v16 exactly).
var HEADERS = {
  Counts:      ['Timestamp','Date','Time','Branch','Operator','Role','Count Type','State','Size','Brand','Qty','Note','Adjusted','Adjusted By','Override Reason'],
  Refills:     ['Timestamp','Date','Time','Branch','Operator','Role','Size','Brand','Gas Type','Cyl Scale (kg)','Cyl Tare (kg)','Gas Left (kg)','Pumped (kg)','Seal Nr','Seal Flag','Flag Reason','Notes','Photo Link(s)','Row Id'],
  Private:     ['Timestamp','Date','Time','Branch','Operator','Role','Cyl Brand','Other Brand','Gas Type','Pumped (kg)','Customer','Filled By','Supplier Name','Invoice','Photo Link(s)','Row Id'],
  Received:    ['Timestamp','Date','Time','Branch','Operator','Role','Size','Brand','Full In','Empty Out','Note','Override Reason','Supplier','Delivery Note','Invoice','Photo Link(s)','Row Id'],
  Manifold:    ['Timestamp','Date','Time','Branch','Operator','Role','Stage','Cylinder','Brand','Gas Type','Cyl Scale (kg)','Cyl Tare (kg)','Gas Left (kg)','Fill Check','Note','Photo Link','Row Id'],
  DayClose:    ['Timestamp','Date','Time','Branch','Operator','Role','Authoriser','Signed Op','Signed Mgr','Manifold Balance','Override Reason'],
  SealRange:   ['Timestamp','Date','Time','Branch','Brand','Start','End','Status','Kind','Warn At','By','Notes'],
  Adjustments: ['Timestamp','Date','Time','Branch','Kind','Line','From','To','Reason','By'],
  ClearDay:    ['Timestamp','Date','Time','Branch','Clear Tab','Areas','By','Reason'],
  PdfArchive:  ['Timestamp','Date','Time','Branch','Operator','Filename','PDF Link','CSV Link','Audit Report'],
  Transfers:   ['Timestamp','Date','Time','Branch','From Branch','To Branch','Size','Brand','State','Qty Dispatched','Qty Received','Shortfall Reason','Note','Status','Dispatch Operator','Receive Operator','Manager','Row Id']
};

function _ss(){ return SpreadsheetApp.getActiveSpreadsheet(); }

function setupSheets(){
  var ss=_ss();
  Object.keys(HEADERS).forEach(function(name){
    var sh=ss.getSheetByName(name)||ss.insertSheet(name);
    var h=HEADERS[name];
    sh.getRange(1,1,1,h.length).setValues([h]).setFontWeight('bold');
    sh.setFrozenRows(1);
    // format the timestamp/date/time columns
    sh.getRange('A2:A').setNumberFormat('d mmm hh:mm');
    sh.getRange('B2:B').setNumberFormat('d mmm yyyy');
    sh.getRange('C2:C').setNumberFormat('hh:mm');
  });
  _faultySheet();     // new in v4 - safe to call every time, no-ops if already set up
  _residualSheet();   // new in v4
  _suppliersSheet();  // new in v4
}

function _pdfFolder(){
  if(PDF_FOLDER_ID) return DriveApp.getFolderById(PDF_FOLDER_ID);
  var it=DriveApp.getFoldersByName(PDF_FOLDER_NAME);
  return it.hasNext()?it.next():DriveApp.createFolder(PDF_FOLDER_NAME);
}

// build the META front block (Timestamp, Date, Time, Branch) from a row object
function _metaCells(r){
  var now = r.ts ? new Date(r.ts) : new Date();
  var dOnly = r.date ? new Date(r.date+'T00:00:00') : now;
  return [ now, dOnly, now, (r.branch||'') ];
}

function doPost(e){
  try{
    var body=JSON.parse(e.postData.contents);
    if(body.token!==SECRET) return _json({ok:false,error:'bad token'});
    var type=body.type;

    // ===================== v4 NEW: Faulty Cylinders / Residual Gas / Suppliers =====================
    // Each block below is fully self-contained (own sheet, own helpers). None of them touch
    // the generic TABS map or any existing tab.
    if(type==='faultyLog'||type==='faultyListOpen'||type==='faultyUpdate'){
      return _handleFaulty(type, body);
    }
    // ===================== v17 NEW: FAULTY CYLINDERS - DATE-RANGE READ =====================
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
    // ===================== end v17 NEW =====================
    if(type==='residualLog'){
      return _handleResidual(body);
    }
    if(type==='suppliersList'||type==='suppliersSave'||type==='suppliersRemove'){
      return _handleSuppliers(type, body);
    }
    // ===================== end v4 NEW =====================

    // ===================== v7 NEW: PHOTO UPLOAD =====================
    // Shared by Manifold / Received / Private capture flows. One base64 photo in, one
    // Drive file out. Doesn't touch the generic TABS map - the caller writes the returned
    // url into its own row (PhotoLinks / PhotoLink) via the normal Received/Private/Manifold
    // sync below.
    if(type==='photoUpload'){
      return _handlePhotoUpload(body);
    }
    // ===================== end v7 NEW =====================

    // ===================== v13 NEW: SAME-DAY ROW ADJUSTMENT =====================
    // Finds a Refills/Private/Received/Manifold row by its RowId and updates ONLY the
    // named field(s) in place - never appends, so this can never create a double entry.
    if(type==='adjustRow'){
      return _handleAdjustRow(body);
    }
    // ===================== end v13 NEW =====================

    // ===================== v16 NEW: BRANCH TRANSFERS =====================
    // One row per transfer line item, created at dispatch, filled in over time via
    // transferUpdate (mirrors _handleAdjustRow's RowId-match-and-update-in-place pattern
    // above) rather than appending new rows for receipt/approval - a human reading the
    // Transfers tab sees one row per line item that gains Qty Received / Status /
    // Receive Operator / Manager as the transfer progresses, not three disconnected rows.
    if(type==='transferDispatch'){
      return _handleTransferDispatch(body);
    }
    if(type==='transferUpdate'){
      return _handleTransferUpdate(body);
    }
    // ===================== end v16 NEW =====================

    // ---- PDF ARCHIVE (base64 -> Drive) ----
    if(type==='PdfArchive'){
      var rows=body.rows||[body.row];
      var folder=_pdfFolder();
      var sh=_ss().getSheetByName('PdfArchive')||_ss().insertSheet('PdfArchive');
      if(sh.getLastRow()===0) setupSheets();
      var out=rows.map(function(r){
        var link='';
        if(r.PdfBase64){
          var blob=Utilities.newBlob(Utilities.base64Decode(r.PdfBase64),'application/pdf',r.Filename||'StockCount.pdf');
          var f=folder.createFile(blob);
          f.setSharing(DriveApp.Access.ANYONE_WITH_LINK,DriveApp.Permission.VIEW);
          link=f.getUrl();
        }
        return _metaCells(r).concat([r.Operator||'', r.Filename||'', link, r.CsvLink||'', r.AuditReport||'']);
      });
      sh.getRange(sh.getLastRow()+1,1,out.length,out[0].length).setValues(out);
      return _json({ok:true,wrote:out.length});
    }

    // ---- CLEAR DAY (delete matching date+branch rows) ----
    if(type==='ClearDay'){
      var rows0=body.rows||[body.row]; var deleted=0;
      // ClearDay may ONLY wipe the daily raw logs. Faulty/ResidualGas/Suppliers are
      // persistent registers and must survive a day-close. Anything not whitelisted is refused.
      var CLEARABLE={Counts:1,Refills:1,Private:1,Received:1,Manifold:1,DayClose:1,SealRange:1,Adjustments:1,PdfArchive:1};
      rows0.forEach(function(r){
        var tab=r.ClearTab; if(!tab) return;
        if(!CLEARABLE[tab]) return; // refuse Faulty / ResidualGas / Suppliers / Transfers / unknown tabs
        var sh0=_ss().getSheetByName(tab); if(!sh0) return;
        var last0=sh0.getLastRow(); if(last0<2) return;
        var vals0=sh0.getRange(2,1,last0-1,META.length).getValues();
        for(var i=vals0.length-1;i>=0;i--){
          var dCell=vals0[i][1], bCell=vals0[i][3];
          var dStr=(dCell instanceof Date)?Utilities.formatDate(dCell,Session.getScriptTimeZone(),'yyyy-MM-dd'):String(dCell);
          if(String(dStr)===String(r.date)&&String(bCell)===String(r.branch)){ sh0.deleteRow(i+2); deleted++; }
        }
      });
      // log the clear event
      var lg=_ss().getSheetByName('ClearDay')||_ss().insertSheet('ClearDay');
      if(lg.getLastRow()===0) setupSheets();
      rows0.forEach(function(r){
        lg.appendRow(_metaCells(r).concat([r.ClearTab||'', r.Areas||'', r.By||'', r.Reason||'']));
      });
      return _json({ok:true,deleted:deleted});
    }

    // ---- GENERIC TABS ----
    if(!TABS[type]) return _json({ok:false,error:'unknown type: '+type});
    var ss=_ss();
    var sh=ss.getSheetByName(type)||ss.insertSheet(type);
    if(sh.getLastRow()===0) setupSheets();
    var rows2=body.rows||[body.row];

    // REPLACE-SET (counts etc.): clear this date+branch first
    if(rows2.length && rows2[0]._replaceKey){
      var rk=String(rows2[0]._replaceKey).split('|'); var rDate=rk[0], rBranch=rk[1];
      var last=sh.getLastRow();
      if(last>1){
        var vals=sh.getRange(2,1,last-1,META.length).getValues();
        for(var i=vals.length-1;i>=0;i--){
          var dC=vals[i][1], bC=vals[i][3];
          var dS=(dC instanceof Date)?Utilities.formatDate(dC,Session.getScriptTimeZone(),'yyyy-MM-dd'):String(dC);
          if(String(dS)===String(rDate)&&String(bC)===String(rBranch)) sh.deleteRow(i+2);
        }
      }
      rows2.forEach(function(r){ delete r._replaceKey; });
    }

    var keys=TABS[type];
    var out2=rows2.map(function(r){
      var line=_metaCells(r);
      keys.forEach(function(k){ line.push(r[k]!==undefined?r[k]:''); });
      return line;
    });
    var startRow=sh.getLastRow()+1;
    sh.getRange(startRow,1,out2.length,out2[0].length).setValues(out2);
    _writePhotoLinksRichText(sh, startRow, rows2, keys); // v11: shorten Photo Link(s)/Photo Link cell if this tab has one
    return _json({ok:true,wrote:out2.length});
  }catch(err){
    return _json({ok:false,error:String(err)});
  }
}

// ===================== v11 NEW: SHORT PHOTO LINKS =====================
// Replaces a just-written row's raw comma-joined Drive URL(s) with a short rich-text cell
// - "📷1" for one photo, "📷1, 📷2" for two, etc - each segment still individually
// hyperlinked to its own photo. No-ops instantly (before touching the sheet at all) for any
// tab whose TABS[] schema has no PhotoLinks/PhotoLink key, so this is safe to call for every
// generic-tab write. (v15: this already covers Refills automatically now that TABS.Refills
// includes 'PhotoLinks' - no changes needed in this function.)
function _writePhotoLinksRichText(sh, startRow, rows2, keys){
  var photoKeyIdx=keys.indexOf('PhotoLinks');
  if(photoKeyIdx===-1) photoKeyIdx=keys.indexOf('PhotoLink');
  if(photoKeyIdx===-1) return;
  var col=META.length+photoKeyIdx+1; // 1-based column number in the sheet
  rows2.forEach(function(r,i){
    var raw=String((r.PhotoLinks!==undefined?r.PhotoLinks:r.PhotoLink)||'');
    var urls=raw.split(',').map(function(u){return u.trim();}).filter(Boolean);
    if(!urls.length) return; // nothing to shorten, leave the blank cell as-is
    var rt=_photoLinksRichText(urls);
    sh.getRange(startRow+i, col).setRichTextValue(rt);
  });
}
function _photoLinksRichText(urls){
  var segs=urls.map(function(u,idx){return '📷'+(idx+1);});
  var builder=SpreadsheetApp.newRichTextValue().setText(segs.join(', '));
  var pos=0;
  segs.forEach(function(seg,idx){
    builder.setLinkUrl(pos, pos+seg.length, urls[idx]);
    pos+=seg.length+2; // +2 for the ", " separator before the next segment
  });
  return builder.build();
}

function doGet(){ return _json({ok:true,msg:'Gas Sales v17 endpoint live'}); }
function _json(o){ return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

// ===================== v4 NEW (v9: gains OperatorNote): FAULTY CYLINDERS =====================
// Sheet "Faulty" columns:
//   ID | Timestamp | Branch | Operator | Brand | Size | Qty | State | SealNumber |
//   FaultReason | FaultDetail | CylScale | CylTare | GasRemaining | Nominal | GasLoss |
//   Status | UpliftDN | ReturnDN | DateClosed | OperatorNote
//
// - faultyLog: appends a row, Status starts 'Faulty-Held'. GasLoss stays blank until closed.
// - faultyListOpen: returns rows where Status is not Replaced/Not Replaced.
// - faultyUpdate: updates Status/UpliftDN/ReturnDN by id. Setting Status to Replaced or
//   Not Replaced stamps DateClosed; Not Replaced also finalises GasLoss = max(0, Nominal - GasRemaining)
//   (the actual booked loss - Replaced never books a loss).
var FAULTY_HEADERS = ['ID','Timestamp','Branch','Operator','Brand','Size','Qty','State','SealNumber','FaultReason','FaultDetail','CylScale','CylTare','GasRemaining','Nominal','GasLoss','Status','UpliftDN','ReturnDN','DateClosed','OperatorNote'];
var FAULTY_NOMINAL = {'5kg':5,'9kg':9,'12kg':12,'14kg':14,'19kg':19,'48kg-SV':48,'48kg-DV':48,'14kg-FLT':14,'19kg-FLT':19,'8kg-Prop':8,'18kg-Prop':18,'45kg-Prop-SV':45,'45kg-Prop-DV':45};

function _faultySheet(){
  var ss=_ss();
  var sh=ss.getSheetByName('Faulty');
  if(!sh){
    sh=ss.insertSheet('Faulty');
    sh.getRange(1,1,1,FAULTY_HEADERS.length).setValues([FAULTY_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}
function _nextFaultyId(sh){
  // Derive the next id from the HIGHEST existing F-nnn, not the row count.
  // Row-count IDs collide after a row is deleted (two cylinders share an id, and
  // faultyUpdate then hits the wrong one). Scanning the max suffix is delete-safe.
  var last=sh.getLastRow();
  var maxN=0;
  if(last>1){
    var ids=sh.getRange(2,1,last-1,1).getValues();
    for(var i=0;i<ids.length;i++){
      var m=String(ids[i][0]||'').match(/^F-(\d+)$/);
      if(m){ var n=parseInt(m[1],10); if(n>maxN) maxN=n; }
    }
  }
  return 'F-'+String(maxN+1).padStart(3,'0');
}
function _findFaultyRow(sh,id){
  var last=sh.getLastRow();
  if(last<2) return null;
  var vals=sh.getRange(2,1,last-1,FAULTY_HEADERS.length).getValues();
  for(var i=0;i<vals.length;i++){ if(String(vals[i][0])===String(id)) return {rowIndex:i+2, data:vals[i]}; }
  return null;
}
function _handleFaulty(type, body){
  var sh=_faultySheet();

  if(type==='faultyLog'){
    var r=body.row||{};
    var id=_nextFaultyId(sh);
    var scale=Number(r.CylScale)||0, tare=Number(r.CylTare)||0;
    var gasRemaining=Math.max(0, scale-tare);
    var nominal=FAULTY_NOMINAL[r.Size]||0;
    sh.appendRow([id, new Date(), r.Branch||'', r.Operator||body.caller||'', r.Brand||'', r.Size||'', r.Qty||1, r.State||'',
      r.SealNumber||'', r.FaultReason||'', r.FaultDetail||'', scale, tare, gasRemaining, nominal, '', 'Faulty-Held', '', '', '', r.OperatorNote||'']);
    return _json({ok:true, id:id});
  }

  if(type==='faultyListOpen'){
    var last=sh.getLastRow();
    if(last<2) return _json({ok:true, rows:[]});
    var vals=sh.getRange(2,1,last-1,FAULTY_HEADERS.length).getValues();
    var rows=vals.filter(function(row){
      var status=row[16];
      return status!=='Replaced' && status!=='Not Replaced';
    }).map(function(row){
      return {
        id:row[0], Branch:row[2], Brand:row[4], Size:row[5], Qty:row[6],
        FaultReason:row[9], FaultDetail:row[10], GasLoss:row[15], Status:row[16],
        UpliftDN:row[17], ReturnDN:row[18], OperatorNote:row[20]
      };
    });
    return _json({ok:true, rows:rows});
  }

  if(type==='faultyUpdate'){
    var hit=_findFaultyRow(sh, body.id);
    if(!hit) return _json({ok:false, error:'faulty row not found: '+body.id});
    var status=body.status||hit.data[16];
    var nominal=hit.data[14], gasRemaining=hit.data[13];
    var closing=(status==='Replaced'||status==='Not Replaced');
    var gasLoss=hit.data[15];
    if(status==='Not Replaced') gasLoss=Math.max(0, Number(nominal)-Number(gasRemaining));
    if(status==='Replaced') gasLoss=0;
    sh.getRange(hit.rowIndex,16,1,1).setValue(gasLoss);          // GasLoss
    sh.getRange(hit.rowIndex,17,1,1).setValue(status);           // Status
    sh.getRange(hit.rowIndex,18,1,1).setValue(body.upliftDN||''); // UpliftDN
    sh.getRange(hit.rowIndex,19,1,1).setValue(body.returnDN||''); // ReturnDN
    if(closing) sh.getRange(hit.rowIndex,20,1,1).setValue(new Date()); // DateClosed
    return _json({ok:true});
  }

  return _json({ok:false, error:'unknown faulty action: '+type});
}

// ===================== v17 NEW: FAULTY CYLINDERS - DATE-RANGE READ =====================
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

// ===================== v4 NEW: RESIDUAL GAS (v13: gains PhotoLinks) =====================
// Sheet "ResidualGas" columns: Timestamp | Date | Time | Branch | Operator | Role |
//   Brand | Size | GasType | CylScale | CylTare | Residual | Note | Photo Link(s)
// Model A: daily input, no lifecycle. residualLog appends one row per cylinder in the batch.
// RESIDUAL_KEYS (v13) mirrors the generic TABS[] shape (field names, in column order, AFTER
// the META block) purely so _writePhotoLinksRichText() - built for the generic TABS writer -
// can be reused here too, even though this handler is otherwise hand-rolled, not routed
// through the generic writer.
var RESIDUAL_HEADERS = ['Timestamp','Date','Time','Branch','Operator','Role','Brand','Size','GasType','CylScale','CylTare','Residual','Note','Photo Link(s)'];
var RESIDUAL_KEYS = ['Operator','Role','Brand','Size','GasType','CylScale','CylTare','Residual','Note','PhotoLinks'];

function _residualSheet(){
  var ss=_ss();
  var sh=ss.getSheetByName('ResidualGas');
  if(!sh){
    sh=ss.insertSheet('ResidualGas');
    sh.getRange(1,1,1,RESIDUAL_HEADERS.length).setValues([RESIDUAL_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}
function _handleResidual(body){
  var sh=_residualSheet();
  var rows=body.rows||[];
  if(!rows.length) return _json({ok:false, error:'no rows'});
  var now=new Date();
  // Date column must be midnight-only so recon SUMIFS (which match a date cell) find these rows.
  // Timestamp + Time keep the full time for audit. Mirrors _metaCells behaviour on every other tab.
  var dOnly=new Date(now.getFullYear(), now.getMonth(), now.getDate());
  var out=rows.map(function(r){
    var scale=Number(r.CylScale)||0, tare=Number(r.CylTare)||0;
    var residual=Math.max(0, scale-tare);
    return [now, dOnly, now, r.Branch||'', r.Operator||body.caller||'', r.Role||'', r.Brand||'', r.Size||'', r.GasType||'', scale, tare, residual, r.Note||'', r.PhotoLinks||''];
  });
  var startRow=sh.getLastRow()+1;
  sh.getRange(startRow,1,out.length,out[0].length).setValues(out);
  _writePhotoLinksRichText(sh, startRow, rows, RESIDUAL_KEYS); // shortens the raw comma-joined URL(s) into linked "📷1, 📷2" cells, same as Received/Private/Manifold
  return _json({ok:true, wrote:out.length});
}

// ===================== v4 NEW: SUPPLIERS (Manage Suppliers / Stock Received / Private Refill) =====================
// Sheet "Suppliers" columns: Name | Type | Active | CreatedBy | CreatedAt | UpdatedBy | UpdatedAt | Brands | Branches
// - suppliersList: any user, active-only.
// - suppliersSave: no oldName -> add (or reactivate a soft-removed row with the same
//   name, so remove+re-add never creates a duplicate). oldName present -> rename/retype.
// - suppliersRemove: soft-remove by default (Active=false, row + name stay for any old
//   records that reference it). hard:true actually deletes the row.
// - v10: 8th column "Brands" - comma-separated list of cylinder brands (company brands
//   for Received, private brands for Private Refill) this supplier is linked to. Blank =
//   unrestricted (every pre-v10 supplier), so this is purely additive/opt-in.
// - v12: 9th column "Branches" - comma-separated (e.g. "Helderberg" or
//   "Helderberg,Kleinmond"). Blank = available at both branches (same
//   unrestricted-by-default convention as Brands).
function _suppliersSheet(){
  var ss=_ss();
  var sh=ss.getSheetByName('Suppliers');
  if(!sh){
    sh=ss.insertSheet('Suppliers');
    sh.getRange(1,1,1,9).setValues([['Name','Type','Active','CreatedBy','CreatedAt','UpdatedBy','UpdatedAt','Brands','Branches']]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}
function _findSupplierRow(sh,name){
  var last=sh.getLastRow();
  if(last<2) return null;
  var vals=sh.getRange(2,1,last-1,9).getValues();
  var target=String(name||'').trim().toLowerCase();
  for(var i=0;i<vals.length;i++){
    if(String(vals[i][0]||'').trim().toLowerCase()===target) return {rowIndex:i+2, data:vals[i]};
  }
  return null;
}
function _handleSuppliers(type, body){
  var sh=_suppliersSheet();
  var now=new Date();
  var caller=body.caller||'';

  if(type==='suppliersList'){
    var last=sh.getLastRow();
    if(last<2) return _json({ok:true, suppliers:[]});
    var vals=sh.getRange(2,1,last-1,9).getValues();
    var suppliers=vals.filter(function(row){ return row[0] && row[2]===true; })
      .map(function(row){ return {name:row[0], type:row[1]||'',
        brands:String(row[7]||'').split(',').map(function(b){return b.trim();}).filter(Boolean),
        branches:String(row[8]||'').split(',').map(function(b){return b.trim();}).filter(Boolean)}; });
    return _json({ok:true, suppliers:suppliers});
  }

  if(type==='suppliersSave'){
    var name=String(body.name||'').trim();
    if(!name) return _json({ok:false, error:'name required'});
    var stype=String(body.supplierType||'');
    var brands=String(body.brands||''); // comma-joined, sent as-is by the frontend
    var branches=String(body.branches||''); // comma-joined, sent as-is by the frontend
    var oldName=body.oldName?String(body.oldName).trim():'';

    if(oldName){
      var editHit=_findSupplierRow(sh,oldName);
      if(!editHit) return _json({ok:false, error:'supplier not found: '+oldName});
      sh.getRange(editHit.rowIndex,1,1,9).setValues([[name, stype, true, editHit.data[3]||caller, editHit.data[4]||now, caller, now, brands, branches]]);
      return _json({ok:true, mode:'edit'});
    }

    var existing=_findSupplierRow(sh,name);
    if(existing){
      if(existing.data[2]===true) return _json({ok:false, error:'a supplier named "'+name+'" already exists'});
      sh.getRange(existing.rowIndex,1,1,9).setValues([[name, stype, true, existing.data[3]||caller, existing.data[4]||now, caller, now, brands, branches]]);
      return _json({ok:true, mode:'add'});
    }
    sh.appendRow([name, stype, true, caller, now, caller, now, brands, branches]);
    return _json({ok:true, mode:'add'});
  }

  if(type==='suppliersRemove'){
    var rname=String(body.name||'').trim();
    if(!rname) return _json({ok:false, error:'name required'});
    var hit=_findSupplierRow(sh,rname);
    if(!hit) return _json({ok:false, error:'supplier not found: '+rname});
    if(body.hard===true){
      sh.deleteRow(hit.rowIndex);
    } else {
      sh.getRange(hit.rowIndex,3,1,1).setValue(false);
      sh.getRange(hit.rowIndex,6,1,2).setValues([[caller, now]]);
    }
    return _json({ok:true});
  }

  return _json({ok:false, error:'unknown suppliers action: '+type});
}

// ===================== v7 NEW: PHOTO UPLOAD (shared by Manifold / Received / Private) =====================
// One base64 photo in -> one Drive file out. The app calls this once per photo at commit
// time, then writes the returned link(s) into the row it pushes to the relevant tab
// (Manifold.PhotoLink / Received.PhotoLinks / Private.PhotoLinks - comma-separated if >1).
// Folder layout in Drive: "Gas Sales Photos" / <branch> / <yyyy-mm-dd> / <category> / <file>
// Sharing: same scheme as PdfArchive - ANYONE_WITH_LINK / VIEW (link-only, not publicly
// listed or searchable - matches the sharing your daily PDF reports already use).
var PHOTO_ROOT_FOLDER_NAME = 'Gas Sales Photos';

function _photoFolder(branch, dateStr, category){
  function child(parent, name){
    var it = parent.getFoldersByName(name);
    return it.hasNext() ? it.next() : parent.createFolder(name);
  }
  var rootIt = DriveApp.getFoldersByName(PHOTO_ROOT_FOLDER_NAME);
  var root = rootIt.hasNext() ? rootIt.next() : DriveApp.createFolder(PHOTO_ROOT_FOLDER_NAME);
  var byBranch = child(root, branch || 'Unknown');
  var byDate = child(byBranch, dateStr || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'));
  return child(byDate, category || 'Other');
}

function _handlePhotoUpload(body){
  if(!body.dataBase64) return _json({ok:false, error:'no image data'});
  var mime = body.mimeType || 'image/jpeg';
  var ext = mime.indexOf('png')>-1 ? 'png' : 'jpg';
  var branch = body.branch || 'Unknown';
  var dateStr = body.date || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var category = body.category || 'Other'; // 'Received' | 'Private' | 'Manifold' | 'Refill'
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'HHmmss');
  var filename = category+'_'+branch+'_'+dateStr+'_'+stamp+'_'+Math.floor(Math.random()*1000)+'.'+ext;
  try{
    var blob = Utilities.newBlob(Utilities.base64Decode(body.dataBase64), mime, filename);
    var f = _photoFolder(branch, dateStr, category).createFile(blob);
    f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return _json({ok:true, url:f.getUrl()});
  }catch(err){
    return _json({ok:false, error:String(err)});
  }
}

// ===================== v13 NEW: SAME-DAY ROW ADJUSTMENT =====================
// body: {sheet:'Refills'|'Private'|'Received'|'Manifold', rowId:'<the row's RowId>',
//        updates:{FieldName:newValue, ...}}
// Finds the row whose RowId column matches, then updates ONLY the named field(s) - every
// other cell in that row (Timestamp, Operator, everything not named in `updates`) is left
// exactly as it was. Never appends a row, so this can never create a double entry - if the
// id isn't found (row predates v13, wrong id, row was since deleted from the sheet by
// someone) this returns ok:false with a reason instead of silently doing nothing, so the
// frontend can tell the user the sheet row itself wasn't touched (their local copy + the
// Adjustments-tab log still went through regardless - this only affects whether the
// ORIGINAL row also got corrected).
function _handleAdjustRow(body){
  var tab=body.sheet;
  if(!TABS[tab]) return _json({ok:false,error:'unknown sheet: '+tab});
  var keys=TABS[tab];
  var ridIdx=keys.indexOf('RowId');
  if(ridIdx===-1) return _json({ok:false,error:'sheet "'+tab+'" has no RowId column - run applyV13Updates() first'});
  if(!body.rowId) return _json({ok:false,error:'no rowId supplied'});
  var sh=_ss().getSheetByName(tab);
  if(!sh) return _json({ok:false,error:'sheet not found: '+tab});
  var last=sh.getLastRow();
  if(last<2) return _json({ok:false,error:'row not found (sheet is empty): '+body.rowId});
  var ridCol=META.length+ridIdx+1; // 1-based RowId column
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
    if(kIdx===-1) return; // unknown field name for this tab - ignore it, don't fail the whole request over it
    var cellCol=META.length+kIdx+1;
    sh.getRange(rowIndex,cellCol).setValue(updates[k]);
    applied.push(k);
  });
  if(applied.length===0) return _json({ok:false,error:'none of the given field names matched this sheet\'s columns'});
  return _json({ok:true, rowIndex:rowIndex, applied:applied});
}

// ===================== v16 NEW: BRANCH TRANSFERS =====================
// body (transferDispatch): {rows:[{ts,date,branch,FromBranch,ToBranch,Size,Brand,State,
//   QtyDispatched,QtyReceived,ShortfallReason,Note,Status,DispatchOperator,
//   ReceiveOperator,Manager,RowId}, ...]} - one row per line item, all sharing the same
// RowId is NOT how these are grouped (each line item gets its OWN RowId, generated
// client-side per line, matching how the frontend's row objects work everywhere else in
// this file) - a multi-line transfer just means multiple independent appended rows, each
// individually updatable later via its own RowId.
function _handleTransferDispatch(body){
  var rows=body.rows||[];
  if(!rows.length) return _json({ok:false,error:'no rows'});
  var sh=_ss().getSheetByName('Transfers');
  if(!sh||sh.getLastRow()===0){ setupSheets(); sh=_ss().getSheetByName('Transfers'); }
  var keys=TABS.Transfers;
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
// appends, so this can never double a line) - kept as its own function rather than routed
// through _handleAdjustRow because Transfers isn't written through the generic TABS
// writer (transferDispatch writes it directly, see above) even though it shares the same
// TABS.Transfers keys array for column lookup.
function _handleTransferUpdate(body){
  if(!body.rowId) return _json({ok:false,error:'no rowId supplied'});
  var sh=_ss().getSheetByName('Transfers');
  if(!sh) return _json({ok:false,error:'Transfers sheet not found'});
  var keys=TABS.Transfers;
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

// ===================== v8 NEW: RECON SHEET AUTO-FIX =====================
// fixReconSheets() - if you already ran this from v8, DO NOT run it again (see the
// warning in its own comment below - it inserts rows, running it twice duplicates
// blocks). Only run it if you're setting this up fresh and haven't run it before.
//
// It will:
//  1. Rebuild the "Supplier Received" blocks on Daily Recon HB and Daily Recon KM so
//     they're driven by the real Supplier column (Received!M) instead of the old
//     hardcoded Brand names - and expand from 1-2 named blocks to 6, so new suppliers
//     just show up on their own with no sheet editing ever again.
//  2. Add small "Faulty Cylinders" and "Residual Gas" summary sections to both branch
//     sheets and to Daily GROUP Recon.
//
// Safe to inspect before running - it only touches the Supplier Received block rows
// (which are currently blank formulas/labels anyway) and appends new rows at the
// bottom. It does NOT touch Opening/Closing, Refills, Private, Manifold Balance, or
// Seal Register sections.
//
// Run this AT MOST ONCE. It's a one-time migration, not something to re-run - running
// it twice would insert a second set of supplier blocks. If something looks wrong
// after running it, stop and message Claude rather than running it again.

function fixReconSheets(){
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var hb = ss.getSheetByName('Daily Recon HB');
  var km = ss.getSheetByName('Daily Recon KM');
  var group = ss.getSheetByName('Daily GROUP Recon');
  if(!hb || !km) throw new Error('Could not find "Daily Recon HB" / "Daily Recon KM" - check the tab names match exactly.');

  _fixSupplierReceivedBlocks(hb, 'Helderberg', 44, 1);   // HB currently has 1 named block (Afrox) + 1 Other block
  _fixSupplierReceivedBlocks(km, 'Kleinmond', 44, 2);    // KM currently has 2 named blocks (Afrox, Oryx) + 1 Other block

  _addFaultyResidualSummary(hb, ['Helderberg']);
  _addFaultyResidualSummary(km, ['Kleinmond']);
  if(group) _addFaultyResidualSummary(group, ['Helderberg','Kleinmond']);

  SpreadsheetApp.flush();
}

// Rebuilds a branch recon sheet's "Supplier Received" section starting at
// firstHeaderRow (the current 1st named block's header cell, column A) into
// TOTAL_BLOCKS named blocks (dynamic, auto-picking whichever suppliers had a
// delivery that day) followed by one "Other" block (rows with no Supplier recorded).
function _fixSupplierReceivedBlocks(sh, branch, firstHeaderRow, existingNamedBlocks){
  var BLOCK_SPAN = 16;   // rows from one block's header to the next block's header
  var SIZE_ROWS = 13;    // size rows per block
  var TOTAL_BLOCKS = 6;  // named supplier blocks before the "Other" catch-all

  var otherHeaderRow = firstHeaderRow + existingNamedBlocks * BLOCK_SPAN;
  var blocksToAdd = TOTAL_BLOCKS - existingNamedBlocks;

  if(blocksToAdd > 0){
    var templateRange = sh.getRange(firstHeaderRow, 1, BLOCK_SPAN, 8); // block 1, cols A-H
    for(var i=0;i<blocksToAdd;i++){
      sh.insertRowsBefore(otherHeaderRow, BLOCK_SPAN);
      templateRange.copyTo(sh.getRange(otherHeaderRow, 1, BLOCK_SPAN, 8));
      otherHeaderRow += BLOCK_SPAN;
    }
  }

  // Named blocks 1..TOTAL_BLOCKS: dynamic header + per-size Full In/Empty Out/Delta
  for(var b=1;b<=TOTAL_BLOCKS;b++){
    var headerRow = firstHeaderRow + (b-1)*BLOCK_SPAN;
    var hdr = sh.getRange(headerRow,1);
    hdr.setFormula('=IFERROR(INDEX(SORT(UNIQUE(FILTER(Received!$M:$M,Received!$D:$D="'+branch+'",Received!$B:$B=$B$2,Received!$M:$M<>""))),'+b+'),"")');
    var sizeStart = headerRow+2;
    for(var r=0;r<SIZE_ROWS;r++){
      var row = sizeStart+r;
      var sz = sh.getRange(row,1).getValue(); // Size label already sitting in col A from the template copy
      sh.getRange(row,3).setFormula('=IF($A$'+headerRow+'="","",SUMIFS(Received!$I:$I,Received!$D:$D,"'+branch+'",Received!$B:$B,$B$2,Received!$G:$G,"'+sz+'",Received!$M:$M,$A$'+headerRow+'))');
      sh.getRange(row,4).setFormula('=IF($A$'+headerRow+'="","",SUMIFS(Received!$J:$J,Received!$D:$D,"'+branch+'",Received!$B:$B,$B$2,Received!$G:$G,"'+sz+'",Received!$M:$M,$A$'+headerRow+'))');
      sh.getRange(row,5).setFormula('=IF(C'+row+'="","",C'+row+'-D'+row+')');
    }
  }

  // "Other" block = deliveries with no Supplier recorded (legacy rows, or a gap)
  var otherRow = firstHeaderRow + TOTAL_BLOCKS*BLOCK_SPAN;
  sh.getRange(otherRow,1).setValue('Other (no supplier recorded)');
  var otherSizeStart = otherRow+2;
  for(var r2=0;r2<SIZE_ROWS;r2++){
    var row2 = otherSizeStart+r2;
    var sz2 = sh.getRange(row2,1).getValue();
    sh.getRange(row2,3).setFormula('=SUMIFS(Received!$I:$I,Received!$D:$D,"'+branch+'",Received!$B:$B,$B$2,Received!$G:$G,"'+sz2+'",Received!$M:$M,"")');
    sh.getRange(row2,4).setFormula('=SUMIFS(Received!$J:$J,Received!$D:$D,"'+branch+'",Received!$B:$B,$B$2,Received!$G:$G,"'+sz2+'",Received!$M:$M,"")');
    sh.getRange(row2,5).setFormula('=C'+row2+'-D'+row2);
  }
}

// Appends Faulty Cylinders + Residual Gas summary blocks at the bottom of the sheet.
// branches: ['Helderberg'] for a single-branch sheet, ['Helderberg','Kleinmond'] for
// the group sheet (sums both).
function _addFaultyResidualSummary(sh, branches){
  function branchTerm(colRange, br){ return '('+colRange+'="'+br+'")'; }
  function sumAcrossBranches(makeFormula){
    return branches.map(makeFormula).join('+');
  }

  var r = sh.getLastRow() + 3;
  sh.getRange(r,1).setValue('FAULTY CYLINDERS (today)').setFontWeight('bold');
  r++;
  sh.getRange(r,1).setValue('Logged today:');
  sh.getRange(r,2).setFormula('='+sumAcrossBranches(function(br){
    return 'SUMPRODUCT('+branchTerm('Faulty!$C$2:$C$5000',br)+'*(INT(Faulty!$B$2:$B$5000)=$B$2))';
  }));
  r++;
  sh.getRange(r,1).setValue('Still open (any date):');
  sh.getRange(r,2).setFormula('='+sumAcrossBranches(function(br){
    return 'SUMPRODUCT('+branchTerm('Faulty!$C$2:$C$5000',br)+'*(Faulty!$Q$2:$Q$5000<>"Replaced")*(Faulty!$Q$2:$Q$5000<>"Not Replaced")*(Faulty!$C$2:$C$5000<>""))';
  }));
  r++;
  sh.getRange(r,1).setValue('Closed today:');
  sh.getRange(r,2).setFormula('='+sumAcrossBranches(function(br){
    return 'SUMPRODUCT('+branchTerm('Faulty!$C$2:$C$5000',br)+'*(INT(Faulty!$T$2:$T$5000)=$B$2))';
  }));
  r++;
  sh.getRange(r,1).setValue('Gas loss booked today (kg):');
  sh.getRange(r,2).setFormula('='+sumAcrossBranches(function(br){
    return 'SUMPRODUCT('+branchTerm('Faulty!$C$2:$C$5000',br)+'*(INT(Faulty!$T$2:$T$5000)=$B$2)*(Faulty!$P$2:$P$5000))';
  }));

  r += 2;
  sh.getRange(r,1).setValue('RESIDUAL GAS (today)').setFontWeight('bold');
  r++;
  sh.getRange(r,1).setValue('Cylinders logged today:');
  sh.getRange(r,2).setFormula('='+sumAcrossBranches(function(br){
    return 'COUNTIFS(ResidualGas!$D:$D,"'+br+'",ResidualGas!$B:$B,$B$2)';
  }));
  r++;
  sh.getRange(r,1).setValue('Total residual today (kg):');
  sh.getRange(r,2).setFormula('='+sumAcrossBranches(function(br){
    return 'SUMIFS(ResidualGas!$L:$L,ResidualGas!$D:$D,"'+br+'",ResidualGas!$B:$B,$B$2)';
  }));
}

// ===================== v9 NEW: Faulty header cell + recon formatting fix + Received =====
// =====                  running summary                                            =====
// Run applyV9Updates() ONCE. Safe to run even if you haven't run fixReconSheets() yet -
// the recon formatting fix and Received summary don't depend on it (though if you
// haven't fixed the Supplier Received blocks yet, do that first via fixReconSheets()).
//
// It will:
//  1. Add the "Operator Note" header to column U of the Faulty sheet (the column the
//     faultyLog/faultyListOpen code above now reads/writes - without this header cell
//     the DATA still saves correctly, this is purely so the column is labelled).
//  2. Unmerge and re-normalise number formatting/alignment across the whole Supplier
//     Received section on Daily Recon HB and Daily Recon KM (fixes a merged-cell
//     glitch that got duplicated into every block when fixReconSheets() copied the
//     first block as a template for the other five).
//  3. Add a live "running summary" to the Received sheet (far right, columns R
//     onward, well clear of the raw log) - one self-updating table showing cumulative
//     Full In / Empty Out totals per Branch + Brand + Size, built with QUERY so it
//     never needs manual upkeep as new rows come in.
function applyV9Updates(){
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  _addFaultyNoteHeader(ss);
  _normaliseSupplierReceivedFormatting(ss.getSheetByName('Daily Recon HB'), 44);
  _normaliseSupplierReceivedFormatting(ss.getSheetByName('Daily Recon KM'), 44);
  _addReceivedRunningSummary(ss.getSheetByName('Received'));

  SpreadsheetApp.flush();
}

function _addFaultyNoteHeader(ss){
  var sh = ss.getSheetByName('Faulty');
  if(!sh) return;
  var cell = sh.getRange(1, FAULTY_HEADERS.length); // column U (21st) once FAULTY_HEADERS includes OperatorNote
  if(String(cell.getValue()||'').trim()==='') cell.setValue('Operator Note');
  cell.setFontWeight('bold');
}

function _normaliseSupplierReceivedFormatting(sh, firstHeaderRow){
  if(!sh) return;
  var BLOCK_SPAN = 16, TOTAL_BLOCKS = 6;
  var totalRows = (TOTAL_BLOCKS+1) * BLOCK_SPAN; // 6 named blocks + 1 "Other" block
  var range = sh.getRange(firstHeaderRow, 1, totalRows, 8); // cols A-H, whole section

  range.breakApart();                    // undo any merged cells (this is what caused the misalignment)
  range.setHorizontalAlignment('left');  // baseline: everything left-aligned...
  sh.getRange(firstHeaderRow, 3, totalRows, 3) // ...except Full In / Empty Out / Delta (cols C-E)
    .setHorizontalAlignment('right')
    .setNumberFormat('0');
}

function _addReceivedRunningSummary(sh){
  if(!sh) return;
  var startCol = 18; // column R - well clear of the raw log (data runs through column P)
  sh.getRange(1, startCol).setValue('RUNNING SUMMARY — cumulative totals, updates automatically').setFontWeight('bold');
  sh.getRange(2, startCol).setFormula(
    "=QUERY(Received!A2:P, \"select D, H, G, sum(I), sum(J) where D is not null and D <> '' group by D, H, G order by D, H, G label D 'Branch', H 'Brand', G 'Size', sum(I) 'Total Full In', sum(J) 'Total Empty Out'\", 0)"
  );
  sh.getRange(1, startCol, 1, 5).setFontWeight('bold');
}

// ===================== v10 NEW: SUPPLIER<->BRAND LINKING =====================
// Run applyV10Updates() ONCE after pasting. Safe to run more than once (it only sets the
// "Brands" header cell if it isn't already there) - unlike fixReconSheets(), this is not a
// row-inserting migration. Existing supplier rows are left exactly as they are (blank
// Brands column = unrestricted, same behaviour as before this version existed).
function applyV10Updates(){
  var sh = _suppliersSheet(); // creates the sheet with all 8 headers if it doesn't exist yet
  var cell = sh.getRange(1, 8);
  if(String(cell.getValue()||'').trim()==='') cell.setValue('Brands');
  cell.setFontWeight('bold');
  SpreadsheetApp.flush();
}

// ===================== v11 NEW: SHORT PHOTO LINKS =====================
// OPTIONAL - only needed if you also want EXISTING rows' Photo Link(s)/Photo Link cells
// shortened (new rows are shortened automatically from now on, no migration needed for
// those). Safe to run more than once: it only rewrites a cell whose current text still
// starts with "http" (i.e. still the old raw-URL format) - an already-shortened "📷1"
// cell is left untouched, so re-running never re-processes the same row twice.
function applyV11Updates(){
  ['Received','Private','Manifold'].forEach(function(tabName){
    var sh=_ss().getSheetByName(tabName); if(!sh) return;
    var keys=TABS[tabName];
    var photoKeyIdx=keys.indexOf('PhotoLinks'); if(photoKeyIdx===-1) photoKeyIdx=keys.indexOf('PhotoLink');
    if(photoKeyIdx===-1) return;
    var col=META.length+photoKeyIdx+1;
    var last=sh.getLastRow(); if(last<2) return;
    var vals=sh.getRange(2,col,last-1,1).getValues();
    for(var i=0;i<vals.length;i++){
      var raw=String(vals[i][0]||'');
      if(raw.indexOf('http')!==0) continue; // blank, or already shortened - skip
      var urls=raw.split(',').map(function(u){return u.trim();}).filter(Boolean);
      if(!urls.length) continue;
      sh.getRange(2+i,col).setRichTextValue(_photoLinksRichText(urls));
    }
  });
  SpreadsheetApp.flush();
}

// ===================== v12 NEW: SUPPLIER<->BRANCH LINKING =====================
// Run applyV12Updates() ONCE after pasting. Safe to run more than once (it only sets the
// "Branches" header cell if it isn't already there) - not a row-inserting migration.
// Existing supplier rows are left exactly as they are (blank Branches column = available
// at both branches, same behaviour as before this version existed).
function applyV12Updates(){
  var sh = _suppliersSheet(); // creates the sheet with all 9 headers if it doesn't exist yet
  var cell = sh.getRange(1, 9);
  if(String(cell.getValue()||'').trim()==='') cell.setValue('Branches');
  cell.setFontWeight('bold');
  SpreadsheetApp.flush();
}

// ===================== v13 NEW: SAME-DAY ROW ADJUSTMENT + RESIDUAL PHOTO =====================
// Run applyV13Updates() ONCE after pasting. Safe to run more than once (it only sets a
// header cell if it isn't already there) - not a row-inserting migration, existing rows
// are left exactly as they are (blank RowId = "predates row tracking", which the frontend
// already expects and handles - same-day Adjustments on those specific rows still work
// exactly as before v13, just without the direct sheet-row update; blank Photo Link(s) on
// an old Residual row simply means no photo was attached, same as always). If a tab
// doesn't exist yet (fresh setup), this creates it via setupSheets()/_residualSheet()
// first so there's a sheet to add the header to.
function applyV13Updates(){
  var ss = _ss();
  ['Refills','Private','Received','Manifold'].forEach(function(tabName){
    var sh = ss.getSheetByName(tabName);
    if(!sh){ setupSheets(); sh = ss.getSheetByName(tabName); }
    if(!sh) return;
    var idx = TABS[tabName].indexOf('RowId');
    if(idx===-1) return;
    var col = META.length + idx + 1;
    var cell = sh.getRange(1, col);
    if(String(cell.getValue()||'').trim()==='') cell.setValue('Row Id');
    cell.setFontWeight('bold');
  });
  var rgSh = _residualSheet(); // creates the sheet with all headers (including Photo Link(s)) if missing
  var rgCell = rgSh.getRange(1, RESIDUAL_HEADERS.length);
  if(String(rgCell.getValue()||'').trim()==='') rgCell.setValue('Photo Link(s)');
  rgCell.setFontWeight('bold');
  SpreadsheetApp.flush();
}

// ===================== v14 NEW: PROTECT ROWID COLUMNS =====================
// RowId is an internal, app-managed field - no human is meant to ever type into it. Left
// unprotected, an accidental edit either quietly breaks that one row's same-day Adjustment
// lookup (safe - falls back to log-only, same as any pre-v13 row) or, in the rare case of
// an accidental duplicate matching another row's id, could misdirect a correction onto the
// wrong row. This locks each of the 4 RowId columns (Refills/Private/Received/Manifold)
// against editing by anyone but the sheet owner.
//
// Run protectRowIdColumns() ONCE. Safe to run more than once - it checks whether a
// protection already covers that exact column before adding another, so re-running never
// stacks duplicate protections on top of each other.
//
// Known limits, not fixable from code (see the v14 changelog note at the top of this file
// for the full explanation): the sheet OWNER can always remove any protection regardless of
// this setup (Google's own permission model, not something a script can override);
// deleting and re-inserting the column entirely sidesteps it, since a protection is tied to
// a range, not a "field" concept; and the script itself is only exempt from its own
// protection because the web app is deployed "Execute as: me" - if that deployment setting
// is ever changed, the script would start hitting this same protection itself.
//
// PLEASE CHECK Data > Protected sheets and ranges in the actual spreadsheet after running
// this, to confirm the 4 RowId columns actually show up there as protected - don't just
// trust it ran silently and move on.
function protectRowIdColumns(){
  var ss = _ss();
  ['Refills','Private','Received','Manifold'].forEach(function(tabName){
    var sh = ss.getSheetByName(tabName);
    if(!sh) return;
    var idx = TABS[tabName].indexOf('RowId');
    if(idx===-1) return;
    var col = META.length + idx + 1;
    _protectColumn(sh, col, tabName+' Row Id - app-managed, do not edit manually');
  });
  SpreadsheetApp.flush();
}
// Protects an entire column (row 1 through the sheet's max row, so future rows appended
// later stay covered too, not just whatever's there right now) - idempotent, checks for an
// existing protection on that exact column first. Explicitly strips the default editor
// list: simply calling .protect() leaves every existing sheet editor able to edit the
// "protected" range, which would do nothing at all - removeEditors(getEditors()) is what
// actually locks it down to the sheet owner only. The script itself is unaffected (runs
// under the deploying account's own authority, assuming "Execute as: me").
function _protectColumn(sh, col, description){
  var already = sh.getProtections(SpreadsheetApp.ProtectionType.RANGE).some(function(p){
    var r = p.getRange();
    return r.getRow()===1 && r.getColumn()===col;
  });
  if(already) return;
  var range = sh.getRange(1, col, sh.getMaxRows(), 1);
  var protection = range.protect().setDescription(description);
  try{ protection.removeEditors(protection.getEditors()); }catch(e){}
  try{ if(protection.canDomainEdit()) protection.setDomainEdit(false); }catch(e){}
}

// ===================== v15 NEW: REFILLS PHOTOLINKS HEADER =====================
// Run applyV15Updates() ONCE after pasting. Safe to run more than once (it only sets the
// "Photo Link(s)" header cell on the Refills tab if it isn't already there) - not a
// row-inserting migration. Existing Refills rows are left exactly as they are (blank
// PhotoLinks = no photo was ever captured for that row, which is simply true - the column
// didn't exist yet to hold one).
function applyV15Updates(){
  var sh = _ss().getSheetByName('Refills');
  if(!sh) return;
  var idx = TABS.Refills.indexOf('PhotoLinks');
  if(idx===-1) return;
  var col = META.length + idx + 1;
  var cell = sh.getRange(1, col);
  if(String(cell.getValue()||'').trim()==='') cell.setValue('Photo Link(s)');
  cell.setFontWeight('bold');
  SpreadsheetApp.flush();
}
