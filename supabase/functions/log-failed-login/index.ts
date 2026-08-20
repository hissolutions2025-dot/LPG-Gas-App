// supabase/functions/log-failed-login/index.ts
// Public, unauthenticated endpoint (nobody is signed in yet at the login
// screen) - deliberately narrow to avoid becoming a log-spam target: only
// logs an attempt if the typed name matches a REAL profile name. Random
// garbage/bot traffic against this endpoint is silently dropped, not logged,
// since it isn't investigation-relevant and would otherwise let anyone
// inflate the audit log at will.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.112.3'

Deno.serve(async (req) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type' }
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const admin = createClient(supabaseUrl, serviceKey)

    const body = await req.json()
    const name = (body.name || '').trim()
    const branchTyped = (body.branch || '').trim()
    if (!name) return new Response(JSON.stringify({ ok: true }), { status: 200, headers: cors })

    const escapedName = name.replace(/[%_]/g, '\\$&')
    const { data: profile } = await admin.from('profiles').select('id,name,level').ilike('name', escapedName).maybeSingle()
    if (!profile) return new Response(JSON.stringify({ ok: true }), { status: 200, headers: cors }) // unknown name - not logged, not an error either (don't leak which names exist)

    const thirtySecondsAgo = new Date(Date.now() - 30 * 1000).toISOString()
    const { data: recent } = await admin.from('audit_log')
      .select('id')
      .eq('user_id', profile.id)
      .eq('action', 'Login failed')
      .gte('ts', thirtySecondsAgo)
      .limit(1)
      .maybeSingle()
    if (recent) return new Response(JSON.stringify({ ok: true }), { status: 200, headers: cors }) // already logged one recently for this person - throttle, don't flood

    await admin.from('audit_log').insert({
      user_id: profile.id,
      user_name_snapshot: profile.name,
      role_snapshot: profile.level,
      branch: branchTyped || null,
      action: 'Login failed',
      detail: 'Wrong password at sign-in screen',
      outcome: 'failure',
      risk: 'high'
    })

    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: cors })
  } catch (e) {
    // Never let a logging failure surface as a login error to the user.
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: cors })
  }
})
