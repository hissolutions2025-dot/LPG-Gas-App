# Supabase Migration — Phase 1 (Real Accounts) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current per-device, plain-text, `localStorage`-only user accounts with real Supabase accounts (Supabase Auth for sign-in, a `profiles` table for name/level/branches/permissions) — so a person's account and permissions live in one place, work from any device, and survive a lost phone. Every capture workflow (Count, Refill, Received, Manifold, etc.) keeps talking to Google Sheets exactly as today — untouched. The one exception is *how* a password gets checked: any spot that already asked someone to re-enter a password mid-workflow (Seal Roll admin, Close Day, Corrections, Adjustments — see Task 11) now checks it against Supabase instead of the old local list; what each of those actions actually does is unchanged.

**Architecture:** `index.html` stays a single static file (no build step, no framework) — this plan only adds the Supabase JS client via a `<script>` tag, same pattern as everything else in this app. Login keeps its current "pick your name, type a password" feel: each person gets a hidden, auto-generated internal email (`<name>@gassales.local`) that only Supabase's Auth system ever sees. New/edited accounts are created through one Supabase **Edge Function** (`manage-user`) — a small piece of server-side code that holds the one secret credential capable of creating accounts (the "service role" key), which must never be shipped to the browser. Row Level Security (fine-grained "who can read/write what" rules enforced by the database itself) is explicitly **Phase 2's** job — this phase only needs enough database-side protection that a signed-in stranger can't create or edit accounts, which the Edge Function itself enforces by checking the caller's own profile before doing anything privileged.

**Tech Stack:** Supabase (Postgres + Auth + Edge Functions), Supabase JS client v2 (loaded from a CDN, no npm/build step), Deno (only used inside the Edge Function — Supabase runs Edge Functions on Deno, not Node; you don't need Deno installed to *use* the app, only to *deploy* the function in Task 8), the Supabase CLI (a small command-line tool, used once in Task 8 to deploy the Edge Function).

---

## Before you start: what you'll need

- A Supabase account (free — supabase.com, sign in with GitHub or email).
- Node.js installed on your computer (you already have this — it's what `node --check` uses).
- About 60–90 minutes across Tasks 1–3 and 7–8 (dashboard clicking + one CLI command), the rest is Claude writing code with you watching/running verification steps.

---

### Task 1: Decide the final permission list (the pre-Phase-1 checkpoint)

This is the checkpoint flagged in the design spec: revise the permission list *before* it gets built into the database, not after. This is a conversation, not code — the outcome feeds every later task, but no later task hard-codes today's specific permission names, so this can happen in any order relative to reading the rest of the plan.

- [ ] **Step 1: Review the current permission list with Claude**

Open `index.html` and find `PERM_KEYS`/`PERM_LABELS`/`permPreset()` (currently around line 1799). Go through each of the 18 existing keys (`view`, `capture`, `edit`, `closeday`, `history`, `users`, `audit`, `adjust`, `seal_admin`, `seal_create`, `seal_void_open`, `seal_edit_used`, `seal_boundary`, `branch_setup`, `faultyCapture`, `faultyRegister`, `residualGas`, `manageSuppliers`) with Claude, one at a time: still needed? Still named clearly? Anything missing given everything added this session (same-day Adjustment tool, RowId/Adjustments-sheet corrections)?

- [ ] **Step 2: Apply the agreed changes**

Claude edits `PERM_KEYS`, `PERM_LABELS`, and the three `permPreset()` returns (Owner/Manager/Operator) in `index.html` to match. This is a plain local edit — no Supabase involved yet, the app keeps working exactly as it does today off `localStorage`.

- [ ] **Step 3: Verify**

Run:
```bash
node -e "new Function(require('fs').readFileSync('index.html','utf8').match(/<script>([\s\S]*)<\/script>/)[1])"
```
Expected: no output (syntax is valid). Then open the app in the Browser preview, log in as the existing demo Owner, open Manage Users → edit a user, and confirm the permission checkbox list shows exactly the agreed set with the right labels.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "Revise permission list ahead of Supabase Phase 1"
```
(Only push if you separately say "commit and push" — same standing rule as always.)

---

### Task 2: Create the Supabase project

- [ ] **Step 1:** Go to [supabase.com](https://supabase.com/dashboard), sign in, click **New project**.
- [ ] **Step 2:** Name it `lpg-gas-app` (or similar), set a strong database password (save it somewhere safe — a password manager, not a sticky note — you likely won't need it day-to-day, but you will if you ever need to connect a database tool directly), pick the region closest to you (Frankfurt or London — Supabase has no Africa region, see the earlier research), and click **Create new project**. Takes 1–2 minutes to provision.
- [ ] **Step 3:** Once it's ready, go to **Project Settings → API**. Copy two values somewhere you'll paste from in Task 4:
  - **Project URL** (looks like `https://xxxxxxxxxxxx.supabase.co`)
  - **anon / public key** (a long string starting with `eyJ...`)

  This key is *meant* to be public — it goes straight into `index.html` in Task 4, visible to anyone, same as it would be in any Supabase app. Security comes from the database's own rules (Row Level Security, Phase 2), not from hiding this key. Do **not** copy the **service_role** key anywhere near `index.html` — that one is the dangerous one, used only inside the Edge Function in Task 7.

---

### Task 3: Create the database schema

- [ ] **Step 1:** In the Supabase dashboard, open **SQL Editor → New query**, paste and run:

```sql
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null unique,
  level text not null check (level in ('Owner','Manager','Operator')),
  branches jsonb not null default '[]'::jsonb,
  perms jsonb not null default '{}'::jsonb,
  access jsonb not null default '{}'::jsonb,
  phone text,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Phase 1 baseline only: any signed-in person can read the full profile list
-- (needed so the app can show names/branches/levels once logged in - e.g. for
-- future team-visibility features). Fine-grained "who can see/change what" rules
-- are Phase 2's job, not this one.
create policy "profiles readable by any signed-in user"
  on public.profiles for select
  using (auth.role() = 'authenticated');

-- No one is allowed to write to profiles directly from the browser, ever -
-- all creates/edits/deletes go through the manage-user Edge Function (Task 7),
-- which uses the service role key and does its own permission check first.
-- (No insert/update/delete policy = denied by default under RLS.)
```

- [ ] **Step 2:** Create the public, pre-login "pick your name" list. This is deliberately a *separate*, minimal view — it must be readable by someone who hasn't logged in yet (to populate the name dropdown), so it exposes only what's needed for that dropdown, nothing sensitive:

```sql
create view public.login_names as
  select id, name, level, branches from public.profiles;

grant select on public.login_names to anon, authenticated;
```

- [ ] **Step 3: Verify**

In the SQL Editor, run `select * from public.profiles;` — expect an empty result (no error). Run `select * from public.login_names;` — same, empty but no error.

---

### Task 4: Create the very first Owner account

This one account is created by hand, directly in the Supabase dashboard — there's no one logged in yet to grant permission to anyone, so the app itself can't be the one to do it (this replaces the current in-app "first run → create Owner" card, see Task 11).

- [ ] **Step 1:** Dashboard → **Authentication → Users → Add user → Create new user**. Email: `<yourname>@gassales.local` (all lowercase, no spaces — e.g. `freddie@gassales.local`). Password: your real password. Tick **Auto Confirm User**. Click **Create user**. Copy the new user's **UID** (shown in the users list).

- [ ] **Step 2:** SQL Editor → run (replace the two placeholders):

```sql
insert into public.profiles (id, name, level, branches, perms, access, phone)
values (
  '<paste the UID here>',
  'Freddie',
  'Owner',
  '["Helderberg","Kleinmond"]'::jsonb,
  '{}'::jsonb,
  '{}'::jsonb,
  null
);
```

- [ ] **Step 3: Verify**

`select * from public.profiles;` should show exactly one row, level `Owner`, both branches.

---

### Task 5: Add the Supabase client to `index.html`

**Files:**
- Modify: `index.html` (in the `<head>`, alongside existing `<script>` tags)

- [ ] **Step 1:** Add the CDN script tag and initialize the client. Find where `index.html`'s other top-level `<script>` tags/globals are declared (near the top of the file, before `var operator=null;` and friends) and add:

```html
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
```

Then in the main inline `<script>` block, near the other top-level `var` declarations:

```javascript
var SUPABASE_URL = 'https://xxxxxxxxxxxx.supabase.co'; // from Task 2, Step 3
var SUPABASE_ANON_KEY = 'eyJ...'; // from Task 2, Step 3
var sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
```

Replace the two placeholder values with your real Project URL and anon key from Task 2.

- [ ] **Step 2: Verify**

```bash
node -e "new Function(require('fs').readFileSync('index.html','utf8').match(/<script>([\s\S]*)<\/script>/)[1])"
```
Expected: no output. Open the Browser preview, open the browser console (`read_console_messages`), and run `sb` — expect it to print a Supabase client object, not `undefined` or an error.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "Add Supabase client to index.html"
```

---

### Task 6: Rewrite the login screen

**Files:**
- Modify: `index.html:2265` (`initLoginScreen`), `:2291` (`loginUserChanged`), `:2306` (`doLogin`), `:2277` (`createOwner` — removed, see Task 11)

- [ ] **Step 1: Replace `initLoginScreen()`**

Old version reads `loadUsers()` (synchronous, `localStorage`). New version reads `login_names` (async, Supabase) and always shows the login card — the "first run, no users" setup card goes away (Task 4 already created the one bootstrap account by hand):

```javascript
function initLoginScreen(){
  document.getElementById('setupCard').style.display='none';
  document.getElementById('loginCard').style.display='block';
  var sel=document.getElementById('loginUser');
  sel.innerHTML='<option value="">Loading names…</option>';
  sb.from('login_names').select('id,name,level,branches').order('name').then(function(res){
    if(res.error){toast('Could not load user list: '+res.error.message,true);sel.innerHTML='<option value="">Select your name…</option>';return;}
    _loginNamesCache=res.data||[];
    sel.innerHTML='<option value="">Select your name…</option>'+_loginNamesCache.map(function(u){return '<option>'+u.name+'</option>';}).join('');
  });
}
var _loginNamesCache=[];
function _loginFindName(name){return _loginNamesCache.filter(function(u){return u.name===name;})[0]||null;}
```

- [ ] **Step 2: Replace `loginUserChanged()`**

Same logic as before, just reading from `_loginFindName()` (the Supabase-backed cache) instead of `findUser()` (the old `localStorage`-backed lookup):

```javascript
function loginUserChanged(){
  var u=_loginFindName(document.getElementById('loginUser').value);
  var bsel=document.getElementById('loginBranch');
  var note=document.getElementById('branchNote');
  if(!u){bsel.innerHTML='<option value="">Select name first…</option>';bsel.disabled=false;bsel.style.opacity='1';note.textContent='';return;}
  var br=u.branches||[];
  if(br.length>1){
    bsel.innerHTML='<option value="">Select branch…</option>'+br.map(function(b){return '<option>'+b+'</option>';}).join('');
    bsel.disabled=false;bsel.style.opacity='1';
    note.innerHTML='<b>'+u.level+'</b> — may work: '+br.join(', ')+'.';
  } else {
    bsel.innerHTML='<option>'+br[0]+'</option>';bsel.value=br[0];bsel.disabled=true;bsel.style.opacity='.6';
    note.innerHTML='<b>'+u.level+'</b> — locked to '+br[0]+'.';
  }
}
```

- [ ] **Step 3: Replace `doLogin()`**

The real auth check now goes through Supabase (`signInWithPassword`, using the hidden generated email), then loads the full profile row (perms/access/phone — not in the public `login_names` view) before continuing exactly as before. Everything from `operator=u.name;...` onward in the original function is unchanged, just moved inside the `.then()`:

```javascript
function doLogin(){
  var picked=_loginFindName(document.getElementById('loginUser').value);
  var p=document.getElementById('loginPin').value;
  if(!picked){toast('Pick your name',true);return;}
  var br=picked.branches||[];
  var b=(br.length>1)?document.getElementById('loginBranch').value:br[0];
  if(!b){toast('Pick a branch',true);return;}
  var fakeEmail=picked.name.toLowerCase().replace(/[^a-z0-9]/g,'')+'@gassales.local';
  sb.auth.signInWithPassword({email:fakeEmail,password:p}).then(function(res){
    if(res.error){toast('Wrong password',true);return;}
    sb.from('profiles').select('*').eq('id',res.data.user.id).single().then(function(pres){
      if(pres.error||!pres.data){toast('Could not load your profile: '+(pres.error?pres.error.message:'not found'),true);return;}
      _finishLogin(pres.data,b);
    });
  });
}
function _finishLogin(u,b){
  operator=u.name;role=u.level;branch=b;today=computeToday();currentPerms=userPerms(u);
  document.getElementById('dateVal').textContent=today+(getDateOffset()?'  (TEST +'+getDateOffset()+'d)':'  (today only)');
  document.getElementById('who').style.display='block';
  renderLandingHeader();
  document.getElementById('tileUsers').style.display=perm('users')?'flex':'none';
  document.getElementById('tileAudit').style.display=perm('audit')?'flex':'none';
  var _ta=document.getElementById('tileAdmin');if(_ta)_ta.style.display=(perm('seal_admin')||perm('faultyCapture')||perm('faultyRegister')||perm('manageSuppliers'))?'flex':'none';
  var _trg=document.getElementById('tileResidual');if(_trg)_trg.style.display=perm('residualGas')?'flex':'none';
  auditLog('Login','Signed in to '+b);
  editUnlocked=false;
  loadWorkingStore();
  cLoadDraftIntoMemory();
  rLoadDraftIntoMemory();
  syncFlush();
  refreshTestDateUI();
  if(!_restoreCurrentSection())show('landing');
  updateBadges();
  _armIdleTimer();
}
```

`userPerms(u)` (existing function, `index.html:1806`) already merges a profile's stored `perms` over its level's preset — no change needed there, since the Supabase `profiles` row has the exact same shape (`level`, `perms`) as the old `localStorage` user object did.

**Implementation note (added after code review, before this task was marked done):** the built version differs from the snippet above in ways the review caught and fixed, all committed as part of Task 6:
- A shared `_fakeEmail(name)` helper replaced the inline formula (reused by later tasks instead of repeating the formula each time).
- `doLogin()` gained a busy/disable guard on the Sign-in button (`loginSubmitBtn`, added since none existed), and the sign-in failure path now shows the real `res.error.message` instead of a hardcoded "Wrong password" (so a network/config problem doesn't look identical to a typo'd password).
- `initLoginScreen()`'s Supabase call gained a `.catch()`.
- **Most importantly:** a new top-level `var currentProfile=null;` is set as the first line of `_finishLogin(u,b)` (`currentProfile=u;`), and `_curUser(){return findUser(operator);}` was changed to `_curUser(){return currentProfile;}`. This was needed immediately, not deferred to Task 12: `findUser()` reads `localStorage`, which the new login never populates, so `findUser(operator)` returns `null` for anyone logged in via Supabase — and four call sites (`adminSetBranch`, `faultySetBranch`, `residualSetBranch`, `faultyRegisterBranches`) called `findUser(operator).branches` directly, which is a live crash (`TypeError` on `null.branches`) the moment a Manager taps a branch-switch button. All four were switched to `_curUser()`. Every *other* `findUser(...)` call site in the file (there are several more, all password-reauth related) is deliberately untouched here — see Task 11, which was expanded after this same review to cover the ones Task 11's original scope had missed.

- [ ] **Step 4: Verify**

`node -e "new Function(...)"` syntax check (same command as Task 5, Step 2) — expect no output. Then in the Browser preview: reload, confirm the login dropdown shows "Freddie" (from Task 4), pick it, confirm branch shows "All branches"-style note for Owner, enter the real password from Task 4 — confirm it lands on the home screen exactly as today's app does, with the Manage Users tile visible.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "Wire login screen to Supabase Auth"
```

---

### Task 7: Rewrite logout and add session auto-resume

**Files:**
- Modify: `index.html:2340` (`logout`), add new code near `doLogin`

- [ ] **Step 1: Update `logout()`** — add one line calling Supabase's sign-out, everything else unchanged:

```javascript
function logout(){
  if(operator)auditLog('Logout','Signed out');
  sb.auth.signOut();
  operator=null;branch=null;role=null;currentProfile=null;
  if(idleTimer){clearTimeout(idleTimer);idleTimer=null;}
  idleLockActive=false;
  var _ilo=document.getElementById('idleLockOverlay');if(_ilo)_ilo.style.display='none';
  document.getElementById('who').style.display='none';document.getElementById('loginPin').value='';document.getElementById('loginUser').value='';loginUserChanged();show('login');
}
```

(`currentProfile=null;` is new — added alongside the other session-state globals being cleared, since Task 6's review fix introduced `currentProfile` as the backing store for `_curUser()`. Leaving it set after logout would mean the next person to sign in on this device briefly sees the previous person's `_curUser()`-gated section access until `_finishLogin()` overwrites it — clearing it here removes that window entirely.)

`_bootApp()`'s session-resume path (Step 2 below) does not need a separate fix — it already calls `_finishLogin(pres.data,br)`, which sets `currentProfile` as its first line.

- [ ] **Step 2: Add auto-resume on page load** — this is the "side benefit" from the design spec: Supabase keeps a session alive across app restarts, so a reload (or a backgrounded-then-reopened PWA) can skip straight back to a signed-in state instead of showing the login screen. Find the app's page-load entry point (search for where `initLoginScreen()` is currently called on startup) and wrap it:

```javascript
function _bootApp(){
  sb.auth.getSession().then(function(res){
    var session=res.data && res.data.session;
    if(!session){initLoginScreen();show('login');return;}
    sb.from('profiles').select('*').eq('id',session.user.id).single().then(function(pres){
      if(pres.error||!pres.data){initLoginScreen();show('login');return;}
      // branch is not known from the session alone (it's chosen at login, not stored) -
      // fall back to the profile's first branch, same default a fresh login would use.
      var br=(pres.data.branches||[])[0]||'Helderberg';
      _finishLogin(pres.data,br);
    });
  });
}
```

Replace the existing startup call to `initLoginScreen()` with a call to `_bootApp()` instead (same place in the file — the very end of the script, or wherever the app currently kicks itself off on load).

- [ ] **Step 3: Verify**

Log in via the Browser preview, then reload the page (not logout — a real reload, simulating the app being reopened). Expect: lands straight back on the home screen (or wherever `_restoreCurrentSection()` puts you), no login screen shown. Then explicitly sign out and reload — expect: login screen, name dropdown populated.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "Sign out via Supabase Auth, auto-resume session on reload"
```

---

### Task 8: Write the `manage-user` Edge Function

This one function safely handles every privileged account action (create, edit, delete, reset someone else's password) — it's the only place the powerful service-role key is ever used, and it checks the caller's own permission before doing anything.

**Files:**
- Create: `supabase/functions/manage-user/index.ts`

- [ ] **Step 1: Write the function**

```typescript
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

Deno.serve(async (req) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type' }
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return new Response(JSON.stringify({ error: 'Missing auth' }), { status: 401, headers: cors })

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

  // Scoped to the CALLER's own token - used only to find out who is calling and check their permission.
  const callerClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } })
  const { data: { user } } = await callerClient.auth.getUser()
  if (!user) return new Response(JSON.stringify({ error: 'Not signed in' }), { status: 401, headers: cors })

  const { data: callerProfile } = await callerClient.from('profiles').select('level,perms').eq('id', user.id).single()
  const canManageUsers = !!callerProfile && (callerProfile.level === 'Owner' || (callerProfile.perms && callerProfile.perms.users))
  if (!canManageUsers) return new Response(JSON.stringify({ error: 'Not allowed' }), { status: 403, headers: cors })

  // Full power - service role key, only ever used here, never sent to the browser.
  const admin = createClient(supabaseUrl, serviceKey)
  const body = await req.json()
  const action = body.action

  function fakeEmail(name: string) { return name.toLowerCase().replace(/[^a-z0-9]/g, '') + '@gassales.local' }

  if (action === 'create') {
    const { name, password, level, branches, perms, access, phone } = body
    if (!name || !password || password.length < 3) return new Response(JSON.stringify({ error: 'Invalid input' }), { status: 400, headers: cors })
    const { data: created, error: createErr } = await admin.auth.admin.createUser({ email: fakeEmail(name), password, email_confirm: true })
    if (createErr) return new Response(JSON.stringify({ error: createErr.message }), { status: 400, headers: cors })
    const { error: profileErr } = await admin.from('profiles').insert({ id: created.user.id, name, level, branches, perms, access, phone })
    if (profileErr) { await admin.auth.admin.deleteUser(created.user.id); return new Response(JSON.stringify({ error: profileErr.message }), { status: 400, headers: cors }) }
    return new Response(JSON.stringify({ ok: true, id: created.user.id }), { status: 200, headers: cors })
  }

  if (action === 'update') {
    const { id, name, level, branches, perms, access, phone, password } = body
    if (!id) return new Response(JSON.stringify({ error: 'Missing id' }), { status: 400, headers: cors })
    if (password) {
      if (password.length < 3) return new Response(JSON.stringify({ error: 'Password too short' }), { status: 400, headers: cors })
      const { error: pwErr } = await admin.auth.admin.updateUserById(id, { password })
      if (pwErr) return new Response(JSON.stringify({ error: pwErr.message }), { status: 400, headers: cors })
    }
    const { error: profileErr } = await admin.from('profiles').update({ name, level, branches, perms, access, phone }).eq('id', id)
    if (profileErr) return new Response(JSON.stringify({ error: profileErr.message }), { status: 400, headers: cors })
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: cors })
  }

  if (action === 'delete') {
    const { id } = body
    if (!id) return new Response(JSON.stringify({ error: 'Missing id' }), { status: 400, headers: cors })
    const { data: target } = await admin.from('profiles').select('level').eq('id', id).single()
    if (target && target.level === 'Owner') return new Response(JSON.stringify({ error: 'Cannot delete the Owner' }), { status: 400, headers: cors })
    await admin.from('profiles').delete().eq('id', id)
    await admin.auth.admin.deleteUser(id)
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: cors })
  }

  return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400, headers: cors })
})
```

- [ ] **Step 2: Verify locally isn't practical here** (no Deno test harness in this project, and this function needs live Auth/DB access to mean anything) — skip straight to Task 9, Step 2's live end-to-end check, which exercises every branch of this function for real.

---

### Task 9: Deploy the Edge Function

- [ ] **Step 1:** Install the Supabase CLI (one-time, on your computer):

```bash
npm install -g supabase
```

- [ ] **Step 2:** Log in and link the project (run from the `LPG-Gas-App` folder):

```bash
supabase login
supabase link --project-ref <your-project-ref>
```

(`<your-project-ref>` is the part of your Project URL between `https://` and `.supabase.co`, e.g. `xxxxxxxxxxxx`.)

- [ ] **Step 3:** Deploy:

```bash
supabase functions deploy manage-user
```

- [ ] **Step 4: Verify**

Dashboard → **Edge Functions** → confirm `manage-user` shows as deployed. It automatically has access to `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` — Supabase injects these three for you, nothing to configure.

---

### Task 10: Rewrite Manage Users to call the Edge Function

**Files:**
- Modify: `index.html` — `usersUnlock()`, `renderUserList()`, `userEdit()`, `userSave()`, `userDelete()`, `changeMyPw()` (exact line numbers have shifted from Task 6's edits — locate each by function name)

**Scope addition (found during Task 6's review, not in the original spec):** `usersUnlock()` — the gate that asks the Owner to re-enter their password before the Manage Users panel even opens — also depends on `findUser()`/`loadUsers()` and was missed in earlier planning. It's included here since it's part of the same screen this task already rewrites.

- [ ] **Step 1: Replace `usersUnlock()`.** Current version re-checks the current operator's own password via `findUser(operator)`/`me.pw`. New version uses the shared `_selfReauth()` helper — **but `_selfReauth()` is defined in Task 11, not yet done at this point in the plan.** If Task 11 has not been executed yet when this task runs, implement this step's own minimal inline version instead (do not block on Task 11 - the two tasks are independent in the dependency graph, but this one function happens to want the same helper):

```javascript
function usersUnlock(){
  var pw=document.getElementById('usersPw').value;
  var tmp=supabase.createClient(SUPABASE_URL,SUPABASE_ANON_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  tmp.auth.signInWithPassword({email:_fakeEmail(operator),password:pw}).then(function(res){
    tmp.auth.signOut();
    if(res.error){toast('Wrong password',true);return;}
    auditLog('User management opened','Owner opened Manage Users');
    document.getElementById('usersGate').style.display='none';
    document.getElementById('usersPanel').style.display='block';
    renderUserList();
    loadSyncCfgUI();
  });
}
```

(If Task 11 already landed by the time this runs, it's fine — and preferable — to instead write `_selfReauth('Open Manage Users?').then(function(me){ if(!me){toast('Wrong password',true);return;} ...same body... });`, reusing the shared helper instead of this inline disposable-client duplicate. Either is acceptable; don't block one task on the other.)

- [ ] **Step 2: Replace `renderUserList()`** — reads from `profiles` (full row, including perms — this is fine since only a signed-in `users`-permission holder ever reaches this screen, per the existing `usersUnlock()` gate):

```javascript
var _userListCache=[];
function renderUserList(){
  sb.from('profiles').select('*').order('name').then(function(res){
    if(res.error){toast('Could not load users: '+res.error.message,true);return;}
    _userListCache=res.data||[];
    document.getElementById('userList').innerHTML=_userListCache.map(function(u){
      return '<div class="brandCard" style="cursor:pointer" onclick="userEdit(\''+u.id+'\')">'+
        '<div style="display:flex;justify-content:space-between;align-items:center">'+
        '<div><b style="color:var(--navy);font-size:15px">'+u.name+'</b><div style="font-size:12px;color:var(--muted)">'+u.level+' · '+(u.branches||[]).join(', ')+'</div></div>'+
        '<span style="color:var(--steel);font-weight:800">edit ›</span></div></div>';
    }).join('');
  });
}
function _userListFind(id){return _userListCache.filter(function(u){return u.id===id;})[0]||null;}
```

- [ ] **Step 3: Update `userEdit(id)`** — was `userEdit(name)`, now keyed by id (matches the `onclick` above) since names are no longer guaranteed to be the identity key going forward:

Find `function userEdit(name){` (currently `index.html:2510`) and change its first two lines:

```javascript
function userEdit(id){
  ueEditingName=id; // repurposed to hold the id now, not the name - see userSave/userDelete below
  var u=id?_userListFind(id):null;
```

Everything else in the existing `userEdit()` body stays the same (it already just reads fields off `u`).

- [ ] **Step 4: Replace `userSave()`** — same field-collection logic as before, but the final save goes through the Edge Function instead of `saveUsers()`:

```javascript
function userSave(){
  var name=(document.getElementById('ueName').value||'').trim();
  var lvl=document.getElementById('ueLevel').value;
  var pw=document.getElementById('uePw').value;
  if(!name){toast('Enter a name',true);return;}
  var _ph=normalizePhoneZA(document.getElementById('uePhone').value);
  if(!_ph.ok){toast(_ph.msg,true);return;}
  var phone=_ph.value;
  var branches;
  if(lvl==='Owner')branches=['Helderberg','Kleinmond'];
  else if(lvl==='Manager'){branches=[].slice.call(document.querySelectorAll('.ueBr:checked')).map(function(c){return c.value;});if(branches.length===0){toast('Pick at least one branch',true);return;}}
  else branches=[document.getElementById('ueBrOne').value];
  var permsObj={};[].slice.call(document.querySelectorAll('.uePerm')).forEach(function(c){permsObj[c.getAttribute('data-k')]=c.checked?1:0;});
  var accessObj={sections:{},items:{}};
  [].slice.call(document.querySelectorAll('.ueAccSec')).forEach(function(c){accessObj.sections[c.getAttribute('data-sec')]=c.checked?1:0;});
  [].slice.call(document.querySelectorAll('.ueAccItem')).forEach(function(c){var s=c.getAttribute('data-sec');accessObj.items[s]=accessObj.items[s]||{};accessObj.items[s][c.getAttribute('data-item')]=c.checked?1:0;});
  if(lvl==='Owner'){permsObj.users=1;permsObj.audit=1;}
  var existing=ueEditingName?_userListFind(ueEditingName):null;
  if(_userListCache.some(function(u){return u.name===name && u.id!==ueEditingName;})){toast('A user with that name exists',true);return;}

  sb.auth.getSession().then(function(sres){
    var token=sres.data.session.access_token;
    var payload=existing
      ? {action:'update',id:existing.id,name:name,level:lvl,branches:branches,perms:permsObj,access:accessObj,phone:phone,password:pw||undefined}
      : {action:'create',name:name,password:pw,level:lvl,branches:branches,perms:permsObj,access:accessObj,phone:phone};
    if(!existing && (!pw || pw.length<3)){toast('Set a password (min 3 chars)',true);return;}
    sb.functions.invoke('manage-user',{body:payload,headers:{Authorization:'Bearer '+token}}).then(function(res){
      if(res.error || (res.data && res.data.error)){toast('Save failed: '+(res.error?res.error.message:res.data.error),true);return;}
      var beforeSnap=existing?{name:existing.name,level:existing.level,branches:existing.branches.slice()}:null;
      auditLog(existing?'User edited':'User created',(existing?'Edited user "':'Created '+lvl+' "')+name+'"'+(existing?'':' ('+branches.join(', ')+')'),beforeSnap,{name:name,level:lvl,branches:branches,perms:permsObj});
      toast('User saved ✓');backToUserList();
    });
  });
}
```

- [ ] **Step 5: Replace `userDelete()`**:

```javascript
function userDelete(){
  if(!ueEditingName)return;
  var u=_userListFind(ueEditingName);
  if(u&&u.level==='Owner'){toast('Cannot delete the Owner',true);return;}
  if(!confirm('Delete user "'+(u?u.name:'')+'"? This cannot be undone.'))return;
  sb.auth.getSession().then(function(sres){
    var token=sres.data.session.access_token;
    sb.functions.invoke('manage-user',{body:{action:'delete',id:ueEditingName},headers:{Authorization:'Bearer '+token}}).then(function(res){
      if(res.error || (res.data && res.data.error)){toast('Delete failed: '+(res.error?res.error.message:res.data.error),true);return;}
      auditLog('User deleted','Deleted user "'+(u?u.name:'')+'"',u?{name:u.name,level:u.level,branches:u.branches}:null,null);
      toast('User deleted');backToUserList();
    });
  });
}
```

- [ ] **Step 6: Update `changeMyPw()`** — this one changes the *caller's own* password, which Supabase Auth supports directly without going through the Edge Function at all. Uses the shared `_fakeEmail()` helper (added in Task 6):

```javascript
function changeMyPw(){
  var cur=prompt('Enter your CURRENT password:');
  if(cur===null)return;
  var nw=prompt('Enter your NEW password (min 3 characters):');
  if(nw===null)return;
  if(!nw||nw.length<3){toast('New password too short',true);return;}
  var nw2=prompt('Re-enter your NEW password:');
  if(nw2===null)return;
  if(nw!==nw2){toast('New passwords do not match',true);return;}
  sb.auth.signInWithPassword({email:_fakeEmail(operator),password:cur}).then(function(chk){
    if(chk.error){toast('Current password is wrong',true);return;}
    sb.auth.updateUser({password:nw}).then(function(res){
      if(res.error){toast('Could not change password: '+res.error.message,true);return;}
      auditLog('Password change','Changed own password');toast('Your password was changed ✓');
    });
  });
}
```

- [ ] **Step 7: Verify**

First, confirm `usersUnlock()` itself: from the landing screen, tap Manage Users, enter the Owner's real password — confirm it opens the panel (and that a wrong password is rejected before it opens). Then, full round trip in the Browser preview: Manage Users → New user → fill in a test Operator, save → confirm it appears in the list. Edit that same user → change their level to Manager, save → confirm the change stuck. Log out, log back in as that user with their password → confirm it works. Back as Owner: delete the test user → confirm it disappears from the list AND from the login dropdown. Try `changeMyPw()` on the real Owner account with a deliberately wrong "current password" → confirm it's rejected before anything changes.

- [ ] **Step 8: Commit**

```bash
git add index.html supabase/functions/manage-user/index.ts
git commit -m "Wire Manage Users screen to Supabase via manage-user Edge Function"
```

---

### Task 11: Fix password step-up authorization app-wide

**Why this task exists:** beyond Login and Manage Users, the app has ~10 other places where someone re-enters a password mid-workflow to authorize a specific action (Close Day, opening-mismatch Adjustment, the same-day Correction tool, `requireEdit()`'s Owner-unlock, opening a historical day), plus 8 further call sites in **Seal Roll admin** (create/close/cancel/edit/delete a roll, void a seal) that route through the same shared `authGate()` helper. All of these currently search `loadUsers()` for a plaintext password match — once real accounts move to Supabase there is no local list to search, and a password can only be checked against one *specific* named account at a time. Every one of these becomes "pick a name, then enter that person's password" instead of "just type a password." This must happen before Task 12 deletes `loadUsers()`/`saveUsers()`/`findUser()`, since these are exactly the remaining callers Task 12's search step is checking for.

**Files:**
- Modify: `index.html` — see each step below for exact functions/line numbers (current, pre-edit line numbers; they will shift slightly as edits land, so re-locate each function by name if a line number is off by a few lines)

- [ ] **Step 1: Add the shared step-up-auth helpers.** Add near the other Supabase helpers added in Task 5:

```javascript
// ===== STEP-UP PASSWORD AUTHORIZATION (Supabase) =====
// Verifies one specific named person's password without disturbing the currently signed-in
// operator's own session - uses a disposable Supabase client (persistSession:false) that
// touches nothing in localStorage and is discarded immediately after. Resolves to the
// matched profile row, or null on any failure (wrong password, unknown name, or the matched
// profile fails `filterFn`).
function _verifyPersonPassword(name, password, filterFn){
  if(!name || !password) return Promise.resolve(null);
  var tmp = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {auth:{persistSession:false, autoRefreshToken:false}});
  var email = name.trim().toLowerCase().replace(/[^a-z0-9]/g,'')+'@gassales.local';
  return tmp.auth.signInWithPassword({email:email, password:password}).then(function(res){
    if(res.error) return null;
    return sb.from('profiles').select('*').eq('id',res.data.user.id).single().then(function(pres){
      tmp.auth.signOut();
      if(pres.error || !pres.data) return null;
      if(filterFn && !filterFn(pres.data)) return null;
      return pres.data;
    });
  });
}
// Self-reauth: the CURRENTLY signed-in operator confirms their own password. No name step -
// name is fixed to `operator`.
function _selfReauth(actionLabel){
  var pw=prompt(actionLabel+'\n\nEnter YOUR password to authorise:');
  if(pw===null)return Promise.resolve(null);
  return _verifyPersonPassword(operator, pw, null);
}
// Borrow-authority: someone ELSE (meeting filterFn) authorises by entering their own name +
// password. `roleHint` is shown in the name prompt so the operator knows who's eligible.
function _borrowAuth(roleHint, actionLabel, filterFn){
  var name=prompt(actionLabel+'\n\nEnter the '+roleHint+"'s name:");
  if(name===null)return Promise.resolve(null);
  var pw=prompt('Enter '+name+"'s password:");
  if(pw===null)return Promise.resolve(null);
  return _verifyPersonPassword(name, pw, filterFn);
}
```

- [ ] **Step 2: Convert `authGate()`/`verifyElevatedPw()` to async** (`index.html:1918-1931`). Every caller of `authGate()` (8 of them, all Seal Roll admin, Steps 3-4 below) must switch from `var auth=authGate(...); if(!auth)return;` to `authGate(...).then(function(auth){ if(!auth)return; ...rest... });`:

```javascript
function authGate(key, actionLabel){
  if(!perm(key)){toast('You do not have rights for this action ('+(PERM_LABELS[key]||key)+')',true);return Promise.resolve(null);}
  return _selfReauth(actionLabel).then(function(me){
    if(!me)toast('Password does not match your login',true);
    return me;
  });
}
function verifyElevatedPw(pw){
  if(!(perm('seal_boundary')||perm('seal_edit_used')||perm('seal_create')))return Promise.resolve(null);
  return _verifyPersonPassword(operator, pw, null);
}
```

- [ ] **Step 3: Update the 6 simpler Seal Roll callers** (`createRoll`, `closeRollEarly`, `cancelQueued`, `editRoll`, `deleteRoll` — currently `index.html:1085-1194`). Same pattern each time - synchronous setup stays as-is, everything from `var auth=authGate(...)` onward moves inside `.then()`:

```javascript
function createRoll(){
  var brand=document.getElementById('nrBrand').value;
  var s=num(document.getElementById('nrStart').value), e=num(document.getElementById('nrEnd').value);
  var warn=num(document.getElementById('nrWarn').value)||DEFAULT_SEAL_WARN;
  if(!(s>0)||!(e>=s)){toast('Enter a valid start/end range',true);return;}
  var willQueue=!!activeRoll(adminBranch);
  var summ='Create '+(willQueue?'and QUEUE':'and ACTIVATE')+' this roll?\n\n'+brand+' · '+adminBranch+'\nSeals '+s+'–'+e+' ('+(e-s+1)+' total)\nWarn at '+warn+' left'+(willQueue?'\n\n(A roll is already active — this one will queue behind it.)':'');
  authGate('seal_create', summ).then(function(auth){
    if(!auth)return;
    var rolls=sealsLoad();
    var clash=rolls.some(function(r){return r.branch===adminBranch&&r.brand===brand&&r.status!=='Closed'&&r.status!=='Depleted'&&!(e<r.start||s>r.end);});
    if(clash){toast('Range overlaps an existing active/queued roll for this brand',true);return;}
    var hasActive=!!activeRoll(adminBranch);
    var roll={id:newRollId(),branch:adminBranch,brand:brand,start:s,end:e,warnAt:warn,
      status:hasActive?'Queued':'Active',createdBy:operator,createdAt:nowStamp()};
    if(roll.status==='Queued' && queuedRoll(adminBranch)){toast('A roll is already queued for this branch. Close/deplete the active one first.',true);return;}
    rolls.push(roll);sealsSave(rolls);
    auditLog('Seal roll created',adminBranch+' '+brand+' '+s+'–'+e+' ('+roll.status+') by '+auth.name);
    syncPushRoll(roll, roll.status==='Active'?'ACTIVATED':'QUEUED');
    toast('Roll '+s+'–'+e+' '+(roll.status==='Active'?'activated':'queued')+' ✓');
    document.getElementById('nrStart').value='';document.getElementById('nrEnd').value='';document.getElementById('nrWarn').value='';
    renderRolls();
  });
}
function closeRollEarly(id){
  authGate('seal_create','Close this roll early?\nEnds it before all seals are used. A queued roll (if any) becomes active.').then(function(auth){
    if(!auth)return;
    var reason=prompt('Reason for closing early (required):');
    if(!reason||!reason.trim()){toast('A reason is required',true);return;}
    var rolls=sealsLoad();var idx=rolls.findIndex(function(x){return x.id===id;});
    if(idx<0)return;
    rolls[idx].status='Closed';rolls[idx].closedBy=auth.name;rolls[idx].closedAt=nowStamp();rolls[idx].closeReason=reason.trim();
    sealsSave(rolls);
    auditLog('Seal roll closed early',rolls[idx].brand+' '+rolls[idx].start+'–'+rolls[idx].end+' by '+auth.name+' — '+reason.trim());
    syncPushRoll(rolls[idx],'CLOSED');
    promoteQueued(rolls[idx].branch);
    renderRolls();
  });
}
function cancelQueued(id){
  var r=sealsLoad().find(function(x){return x.id===id;});
  if(r && rollUsedCount(id)>0){toast('This roll has recorded seals — close it, do not cancel',true);return;}
  authGate('seal_create','Cancel this queued roll?').then(function(auth){
    if(!auth)return;
    var rolls=sealsLoad().filter(function(x){return x.id!==id;});sealsSave(rolls);
    auditLog('Queued roll cancelled',id+' by '+auth.name);renderRolls();
  });
}
function editRoll(id){
  var rolls=sealsLoad();var r=rolls.find(function(x){return x.id===id;});if(!r)return;
  var used=rollUsedCount(id);
  var key=(used>0)?'seal_edit_used':'seal_create';
  if(used>0 && !perm('seal_edit_used')){toast('This roll has '+used+' recorded seal(s). Editing it rewrites audit history — owner rights required.',true);return;}
  var ns=prompt('Edit START seal for '+r.brand+' '+r.start+'–'+r.end+':',r.start);
  if(ns===null)return; ns=num(ns);
  var ne=prompt('Edit END seal:',r.end);
  if(ne===null)return; ne=num(ne);
  if(!(ns>0)||!(ne>=ns)){toast('Invalid range',true);return;}
  if(used>0 && (ns>r.start || ne<Math.max.apply(null,rollUsedList(id)))){toast('New range must still contain all '+used+' seals already used',true);return;}
  authGate(key,'Edit roll range to '+ns+'–'+ne+'?'+(used>0?'\n\nWARNING: '+used+' seals already recorded against this roll.':'')).then(function(auth){
    if(!auth)return;
    var oldr=r.start+'–'+r.end;
    r.start=ns;r.end=ne;sealsSave(rolls);
    auditLog('Seal roll edited',oldr+' → '+ns+'–'+ne+' ('+r.brand+' '+r.branch+') by '+auth.name);
    syncPushRoll(r,'EDITED');
    renderRolls();
  });
}
function deleteRoll(id){
  var used=rollUsedCount(id);
  var authPromise, forced=(used>0);
  if(used>0){
    if(!perm('seal_edit_used')){toast('This roll has '+used+' recorded seal(s) and cannot be deleted — close it instead (owner rights needed to force-delete).',true);return;}
    authPromise=authGate('seal_edit_used','FORCE-DELETE a roll with '+used+' recorded seals?\nThis ORPHANS those refills in the master recon. Prefer Close.');
  } else {
    authPromise=authGate('seal_create','Delete this unused roll?');
  }
  authPromise.then(function(authD){
    if(!authD)return;
    var r=sealsLoad().find(function(x){return x.id===id;});
    var wasActive=r&&r.status==='Active';
    var rolls=sealsLoad().filter(function(x){return x.id!==id;});sealsSave(rolls);
    var uo=sealUsedLoad();if(uo[id]){delete uo[id];sealUsedSave(uo);}
    auditLog('Seal roll deleted',id+(forced?(' (FORCED, '+used+' seals orphaned)'):'')+' by '+authD.name);
    if(wasActive)promoteQueued(r.branch);
    renderRolls();
  });
}
```

- [ ] **Step 4: Update `voidSeal()` and its caller `doVoidSeal()`** (`index.html:1955-1985` and `:1328-1333`). `voidSeal` currently returns a plain boolean synchronously - it now returns a Promise<boolean>, so its caller needs a `.then()` too:

```javascript
function voidSeal(branch, seal, dayIsClosed){
  seal=num(seal);
  var key=dayIsClosed?'seal_edit_used':'seal_void_open';
  if(!perm(key)){toast(dayIsClosed?'Voiding a closed-day seal needs owner rights':'You lack seal-void rights',true);return Promise.resolve(false);}
  var mode=prompt('Void seal '+seal+' on '+branch+'.\n\nType R = number REUSABLE (mis-entry, seal still good)\nType B = seal DESTROYED / lost (retire the number)\n\nR or B:');
  if(mode===null)return Promise.resolve(false);
  mode=(mode||'').trim().toUpperCase();
  if(mode!=='R'&&mode!=='B'){toast('Type R or B',true);return Promise.resolve(false);}
  return authGate(key,'Void seal '+seal+' ('+(mode==='R'?'reusable':'destroyed')+')'+(dayIsClosed?' on a CLOSED day':'')+'?').then(function(auth){
    if(!auth)return false;
    var r=activeRoll(branch)||sealsLoad().filter(function(x){return x.branch===branch;}).sort(function(a,b){return b.start-a.start;})[0];
    var uo=sealUsedLoad();
    if(r&&uo[r.id]){var i=uo[r.id].indexOf(seal);if(i>-1)uo[r.id].splice(i,1);sealUsedSave(uo);}
    if(mode==='B'){
      var retired=[];try{retired=JSON.parse(localStorage.getItem('gs_seal_retired')||'[]');}catch(e){}
      retired.push({branch:branch,seal:seal});try{localStorage.setItem('gs_seal_retired',JSON.stringify(retired));}catch(e){}
    }
    auditLog('Seal voided',seal+' on '+branch+' — '+(mode==='R'?'REUSABLE':'DESTROYED')+(dayIsClosed?' (closed day)':'')+' by '+auth.name);
    var origSize='',origDate=(dayIsClosed?'(closed day)':today),origBrand='';
    var _rf=(store.refill||[]).filter(function(x){return num(x.seal)===seal && (!x.branch||x.branch===branch);})[0];
    if(_rf){origSize=_rf.size||'';origBrand=_rf.brand||'';}
    syncPush('Adjustments',[{date:today||'',branch:branch,Kind:'SEAL_VOID',
      Line:'seal '+seal+(origSize?(' ('+origSize+(origBrand?' '+origBrand:'')+')'):''),
      From:String(seal),To:(mode==='R'?'reusable':'retired'),
      Reason:'void'+(dayIsClosed?' [closed-day, orig '+origDate+']':''),By:auth.name}]);
    toast('Seal '+seal+' voided ('+(mode==='R'?'reusable':'retired')+')');
    return true;
  });
}
function doVoidSeal(){
  var sn=num(document.getElementById('voidSealNo').value);
  if(!(sn>0)){toast('Enter a seal number',true);return;}
  var closed=document.getElementById('voidClosedDay').checked;
  voidSeal(adminBranch, sn, closed).then(function(ok){
    if(ok){document.getElementById('voidSealNo').value='';document.getElementById('voidClosedDay').checked=false;renderRolls();renderUsedSeals();}
  });
}
```

- [ ] **Step 5: Update `unlockSig()`** (`index.html:4555-4573`) - a signature box accepts anyone at the matching level, or an Owner override, so it needs a name step too:

```javascript
function unlockSig(id){
  var boxLabel=(id==='sigOp')?'Operator':'Manager';
  var wantLevel=(id==='sigOp')?'Operator':'Manager';
  var name=prompt('Sign '+boxLabel+' box\n\nEnter the name of the person signing (an Owner may also sign either box):');
  if(name===null)return;
  askPassword('Sign '+boxLabel+' box','Enter '+name+"'s password:").then(function(pw){
    if(pw===null)return;
    _verifyPersonPassword(name, pw, function(p){return p.level==='Owner'||p.level===wantLevel;}).then(function(u){
      if(!u){toast('Wrong password for '+boxLabel+' box',true);return;}
      var signer=(u.level==='Owner')?(u.name+' (Owner override)'):u.name;
      sigUnlocked[id]=true;sigSignedBy[id]=signer;
      __unlockSigApply(id,signer);
    });
  });
}
```

`__unlockSigApply()` itself is unchanged.

- [ ] **Step 6: Update `requireEdit()`** (`index.html:4816-4823`) and its 3 callers (`openCount()`, `openReceived()`, `openCap()`):

```javascript
function requireEdit(){
  if(canEdit())return Promise.resolve(true);
  return _borrowAuth('Owner','You do not have capture/edit rights.', function(p){return p.level==='Owner';}).then(function(owner){
    if(owner){editUnlocked=true;auditLog('Edit unlocked','Owner unlocked editing on '+branch+' (via '+operator+')');toast('Editing unlocked ✓');return true;}
    toast('Wrong Owner password',true);return false;
  });
}
```

`openCount()` (`index.html:2665-2701`) already has its own two `askPassword().then()` blocks for its other two authorization checks (extra-count-after-close, no-previous-close) - fold all three into one rewrite:

```javascript
function openCount(){
  if(!canUseSection(branch||'Helderberg','count')){toast(sectionActive(branch||'Helderberg','count')?'Stock Count is not enabled for your user':'Stock Count is deactivated for '+(branch||'this branch'),true);return;}
  requireEdit().then(function(ok){
    if(!ok)return;
    // #2 A day already closed for today+branch requires Owner override to count again
    if(loadSavedDay(today,branch) && !store._extraCountAuth){
      _borrowAuth('Owner','A stock count was already closed for '+branch+' today.',function(p){return p.level==='Owner';}).then(function(owner){
        if(!owner){toast('Owner password required for an additional count',true);return;}
        store._extraCountAuth=true;
        auditLog('Additional count authorised','Owner authorised a second same-day count for '+branch);
        toast('Additional count unlocked ✓');
        openCount(); // re-enter now that auth flag is set
      });
      return;
    }
    cBranch=branch||'Helderberg';
    // #1/#3 If no previous close exists to compare an Opening count against, a Manager/Owner must authorise
    if(!cHasPrevClose(cBranch) && !store._noPrevAuth){
      _borrowAuth('Manager or Owner','No previous day close exists for '+cBranch+' to check the opening count against.',function(p){return p.level==='Manager'||p.level==='Owner';}).then(function(auth){
        if(!auth){toast('Manager or Owner password required to proceed',true);return;}
        store._noPrevAuth=true;
        auditLog('Count authorised (no prev close)',auth.name+' authorised counting with no previous close for '+cBranch);
        toast('Count authorised ✓');
        openCount(); // re-enter now that auth flag is set
      });
      return;
    }
    applyBranchLock('cbr-',cBranch);
    document.getElementById('hTitle').textContent='Stock Count';
    document.getElementById('hSub').textContent='Tap Full or Empty on a size';
    document.getElementById('backBtn').style.display='block';
    cShow('countGridView');cRenderGrid();window.scrollTo(0,0);
    _saveCurrentSection('count');
  });
}
```

`openReceived()` (`index.html:3296-3306`):

```javascript
function openReceived(){
  if(!canUseSection(branch||'Helderberg','received')){toast(sectionActive(branch||'Helderberg','received')?'Stock Received is not enabled for your user':'Stock Received is deactivated for '+(branch||'this branch'),true);return;}
  requireEdit().then(function(ok){
    if(!ok)return;
    rBranch=branch||'Helderberg';
    applyBranchLock('rbr-',rBranch);
    document.getElementById('hTitle').textContent='Stock Received';
    document.getElementById('hSub').textContent='Full received vs empty returned';
    document.getElementById('backBtn').style.display='block';
    rShow('recvGridView');rRenderGrid();rLoadSuppliers();window.scrollTo(0,0);
    _saveCurrentSection('received');
  });
}
```

`openCap(type,opts)` (`index.html:3683` onward - a longer function with draft resume/discard logic that continues well past this point): apply the **exact same transformation** as `openReceived()` above and nothing else - change line `if(!requireEdit())return;` to `requireEdit().then(function(ok){` `if(!ok)return;`, then move the function's own final closing `}` so it now closes this new `.then()` callback instead (i.e. add one more `});` at the very end of the function, right before its existing closing brace). Do not alter any other line in `openCap()`'s body - this is a pure wrap, not a rewrite. After editing, use the syntax check in Step 8 to confirm the braces balance.

- [ ] **Step 7: Update `closeDay()`, `openCorrection()`, `adjustMismatch()`, `viewSavedDay()`.**

`closeDay()` (`index.html:4642-...`) already uses a flag-and-recursive-re-entry pattern (`store._closeAuth`) identical to `openCount()`'s - replace only its auth block, leave everything before and after (manifold balance gate, day summary, etc.) completely untouched:

```javascript
  // Close Day requires: an authoriser WITH close-day permission + the high-risk second password
  if(!store._closeAuth){
    var name=prompt('Close Day — name of a person with Close-Day permission:');
    if(name===null)return;
    var pw=prompt("Enter "+name+"'s password:");
    if(pw===null)return;
    _verifyPersonPassword(name, pw, function(p){return userPerms(p).closeday;}).then(function(auth){
      if(!auth){toast('A Close-Day-authorised password is required',true);return;}
      if(!checkHighRisk('Close Day'))return;
      store._closeAuth=auth.name+' ('+auth.level+')';
      closeDay(); // re-enter now that auth flag is set
    });
    return;
  }
```

`openCorrection()` (`index.html:4933-4943`, complete function - short, full rewrite):

```javascript
function openCorrection(cfg){
  if(!perm('edit')){toast('You do not have edit/correct rights',true);return;}
  _borrowAuth('Manager or Owner','Log a correction?',function(p){return p.level==='Manager'||p.level==='Owner';}).then(function(auth){
    if(!auth){toast('Manager or Owner password required',true);return;}
    corrCfg=cfg;corrAuth=auth;
    document.getElementById('corrTitle').textContent=cfg.title||'Log a correction';
    document.getElementById('corrModal').classList.add('show');
    corrStepSection();
  });
}
```

`adjustMismatch(i)` (`index.html:5143-5192`, complete function - full rewrite):

```javascript
function adjustMismatch(i){
  if(!perm('adjust')){toast('You do not have adjust rights',true);return;}
  var mmList=(store._openMismatch||[]).filter(function(m){return m.branch===histBranch;});
  var m=mmList[i];if(!m)return;
  _borrowAuth('Manager or Owner','Log this adjustment?',function(p){return userPerms(p).adjust;}).then(function(auth){
    if(!auth){toast('An adjust-authorised password is required',true);return;}
    var bc=m.branch, oldVal, correct, itemLabel;
    if(m.kind==='manifold'){
      itemLabel='Manifold '+m.cyl;
      var nv=prompt('Correct OPENING gas-left (kg) for '+m.cyl+'\n(previous close was '+m.expected+'kg, counted '+m.counted+'kg):', String(m.counted));
      if(nv===null)return;
      correct=num(nv);
      var reason=prompt('Reason / note for this correction (required):');
      if(reason===null)return; if(!reason.trim()){toast('A reason is required',true);return;}
      var mrow=store.manifold.filter(function(r){return r.stage==='Opening'&&r.cyl===m.cyl&&(!r.branch||r.branch===bc);})[0];
      oldVal=mrow?mrow.gasLeft:m.counted;
      if(mrow){mrow.gasLeft=correct;mrow.scale=num(mrow.tare)+correct;mrow._adjusted=true;}
      m.resolved=true;m.counted=correct;m.adjustedTo=correct;
      m.adjustNote='Adj by '+auth.name+' ('+auth.level+') → '+correct+'kg: '+reason.trim();
      m.adjustedBy=auth.name;m.adjustedAt=nowStamp();
      auditLog('Manifold mismatch adjusted',m.cyl+' — prev close '+m.expected+'kg, counted '+oldVal+'kg, corrected to '+correct+'kg · '+reason.trim(),
        {prevClose:m.expected,counted:oldVal},{correctedOpening:correct,reason:reason.trim()});
    } else {
      var st=m.state, sz=m.size, br=m.brand;
      itemLabel=sz+' '+st+' '+br;
      var nv2=prompt('Correct OPENING quantity for '+sz+' '+st+' '+br+'\n(previous close was '+m.expected+', operator counted '+m.counted+'):', String(m.counted));
      if(nv2===null)return;
      correct=num(nv2);
      var reason2=prompt('Reason / note for this correction (required):');
      if(reason2===null)return; if(!reason2.trim()){toast('A reason is required',true);return;}
      var row=store.count.filter(function(r){return r.countType==='Opening'&&r.state===st&&r.size===sz&&r.brand===br&&(!r.branch||r.branch===bc);})[0];
      oldVal=row?row.qty:m.counted;
      if(row){row.qty=correct;row._adjusted=true;}
      else{store.count.push({countType:'Opening',state:st,size:sz,brand:br,qty:correct,branch:bc,_adjusted:true,_date:today});}
      m.resolved=true;m.counted=correct;m.adjustedTo=correct;
      m.adjustNote='Adj by '+auth.name+' ('+auth.level+') → '+correct+': '+reason2.trim();
      m.adjustedBy=auth.name;m.adjustedAt=nowStamp();
      var lockKey=bc+'|Opening|'+st+'|'+sz+'|'+br;
      delete cLocked[lockKey];cTries[lockKey]=0;
      auditLog('Opening mismatch adjusted',sz+' '+st+' '+br+' — prev close '+m.expected+', counted '+oldVal+', corrected to '+correct+' · '+reason2.trim(),
        {prevClose:m.expected,counted:oldVal},{correctedOpening:correct,reason:reason2.trim()});
      syncPush('Adjustments',[{date:today,branch:bc,Kind:'OpeningMismatch',Line:sz+' '+st+' '+br,From:oldVal,To:correct,Reason:reason2.trim(),By:auth.name+' ('+auth.level+')'}]);
    }
    saveWorkingStore();
    toast(itemLabel+' corrected to '+correct+' ✓');
    openHistory();
  });
}
```

`viewSavedDay(ds)` (`index.html:5234-...`) already uses a bypass-and-recursive-re-entry flag (`store._auditBypass`, see `viewSavedDayNoAuth()` right above it) - replace only its auth block the same way as `closeDay()`, leave everything from `calSelDate=ds;renderCalendar();` onward (the actual historical-day rendering) completely untouched:

```javascript
function viewSavedDay(ds){
  // Only Manager or Owner may open historical days, with password
  if(!perm('history')){toast('You do not have permission to open historical counts',true);return;}
  if(!store._auditBypass){
    var eligibleNow=(role==='Manager'||role==='Owner');
    var authPromise=eligibleNow
      ? _selfReauth('Open the count for '+ds+'?')
      : _borrowAuth('Owner','Open the count for '+ds+'?',function(p){return p.level==='Owner';});
    authPromise.then(function(auth){
      if(!auth){toast('Wrong password',true);return;}
      auditLog('Historical count opened','Opened saved count for '+ds+' ('+branch+')');
      store._auditBypass=true;viewSavedDay(ds);store._auditBypass=false;
    });
    return;
  }
  calSelDate=ds;renderCalendar();
  // ...everything below this line in the original function is unchanged...
```

- [ ] **Step 8: Fix 6 more self-reauth call sites, found during Task 6's code review (not in the original scoping pass).** These all follow the SELF-reauth pattern (the current operator confirms their own password, no name step needed - `_selfReauth()` or `_verifyPersonPassword(operator, pw, ...)` directly) rather than the borrow-authority pattern used above. Each one already uses the app's own `askPassword()` modal (not a plain `prompt()`), which is preserved unchanged - only the verification mechanism underneath changes.

`adminTab(t)` (search `function adminTab(t){`) - unlocking any Admin sub-tab (Seals, Suppliers, Clear Stock Take, Branch Setup, Manage Suppliers, Count Times):

```javascript
function adminTab(t){
  if(t==='faulty'){
    if(!(perm('faultyCapture')||perm('faultyRegister'))){toast('You do not have rights for Faulty Cylinders',true);return;}
    _adminTabShow(t);
    return;
  }
  var permKey=ADMIN_TAB_PERM[t];
  if(permKey && !(role==='Owner'||perm(permKey))){toast('You do not have rights for '+ADMIN_TAB_NAME[t],true);return;}
  askPassword('Unlock '+ADMIN_TAB_NAME[t], 'Enter your password to open '+ADMIN_TAB_NAME[t]+':').then(function(pw){
    if(pw===null)return;
    _verifyPersonPassword(operator, pw, null).then(function(me){
      if(!me){toast('Wrong password',true);return;}
      _adminTabShow(t);
    });
  });
}
```

`doClearStockTake()` (search `function doClearStockTake(){`) - only the auth block changes, everything before and after (date/area/branch collection, the `confirm()`, the call to `_clearStockTakeDo`) is unchanged:

```javascript
  if(!confirm('Clear '+areas.join(', ')+'\nfor '+branches.join(' & ')+'\non '+date+'?\n\nThis deletes the data on this device AND in the Google Sheet. Cannot be undone.'))return;
  askPassword('Owner authorisation','Owner password to authorise this deletion:').then(function(pw){
   if(pw===null)return;
   _verifyPersonPassword(operator, pw, null).then(function(me){
     if(!me || !(role==='Owner'||perm('seal_edit_used'))){toast('Not authorised',true);return;}
     _clearStockTakeDo(date,brSel,areas,branches);
   });
  });
```

`faultyShowSub(sub)` (search `function faultyShowSub(sub){`) - only the `sub==='register'` branch's auth block changes:

```javascript
  if(sub==='register'){
    if(!perm('faultyRegister')){toast('You do not have Faulty Register rights',true);return;}
    askPassword('Open Faulty Register','Enter your password to open the Open Register:').then(function(pw){
      if(pw===null)return;
      _verifyPersonPassword(operator, pw, null).then(function(me){
        if(!me){toast('Wrong password',true);return;}
        _faultyShowSub('register');
      });
    });
    return;
  }
```

`sealBoundaryOverride(msg)` (search `function sealBoundaryOverride(msg){`) - already returns a Promise, so none of ITS callers need any change, only its own body:

```javascript
function sealBoundaryOverride(msg){
  if(!perm('seal_boundary')){toast('You do not have rights for this action ('+(PERM_LABELS.seal_boundary||'seal_boundary')+')',true);return Promise.resolve(false);}
  return askPassword('Authorise override', msg+'\n\nThis records an out-of-roll seal. Enter YOUR password to authorise:').then(function(pw){
    if(pw===null)return false;
    return _verifyPersonPassword(operator, pw, null).then(function(me){
      if(!me){toast('Password does not match your login',true);return false;}
      auditLog('Seal boundary override','By '+me.name+' ('+me.level+') — '+capBranch+' — '+msg);
      syncPush('Adjustments',[{date:today||'',branch:capBranch,Kind:'SEAL_OVERRIDE',Line:msg,From:'',To:'',Reason:'boundary override',By:me.name}]);
      toast('Override authorised by '+me.name);
      return true;
    });
  });
}
```

`auditUnlock()` (search `function auditUnlock(){`), complete function:

```javascript
function auditUnlock(){
  var pw=document.getElementById('auditPw').value;
  _verifyPersonPassword(operator, pw, null).then(function(me){
    if(!me){toast('Wrong password',true);return;}
    auditLog('Audit opened','Owner opened the audit report');
    document.getElementById('auditGate').style.display='none';
    document.getElementById('auditDateList').style.display='block';
    renderAuditDates();
  });
}
```

`idleUnlock()` (search `function idleUnlock(){`), complete function:

```javascript
function idleUnlock(){
  if(!idleLockActive)return;
  var pw=document.getElementById('idleLockPw').value;
  _verifyPersonPassword(operator, pw, null).then(function(u){
    if(!u){toast('Wrong password',true);return;}
    idleLockActive=false;
    document.getElementById('idleLockOverlay').style.display='none';
    document.getElementById('idleLockPw').value='';
    auditLog('Idle unlock','Resumed after idle lock');
    _armIdleTimer();
  });
}
```

**Known tradeoff worth being aware of (not a bug):** unlocking after the idle lock now requires a live network round-trip to Supabase, where before it was purely local/instant. On a normal connection this is not noticeable; on a genuinely dead connection, the idle-lock screen would not be unlockable until connectivity returns. This is an inherent consequence of moving real authentication off the device, not something to fix here - flag it if it becomes a real problem in practice.

- [ ] **Step 9: Verify**

`node -e "new Function(...)"` syntax check (same command as earlier tasks) - expect no output; if it fails, the most likely cause is a brace mismatch from the `openCap()` wrap in Step 6 or the `closeDay()`/`viewSavedDay()` partial edits in Step 7 - re-check those first.

Then, in the Browser preview, exercise every path end-to-end (use the Owner account from Task 4, and if possible a second test Manager/Operator account created via Task 10's now-working Manage Users screen, to test the "borrow someone else's authority" prompts for real): Seal Roll admin - create a roll, edit it, close it early, void a seal, delete an unused roll (all should now ask for a name then a password, and reject a wrong password without granting access); Stock Count - trigger the "no previous close" and "additional count after close" prompts; Close Day - confirm the Close-Day-permission name+password prompt works and still runs `checkHighRisk()` after; the same-day Correction tool and the opening-mismatch Adjustment tool - confirm both ask for a Manager/Owner name+password; History - open a past saved day as a Manager/Owner (self password) and confirm the Owner-override path also still works; **and, from Step 8:** each Admin sub-tab unlock, Clear Stock Take, opening the Faulty Register, a Seal boundary override (if reachable in test data), the Audit Log unlock, and the idle-lock screen (wait for the 3-minute idle timeout or trigger it directly) - each should now accept only the current operator's own real password.

- [ ] **Step 10: Commit**

```bash
git add index.html
git commit -m "Convert all password step-up authorization to Supabase (Seal Roll, Close Day, Corrections, Adjustments, edit-unlock, history)"
```

---

### Task 12: Remove the old localStorage account code

**Files:**
- Modify: `index.html` — delete `loadUsers()`, `saveUsers()`, `findUser()` (`:1894-1896`), `createOwner()` (`:2277`), and the `setupCard` HTML block referenced by it (search for `id="setupCard"`)

- [ ] **Step 1:** Search the whole file for any remaining caller of `loadUsers`, `saveUsers`, or `findUser` — every real caller should already be gone after Tasks 6–11 rewired them. If Claude's search turns up anything left over, resolve it before deleting (don't delete out from under a still-live caller).

- [ ] **Step 2:** Delete the three functions and `createOwner()`. Remove the `setupCard` HTML block and its "Create the first Owner" wiring (the account bootstrap now happens once, by hand, in Task 4 — not from inside the app).

- [ ] **Step 3: Verify**

`node -e "new Function(...)"` syntax check — expect no output. Full click-through of the app in the Browser preview: login, Manage Users (create/edit/delete), logout, reload-resume, plus every step-up-auth flow from Task 11's Step 8 — repeated once more now that the old code path is gone, to confirm nothing was silently still depending on it.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "Remove old localStorage-only account code"
```

---

### Task 13: Migrate the real people

Not code — a one-time, by-hand task using the now-working Manage Users screen.

- [ ] **Step 1:** Using the Manage Users screen (as the Owner account from Task 4), create one real account per real person — every current Manager and Operator, matching their current name/level/branch/permissions from today's `localStorage`-based setup on each device.
- [ ] **Step 2:** Give each person their new password directly (not over an insecure channel like unencrypted WhatsApp/SMS — in person or a phone call is safest for now; a proper "invite a new user by SMS" flow is a reasonable future Phase 1.5 addition, not required for this migration).
- [ ] **Step 3:** Have at least one Manager and one Operator actually log in on their own phone with their new account, on their normal working branch, before decommissioning nothing — the old `localStorage` accounts stay harmless and unused on each device (nothing deletes them), so there's no rush and no risk in running both side by side briefly if someone's still getting used to the new login.

---

## Self-review

**Spec coverage check** — every Phase 1 item from `docs/superpowers/specs/2026-08-16-supabase-migration-design.md` maps to a task: "pick your name, type a password" UX preserved exactly (Task 6) ✓; hidden internally-generated email (Tasks 6, 8, 10, 11) ✓; permission-list checkpoint before building (Task 1) ✓; accounts created fresh through a real Manage Users screen (Tasks 10, 13) ✓; session persists across restarts (Task 7) ✓; free at this scale (nothing in this plan needs a paid Supabase tier) ✓.

**Scope note vs. the original spec:** the spec said "only the login screen and Manage Users screen change... every capture workflow is untouched." Task 11 was added after discovering that ~18 password-reentry prompts scattered through Seal Roll admin, Close Day, Corrections, and Adjustments all depend on the same `loadUsers()`-based mechanism the login rewrite removes — leaving them out would have silently broken those features the moment Task 12 deletes `loadUsers()`. This was raised with and approved by the user before being added; it doesn't change what those features *do*, only how they're authorized (name+password instead of password-only).

**What Phase 1 deliberately does not do** (Phase 2's job, not a gap in this plan): no Row Level Security on the capture-data tables (none exist yet — Phase 3), and `profiles` itself only has a coarse "any signed-in person can read, only the Edge Function can write" rule rather than fine-grained per-role policies. That's intentional — the design spec calls this out as Phase 2 explicitly.

**Type consistency check:** `authGate()`, `voidSeal()`, and `requireEdit()` all change from synchronous (return a value) to asynchronous (return a `Promise`) — every one of their callers is updated in the same task (Task 11) to use `.then()`, none left on the old synchronous calling convention. `_verifyPersonPassword`/`_selfReauth`/`_borrowAuth` (Task 11) and `sb`/`SUPABASE_URL`/`SUPABASE_ANON_KEY` (Task 5) are used consistently by name across every task from Task 6 onward.
