import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

Deno.serve(async (req) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type' }
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    // Full power - service role key, only ever used here, never sent to the browser.
    const admin = createClient(supabaseUrl, serviceKey)
    const body = await req.json()
    const action = body.action

    // The caller's own session token, sent in the JSON body rather than an Authorization/apikey
    // header - some networks/security software silently block requests carrying an "apikey"-named
    // header to unfamiliar API domains, which broke the header-based version of this check for at
    // least one real user.
    const callerToken = body.callerToken
    if (!callerToken) return new Response(JSON.stringify({ error: 'Missing auth' }), { status: 401, headers: cors })

    // Legacy-format anon key, hardcoded deliberately (this key is DESIGNED to be public - it's
    // already visible in index.html's own source). The auto-injected SUPABASE_ANON_KEY env var for
    // this project is the newer short "publishable" key format (sb_publishable_...), which the Auth
    // verification path below does not currently accept correctly - confirmed via live diagnostic
    // logging (identical "Auth session missing!" failure from two different verification methods,
    // both traced back to this one key). Regular database queries (profiles/login_names) work fine
    // with the new key format; only this specific Auth check needs the legacy one. If Supabase later
    // fixes Auth verification for the new key format, this can be reverted to the env var.
    const legacyAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp5eW1ua3ljaGhnbGlzcWp2a3FzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY5OTI2ODcsImV4cCI6MjEwMjU2ODY4N30.bkmpU3v4aRw_9rR4CWNAYYoUq-IOD8IAC0BZnwga-ko'

    // ===== TEMPORARY comprehensive diagnostics - decode the token's own claims without verifying
    // it (just to see what's actually inside it), then try three independent ways of checking it,
    // logging the FULL raw result (not just .message) for each. =====
    try {
      const parts = callerToken.split('.')
      const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')))
      console.log('DEBUG token claims:', JSON.stringify({ iss: payload.iss, aud: payload.aud, exp: payload.exp, now: Math.floor(Date.now()/1000), sub: payload.sub, role: payload.role }))
    } catch (decodeErr) {
      console.log('DEBUG token decode failed:', String(decodeErr))
    }

    const callerClient = createClient(supabaseUrl, legacyAnonKey)
    let getUserResult
    try {
      getUserResult = await callerClient.auth.getUser(callerToken)
      console.log('DEBUG getUser raw result:', JSON.stringify(getUserResult))
    } catch (getUserErr) {
      console.log('DEBUG getUser THREW:', String(getUserErr), getUserErr instanceof Error ? getUserErr.stack : '')
      getUserResult = { data: { user: null }, error: { message: String(getUserErr) } }
    }

    // Also try a completely raw fetch to the Auth API, bypassing the SDK entirely, to rule out an
    // SDK-specific bug.
    try {
      const rawRes = await fetch(supabaseUrl + '/auth/v1/user', {
        headers: { 'Authorization': 'Bearer ' + callerToken, 'apikey': legacyAnonKey }
      })
      const rawBody = await rawRes.text()
      console.log('DEBUG raw fetch to /auth/v1/user status:', rawRes.status, 'body:', rawBody.slice(0, 300))
    } catch (rawErr) {
      console.log('DEBUG raw fetch THREW:', String(rawErr))
    }
    // ===== end temporary diagnostics =====

    const user = getUserResult.data?.user
    if (!user) return new Response(JSON.stringify({ error: 'Not signed in' }), { status: 401, headers: cors })

    const { data: callerProfile } = await admin.from('profiles').select('level,perms').eq('id', user.id).single()
    const callerIsOwner = !!callerProfile && callerProfile.level === 'Owner'
    const canManageUsers = callerIsOwner || (!!callerProfile && !!callerProfile.perms && !!callerProfile.perms.users)
    if (!canManageUsers) return new Response(JSON.stringify({ error: 'Not allowed' }), { status: 403, headers: cors })

    function fakeEmail(name: string) { return name.toLowerCase().replace(/[^a-z0-9]/g, '') + '@gassales.local' }
    // A caller who only has the delegated 'manage users' permission (not full Owner) may manage
    // Operator/Manager accounts, but must never be able to create/promote someone to Owner, grant
    // Owner-equivalent permissions (users/audit) to anyone including themselves, or touch an
    // existing Owner account at all. Only a real Owner caller may do any of those. This is the one
    // security boundary this whole function exists to enforce - every write path below respects it.
    function ownerEquivalentPerms(p: any) { return !!p && (!!p.users || !!p.audit) }

    if (action === 'create') {
      const { name, password, level, branches, perms, access, phone } = body
      if (!name || !password || password.length < 3) return new Response(JSON.stringify({ error: 'Invalid input' }), { status: 400, headers: cors })
      if (!callerIsOwner && (level === 'Owner' || ownerEquivalentPerms(perms))) {
        return new Response(JSON.stringify({ error: 'Only an Owner can create an Owner account or grant Owner-level permissions' }), { status: 403, headers: cors })
      }
      const { data: created, error: createErr } = await admin.auth.admin.createUser({ email: fakeEmail(name), password, email_confirm: true })
      if (createErr) return new Response(JSON.stringify({ error: createErr.message }), { status: 400, headers: cors })
      const { error: profileErr } = await admin.from('profiles').insert({ id: created.user.id, name, level, branches, perms, access, phone })
      if (profileErr) {
        const { error: rollbackErr } = await admin.auth.admin.deleteUser(created.user.id)
        if (rollbackErr) return new Response(JSON.stringify({ error: profileErr.message + ' (and cleanup also failed: ' + rollbackErr.message + ' - an orphaned login account may exist, contact support)' }), { status: 500, headers: cors })
        return new Response(JSON.stringify({ error: profileErr.message }), { status: 400, headers: cors })
      }
      return new Response(JSON.stringify({ ok: true, id: created.user.id }), { status: 200, headers: cors })
    }

    if (action === 'update') {
      const { id, name, level, branches, perms, access, phone, password } = body
      if (!id) return new Response(JSON.stringify({ error: 'Missing id' }), { status: 400, headers: cors })
      const { data: target } = await admin.from('profiles').select('level').eq('id', id).single()
      if (!callerIsOwner) {
        if (target && target.level === 'Owner') return new Response(JSON.stringify({ error: 'Only an Owner can edit an Owner account' }), { status: 403, headers: cors })
        if (level === 'Owner' || ownerEquivalentPerms(perms)) return new Response(JSON.stringify({ error: 'Only an Owner can grant Owner status or Owner-level permissions' }), { status: 403, headers: cors })
      }
      // Profile fields first, password/email last: if the profile update fails, nothing has changed yet
      // (including no password/email change) - a clean "the save failed" rather than a partial mutation
      // the caller wasn't told about.
      const { error: profileErr } = await admin.from('profiles').update({ name, level, branches, perms, access, phone }).eq('id', id)
      if (profileErr) return new Response(JSON.stringify({ error: profileErr.message }), { status: 400, headers: cors })
      // The Auth login email IS derived from the name (fakeEmail(name)) - resync it every time so a
      // renamed account can still log in. Idempotent: if the name didn't change, this recomputes the
      // same email and is a harmless no-op.
      if (name) {
        const { error: emailErr } = await admin.auth.admin.updateUserById(id, { email: fakeEmail(name), email_confirm: true })
        if (emailErr) return new Response(JSON.stringify({ error: 'Profile saved, but the login email could not be updated to match the new name: ' + emailErr.message + ' - this account may not be able to log in until this is fixed' }), { status: 500, headers: cors })
      }
      if (password) {
        if (password.length < 3) return new Response(JSON.stringify({ error: 'Profile saved, but the password was NOT changed: password too short' }), { status: 400, headers: cors })
        const { error: pwErr } = await admin.auth.admin.updateUserById(id, { password })
        if (pwErr) return new Response(JSON.stringify({ error: 'Profile saved, but the password change failed: ' + pwErr.message }), { status: 400, headers: cors })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: cors })
    }

    if (action === 'delete') {
      const { id } = body
      if (!id) return new Response(JSON.stringify({ error: 'Missing id' }), { status: 400, headers: cors })
      const { data: target } = await admin.from('profiles').select('level').eq('id', id).single()
      if (target && target.level === 'Owner') return new Response(JSON.stringify({ error: 'Cannot delete the Owner' }), { status: 400, headers: cors })
      const { error: profileDelErr } = await admin.from('profiles').delete().eq('id', id)
      if (profileDelErr) return new Response(JSON.stringify({ error: profileDelErr.message }), { status: 400, headers: cors })
      const { error: authDelErr } = await admin.auth.admin.deleteUser(id)
      if (authDelErr) return new Response(JSON.stringify({ error: 'The account record was removed, but the login itself could not be deleted: ' + authDelErr.message }), { status: 500, headers: cors })
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: cors })
    }

    return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400, headers: cors })
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Unexpected error: ' + (e && (e as any).message ? (e as any).message : String(e)) }), { status: 500, headers: cors })
  }
})
