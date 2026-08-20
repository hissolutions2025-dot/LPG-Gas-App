// supabase/functions/verify-highrisk/index.ts
// The Close Day "second password" is a shared secret (not tied to one user
// account), so it can't be checked via Supabase Auth like a normal login.
// Instead it's hashed and stored server-side ONLY - this function verifies a
// guess against the hash and returns true/false, never exposing the secret
// or its hash to the client. Setting/clearing it also goes through here,
// gated the same way (caller must be an Owner, verified via getClaims()).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.112.3'

async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
}

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

    if (body.action === 'set') {
      const { data: caller } = await admin.from('profiles').select('level').eq('id', userId).single()
      if (!caller || caller.level !== 'Owner') return new Response(JSON.stringify({ error: 'Owner only' }), { status: 403, headers: cors })
      const value = (body.value || '').toString()
      const hash = value ? await sha256(value) : null
      await admin.from('app_secrets').upsert({ key: 'highrisk_pw_hash', value: hash })
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: cors })
    }

    if (body.action === 'check') {
      const { data: row } = await admin.from('app_secrets').select('value').eq('key', 'highrisk_pw_hash').maybeSingle()
      if (!row || !row.value) return new Response(JSON.stringify({ ok: true, set: false }), { status: 200, headers: cors })
      const guessHash = await sha256((body.value || '').toString())
      return new Response(JSON.stringify({ ok: true, set: true, match: guessHash === row.value }), { status: 200, headers: cors })
    }

    return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400, headers: cors })
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Unexpected error: ' + (e && (e as any).message ? (e as any).message : String(e)) }), { status: 500, headers: cors })
  }
})
