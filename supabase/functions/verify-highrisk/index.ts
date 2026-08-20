// supabase/functions/verify-highrisk/index.ts
// The Close Day "second password" is a shared secret (not tied to one user
// account), so it can't be checked via Supabase Auth like a normal login.
// Instead it's hashed and stored server-side ONLY - this function verifies a
// guess against the hash and returns true/false, never exposing the secret
// or its hash to the client. Setting/clearing it also goes through here,
// gated the same way (caller must be an Owner, verified via getClaims()).
//
// The 'check' action is additionally gated to only Close-Day-capable callers
// (matches the same permission shape as day_closes' own RLS insert policy),
// and rate-limited via the existing audit_log table (reusing it rather than
// building new infrastructure): a wrong guess is logged there, and once a
// caller has too many recent failures they're locked out for the window,
// regardless of what they guess next. Without this, any signed-in user -
// including someone with no Close Day rights at all - could script unlimited
// guesses against a low-entropy shared PIN, which would defeat the entire
// point of moving this off plaintext storage.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.112.3'

async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
}

const RATE_LIMIT_WINDOW_MIN = 15
const RATE_LIMIT_MAX_ATTEMPTS = 5

Deno.serve(async (req) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type' }
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const admin = createClient(supabaseUrl, serviceKey)
    const body = await req.json()

    const authClient = createClient(supabaseUrl, anonKey)
    const { data: claimsData, error: claimsError } = await authClient.auth.getClaims(body.callerToken || '')
    if (claimsError || !claimsData?.claims?.sub) return new Response(JSON.stringify({ error: 'Not signed in' }), { status: 401, headers: cors })
    const userId = claimsData.claims.sub as string

    const { data: caller } = await admin.from('profiles').select('name,level,perms').eq('id', userId).single()
    if (!caller) return new Response(JSON.stringify({ error: 'Profile not found' }), { status: 403, headers: cors })

    if (body.action === 'set') {
      if (caller.level !== 'Owner') return new Response(JSON.stringify({ error: 'Owner only' }), { status: 403, headers: cors })
      const value = (body.value || '').toString()
      const hash = value ? await sha256(value) : null
      const { error: upsertErr } = await admin.from('app_secrets').upsert({ key: 'highrisk_pw_hash', value: hash })
      if (upsertErr) return new Response(JSON.stringify({ error: upsertErr.message }), { status: 500, headers: cors })
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: cors })
    }

    if (body.action === 'check') {
      const canCloseDay = caller.level === 'Owner' || caller.level === 'Manager' || !!(caller.perms && caller.perms.closeday)
      if (!canCloseDay) return new Response(JSON.stringify({ error: 'Not allowed' }), { status: 403, headers: cors })

      const { data: row } = await admin.from('app_secrets').select('value').eq('key', 'highrisk_pw_hash').maybeSingle()
      if (!row || !row.value) return new Response(JSON.stringify({ ok: true, set: false }), { status: 200, headers: cors })

      const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MIN * 60 * 1000).toISOString()
      const { count } = await admin.from('audit_log')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('action', 'High-risk password check failed')
        .gte('ts', windowStart)
      if ((count || 0) >= RATE_LIMIT_MAX_ATTEMPTS) {
        return new Response(JSON.stringify({ ok: true, set: true, match: false, lockedOut: true }), { status: 200, headers: cors })
      }

      const guessHash = await sha256((body.value || '').toString())
      const match = guessHash === row.value
      if (!match) {
        await admin.from('audit_log').insert({
          user_id: userId, user_name_snapshot: caller.name || 'unknown', role_snapshot: caller.level || '',
          action: 'High-risk password check failed', detail: 'Wrong high-risk (second) password entered',
          outcome: 'failure', risk: 'high'
        })
      }
      return new Response(JSON.stringify({ ok: true, set: true, match: match }), { status: 200, headers: cors })
    }

    return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400, headers: cors })
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Unexpected error: ' + (e && (e as any).message ? (e as any).message : String(e)) }), { status: 500, headers: cors })
  }
})
