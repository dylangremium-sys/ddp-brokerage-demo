# Runbook — scheduled Watchtower ingestion

**Added:** 2026-08-02 · **Route:** `/api/cron/ingest` · **Schedule:** `0 2 * * *` (daily 02:00 UTC)

## What it does

Sweeps every **enabled** row in `regulatory_sources`, retrieves each one server-side through the
SSRF-guarded retriever, parses feeds or fingerprints pages, deduplicates against existing
`legal_updates`, and inserts new candidates in status **`new`** for a human to triage in the
Review Queue.

It creates nothing a human has not triaged. No rule, no alert, no readiness change, no AI call
happens on this path.

## REQUIRED before this does anything

`CRON_SECRET` **must be set in Vercel Production.** Until it is, the route returns `503
server_misconfigured` and the sweep never runs.

That is deliberate: the route is publicly reachable over HTTPS, so a missing secret must
DISABLE it, never open it. The failure is silent from a user's point of view — nothing looks
broken, monitoring simply does not happen — so verify it explicitly after deploy.

```bash
# Generate and set (value is never readable again once marked Sensitive)
openssl rand -hex 32
npx vercel env add CRON_SECRET production
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are also required and are already set.

> **An env-var change does not reach production by itself.** Values bind to a deployment at
> build time, so the running deployment keeps the old value until something redeploys, and
> `deploy-production` is gated on a push to `main`. Set the variable, then land a commit.

## Verifying it works

```bash
# Should be 401 — proves the gate is on. If this returns 200, STOP: the secret is not set.
curl -s -o /dev/null -w '%{http_code}\n' https://www.ddpbrokerage.com/api/cron/ingest

# Manual trigger with the real secret
curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" \
  https://www.ddpbrokerage.com/api/cron/ingest | jq
```

A success body reports `sources`, `succeeded`, `partial`, `failed`, `skipped`, `newCandidates`
and `duplicates`. Then check the **Ingestion Runs** tab in the Compliance Watchtower — every
source produces a run row either way, which is the durable evidence.

## Expected steady state — read this before raising an incident

**Failed runs are normal here and do not mean the job is broken.** Measured 2026-07-28:
`moph.go.th`, `doa.go.th` and `ratchakitcha.soc.go.th` all answered **403** to a plain GET.
Those three are expected to record `source_unavailable` runs indefinitely until someone
negotiates access or finds a different entry point. A recorded failure is the correct outcome —
the wrong outcome would be reporting success and silently monitoring nothing.

| Source | Method | Expectation |
|---|---|---|
| SÚKL Czech Republic | `rss` | Should succeed (`application/rss+xml`) |
| EUR-Lex | `rss` | Should succeed (`application/xml`) |
| Thai FDA, Thai Customs, ONCB | `html` | Page-change watch; may succeed |
| MOPH, DOA, Royal Gazette | `html` | Expected 403 → failed run |

## Tuning the schedule

Daily is a politeness decision, not a technical limit. The feed-retrieval throttle
(`serverFeedRetrievalThrottle.ts`) allows 400 retrievals/day globally — roughly 50 full sweeps —
so the schedule can be tightened without hitting the ceiling. Do not tighten it far: an IP block
from a government host takes the whole feature offline, and these are the exact hosts it depends
on.

Both the path and the schedule are pinned by `scripts/deploy-workflow.test.mjs`, so changing
either requires updating that test — on purpose.

## First run will be noisy

Every watched page is unseen on the first sweep, so the first run creates one candidate per
reachable source. That settles from the second run onward, because an unchanged page produces
the same content hash and dedups. Do not read the first run's candidate count as a signal.
