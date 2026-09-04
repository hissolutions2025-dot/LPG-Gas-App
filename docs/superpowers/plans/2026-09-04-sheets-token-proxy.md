# Sheets Sync Token Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Task 2 is a MANUAL step for the human operator — it cannot be automated by an agent; wait for explicit confirmation before starting Task 3.

**Goal:** Stop exposing the Google Sheets webapp URL and its auth token in client-side page
source. Move both behind a new Supabase Edge Function that authenticates the caller and
forwards the request server-side.

**Architecture:** A new, thin, auth-checked Edge Function (`sheets-sync`) mirrors the existing
`verify-highrisk`/`manage-user` pattern exactly — real secrets read via `Deno.env.get()`,
caller identity verified via `getClaims()`. The client's `syncPush`/`syncFlush`/`apiPost` keep
their exact current success/failure semantics, just pointed at the new function instead of
Google directly, with the client no longer knowing the real token at all.

**Tech Stack:** Deno Edge Function (TypeScript, matches the two existing functions in this
repo), vanilla JS client changes in `index.html`, no build step.

---

### Task 1: Write the Edge Function

**Files:**
- Create: `supabase/functions/sheets-sync/index.ts`

- [ ] **Step 1: Write the function**

```typescript
// supabase/functions/sheets-sync/index.ts
// Forwards a capture-sync request to the real Google Apps Script webapp, holding its URL and
// auth token server-side only - the client never sees either (see the design doc,
// docs/superpowers/specs/2026-09-04-sheets-token-proxy-design.md). Same auth-check shape as
// verify-highrisk/manage-user (getClaims() against the caller's own session token). No
// granular permission check beyond "genuinely signed in" - routine data sync (every capture
// commit, Close Day, Faulty Cylinders actions, photo uploads) is triggered by every role as
// normal, expected use, not a privileged action like user management.
//
// Deliberately a thin, transparent pass-through: forwards the client's body verbatim (minus
// callerToken, and minus whatever token field the client sent, always overridden with the
// real one here) to the real endpoint, and returns whatever it responds with, same status
// code. The Apps Script backend already routes on a `type` field in the body regardless of
// caller (syncPush's fire-and-forget calls and apiPost's real request/response calls both
// already speak this same wire shape) - this function does not need to understand or
// re-model that protocol at all.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.112.3'

Deno.serve(async (req) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type' }
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const sheetsUrl = Deno.env.get('SHEETS_WEBAPP_URL')!
    const sheetsToken = Deno.env.get('SHEETS_WEBAPP_TOKEN')!
    const body = await req.json()

    const authClient = createClient(supabaseUrl, anonKey)
    const { data: claimsData, error: claimsError } = await authClient.auth.getClaims(body.callerToken || '')
    if (claimsError || !claimsData?.claims?.sub) {
      return new Response(JSON.stringify({ error: 'Not signed in' }), { status: 401, headers: cors })
    }

    const forwardBody: Record<string, unknown> = {}
    for (const k in body) { if (k !== 'callerToken') forwardBody[k] = body[k] }
    forwardBody.token = sheetsToken

    const res = await fetch(sheetsUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(forwardBody)
    })
    const text = await res.text()
    let json: unknown
    try { json = JSON.parse(text) } catch { json = { raw: text } }
    return new Response(JSON.stringify(json), { status: res.status, headers: { ...cors, 'Content-Type': 'application/json' } })
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Unexpected error: ' + (e && (e as any).message ? (e as any).message : String(e)) }), { status: 500, headers: cors })
  }
})
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/sheets-sync/index.ts
git commit -m "feat: add sheets-sync Edge Function to hide the real Sheets webapp token"
```

Do NOT push yet if the repo's usual push-on-commit habit would trigger this — Task 2 requires
the secrets to be set BEFORE this function is exercised for real, but the function itself is
inert (does nothing) until called, so pushing/deploying it now is harmless even before secrets
exist (calls would just fail with the sheetsUrl/sheetsToken env vars undefined, which is a
safe failure mode, not a security risk - it simply wouldn't work yet). Push is fine.

```bash
git push origin main
```

---

### Task 2: MANUAL — set secrets and confirm the function works standalone

**This task is for the human operator (Freddie), not an automated agent.** Do not proceed to
Task 3 until this is confirmed done.

- [ ] **Step 1:** Go to the Supabase dashboard → this project → **Edge Functions** → find
  `sheets-sync` in the list (should already be deployed, since GitHub↔Supabase auto-deploy was
  connected earlier this session — confirm it shows as deployed, not just present in the repo).

- [ ] **Step 2:** Go to **Project Settings → Edge Functions → Secrets** (or the CLI equivalent,
  `supabase secrets set`). Add two secrets:
  - `SHEETS_WEBAPP_URL` = the real Apps Script deployment URL (get it from the Apps Script
    project's own Deploy → Manage deployments screen, or from `index.html` git history before
    this feature — do NOT write the real value into this doc; it must never appear in a
    committed file again)
  - `SHEETS_WEBAPP_TOKEN` = the real token the Apps Script backend checks incoming requests
    against (same rule — never write the real value into a committed file; if the value that
    used to be hardcoded here was ever exposed publicly, treat it as compromised and rotate it
    in the Apps Script code first, matching the new value here)

- [ ] **Step 3:** Confirm the function actually works, standalone, BEFORE any client code
  changes go live. From a logged-in browser console (same technique used earlier this
  session — real authenticated session, not an anon test):

```js
sb.auth.getSession().then(function(sres){
  var token=sres.data.session.access_token;
  return fetch(SUPABASE_URL+'/functions/v1/sheets-sync',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'suppliersList',callerToken:token})});
}).then(function(r){return r.json();}).then(function(j){console.log(JSON.stringify(j));});
```

  This calls the harmless read-only `suppliersList` action through the new proxy. Expected: a
  real JSON response (the actual supplier list, or at least something other than "Not signed
  in" or a 500 error) — proves the function is deployed, the secrets are set correctly, and it
  successfully reached the real Apps Script backend.

- [ ] **Step 4:** Report back the result (paste the console output). Only once this confirms
  success does Task 3 proceed.

---

### Task 3: Point the client at the new proxy

**Files:**
- Modify: `index.html`, `syncCfg()` (~line 9795), `syncPush()`/`syncFlush()`/`apiPost()`
  (~lines 3099-3133)

- [ ] **Step 1: Replace `syncCfg()` and add the shared send helper**

Find:
```javascript
// ===== GOOGLE SHEETS SYNC (Apps Script Web App) =====
// Configure once in Manage Users. URL + token stored locally.
function setSyncCfg(url,token){try{localStorage.setItem('gs_sync_cfg',JSON.stringify({url:url||'',token:token||''}));}catch(e){}}
function syncPush(type,rows){
  var cfg=syncCfg();
  if(!cfg.url||!rows||!rows.length)return;
  var payload={token:cfg.token,type:type,rows:rows};
  try{
    fetch(cfg.url,{method:'POST',mode:'no-cors',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify(payload)})
      .then(function(){syncFlush();})
      .catch(function(){syncQueue(payload);});
  }catch(e){syncQueue(payload);}
}
function syncQueue(payload){try{var q=JSON.parse(localStorage.getItem('gs_sync_queue')||'[]');q.push(payload);localStorage.setItem('gs_sync_queue',JSON.stringify(q.slice(-200)));}catch(e){}}
function syncFlush(){
  var cfg=syncCfg();if(!cfg.url)return;
  var q;try{q=JSON.parse(localStorage.getItem('gs_sync_queue')||'[]');}catch(e){return;}
  if(!q.length)return;
  localStorage.setItem('gs_sync_queue','[]');
  q.forEach(function(p){try{fetch(cfg.url,{method:'POST',mode:'no-cors',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify(p)}).catch(function(){syncQueue(p);});}catch(e){syncQueue(p);}});
}
// Real request/response POST (separate from syncPush's fire-and-forget 'no-cors' pushes above).
// Used by the Faulty Cylinders feature, which needs actual {ok,...} replies from the backend.
function apiPost(action,extra){
  var cfg=syncCfg();
  // The backend routes on a field called "type" (confirmed directly against the live
  // endpoint - sending {action:...} came back "unknown type: undefined"; sending
  // {type:...} at least gets the value echoed back, e.g. "unknown type: suppliersList").
  // Kept the function's own "action" parameter name/call sites unchanged - only the
  // wire field name changed here.
  var payload={type:action,token:cfg.token,caller:operator};
  if(extra){for(var k in extra){if(extra.hasOwnProperty(k))payload[k]=extra[k];}}
  return fetch(cfg.url,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify(payload)})
    .then(function(r){return r.json();});
}
```
Change to:
```javascript
// ===== GOOGLE SHEETS SYNC (via sheets-sync Edge Function - see
// docs/superpowers/specs/2026-09-04-sheets-token-proxy-design.md) =====
// Configure once in Manage Users. URL + token stored locally.
function setSyncCfg(url,token){try{localStorage.setItem('gs_sync_cfg',JSON.stringify({url:url||'',token:token||''}));}catch(e){}}
// Every syncPush/syncFlush/apiPost call now goes through this - attaches the caller's own
// Supabase session token (same convention _callVerifyHighRisk already uses) and posts to the
// Edge Function normally (no mode:'no-cors' needed - this is a same-trust call to our own
// function, not cross-origin to Google, so CORS is fully controllable server-side). Resolves
// on ANY completed HTTP response regardless of status code, rejects only on a genuine network
// failure - the exact same success/failure boundary the old mode:'no-cors' fetch had, so
// syncPush/syncFlush's queue-on-failure behavior is unchanged.
function _sheetsSyncSend(url,payload){
  return sb.auth.getSession().then(function(sres){
    var token=sres.data&&sres.data.session&&sres.data.session.access_token;
    return fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({},payload,{callerToken:token}))});
  });
}
function syncPush(type,rows){
  var cfg=syncCfg();
  if(!cfg.url||!rows||!rows.length)return;
  var payload={type:type,rows:rows};
  try{
    _sheetsSyncSend(cfg.url,payload)
      .then(function(){syncFlush();})
      .catch(function(){syncQueue(payload);});
  }catch(e){syncQueue(payload);}
}
function syncQueue(payload){try{var q=JSON.parse(localStorage.getItem('gs_sync_queue')||'[]');q.push(payload);localStorage.setItem('gs_sync_queue',JSON.stringify(q.slice(-200)));}catch(e){}}
function syncFlush(){
  var cfg=syncCfg();if(!cfg.url)return;
  var q;try{q=JSON.parse(localStorage.getItem('gs_sync_queue')||'[]');}catch(e){return;}
  if(!q.length)return;
  localStorage.setItem('gs_sync_queue','[]');
  q.forEach(function(p){try{_sheetsSyncSend(cfg.url,p).catch(function(){syncQueue(p);});}catch(e){syncQueue(p);}});
}
// Real request/response POST (separate from syncPush's fire-and-forget pushes above).
// Used by the Faulty Cylinders feature, which needs actual {ok,...} replies from the backend.
function apiPost(action,extra){
  var cfg=syncCfg();
  // The backend routes on a field called "type" (confirmed directly against the live
  // endpoint - sending {action:...} came back "unknown type: undefined"; sending
  // {type:...} at least gets the value echoed back, e.g. "unknown type: suppliersList").
  // Kept the function's own "action" parameter name/call sites unchanged - only the
  // wire field name changed here.
  var payload={type:action,caller:operator};
  if(extra){for(var k in extra){if(extra.hasOwnProperty(k))payload[k]=extra[k];}}
  return _sheetsSyncSend(cfg.url,payload).then(function(r){return r.json();});
}
```

- [ ] **Step 2: Replace `syncCfg()` itself**

Find (the real URL/token values are redacted here - match against the actual line in
`index.html`, not this placeholder text):
```javascript
function syncCfg(){return { url: '<real Apps Script deployment URL>', token: "<real token>" };}
```
Change to:
```javascript
function syncCfg(){return { url: SUPABASE_URL+'/functions/v1/sheets-sync' };}
```

(`SUPABASE_URL` is an existing client-side constant already used by `_callVerifyHighRisk`/etc.
- verify it's in scope at this point in the file before applying; if it's declared later than
this line, that's fine too since `syncCfg()` is a function body, not evaluated at parse time.)

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
git commit -m "feat: route Sheets sync through sheets-sync Edge Function - real token no longer in client source"
```

---

### Task 4: Live verification and push

No automated test suite exists - verification is live and direct, on the real deployed app.

- [ ] **Step 1: Confirm the token is genuinely gone from client source**

Replace `<old token value>` below with the actual retired token before running this check -
do not write the real value back into this file.
```js
fetch('https://hissolutions2025-dot.github.io/LPG-Gas-App/?_='+Date.now()).then(r=>r.text()).then(t=>({
  hasOldToken: t.includes('<old token value>'),
  hasOldUrl: t.includes('script.google.com'),
  hasNewProxy: t.includes('/functions/v1/sheets-sync')
}))
```
Expected: `hasOldToken:false, hasOldUrl:false, hasNewProxy:true`.

- [ ] **Step 2: Verify each sync path still works, for real, on the live app**

- Commit a small real Stock Count line for a test branch/size - confirm it appears on the
  actual Google Sheet (Counts tab) shortly after, same as always.
- Trigger a Refill or Private Refill commit - confirm it appears on its Sheet tab.
- Log a Faulty Cylinder entry (uses `apiPost`, needs the real `{ok,...}` response to proceed
  past its own success check) - confirm it saves without error and appears correctly.
- Take a photo during a capture (uses `uploadPhotoSet`→`apiPost('photoUpload',...)`) - confirm
  the photo link comes back and the row saves with it attached.
- Simulate an offline failure (airplane mode, commit something, confirm it lands in
  `gs_sync_queue`, restore connection, confirm `syncFlush()`/the `online` listener drains it) -
  confirms the queue-on-failure path still works identically through the new proxy.

- [ ] **Step 3: Push**

```bash
git push origin main
```
