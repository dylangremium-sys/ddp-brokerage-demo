#!/usr/bin/env node
const PRODUCTION_REF = 'iihxjrfxmycjafbtjvvq'
const url = process.env.SUPABASE_URL
const anon = process.env.SUPABASE_ANON_KEY
const deploy = process.env.DEPLOY_URL
const bypass = process.env.VERCEL_BYPASS_TOKEN

function fail(msg) { console.error(`FAIL — ${msg}`); process.exit(1) }
if (!url || !anon) fail('SUPABASE_URL and SUPABASE_ANON_KEY are required')
if (url.includes(PRODUCTION_REF)) fail('refusing to run against the PRODUCTION ref')
if (!deploy) fail('DEPLOY_URL is required')

const timeout = (ms) => { const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal }

// 1) Supabase Auth health check
try {
  const r = await fetch(`${url}/auth/v1/health`, {
    headers: { 
      'apikey': anon,
      'Authorization': `Bearer ${anon}`
    }, 
    signal: timeout(8000) 
  })
  if (!r.ok) fail(`Supabase auth health returned HTTP ${r.status}`)
  console.log(`PASS — Supabase reachable (auth health ${r.status})`)
} catch (e) { fail(`Supabase handshake failed: ${e.name}`) }

// 2) Deployed function liveness with Vercel Protection Bypass support
try {
  const headers = { 'content-type': 'application/json' }
  if (bypass) headers['x-vercel-protection-bypass'] = bypass

  const r = await fetch(`${deploy}/api/compliance/ai-summary`, {
    method: 'POST', headers, body: '{}', signal: timeout(10000),
  })
  const ct = r.headers.get('content-type') || ''
  if (!ct.includes('application/json')) fail(`function returned non-JSON (${ct || 'no content-type'}, HTTP ${r.status})`)
  const body = await r.json()
  if (r.status >= 500 && r.status !== 503) fail(`function 5xx: HTTP ${r.status} ${JSON.stringify(body)}`)
  if (body.ok !== false || typeof body.error !== 'string') fail(`unexpected envelope: ${JSON.stringify(body)}`)
  console.log(`PASS — function alive (HTTP ${r.status}, error="${body.error}")`)
} catch (e) { fail(`function handshake failed: ${e.name}`) }

console.log('SMOKE TEST PASSED')
