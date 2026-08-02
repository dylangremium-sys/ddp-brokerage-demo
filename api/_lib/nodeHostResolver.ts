// ─── Server-side DNS resolver for the SSRF gate ─────────────────────────────
//
// Supplies serverSourceRetrieval's injected HostResolver using node:dns.
// It lives under api/_lib (underscore = not a route) rather than in src/,
// because src/ is deliberately compiled without @types/node so ordinary app
// code cannot reach Node APIs. serverSourceRetrieval therefore stays free of
// Node built-ins and unit-testable with a fake resolver.
//
// Uses lookup({ all: true }) rather than resolve4/resolve6 so it follows the
// same resolution path the HTTP client will take — including /etc/hosts and
// CNAME chains — which is what makes the check meaningful rather than advisory.

import type { HostResolver } from '../../src/lib/serverSourceRetrieval.js'

export const nodeHostResolver: HostResolver = async (hostname) => {
  const { lookup } = await import('node:dns/promises')
  const records = await lookup(hostname, { all: true })
  return records.map((record: { address: string }) => record.address)
}
