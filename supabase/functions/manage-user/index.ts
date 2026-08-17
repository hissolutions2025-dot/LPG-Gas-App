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
