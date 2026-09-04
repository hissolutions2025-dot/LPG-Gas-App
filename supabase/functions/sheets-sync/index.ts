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
    // Always overrides any client-supplied `token` copied into forwardBody above - the
    // client must never be able to make its own value reach the real Apps Script call.
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
