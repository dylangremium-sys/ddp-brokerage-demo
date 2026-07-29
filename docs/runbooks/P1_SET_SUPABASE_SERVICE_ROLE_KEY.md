# P1 — Set `SUPABASE_SERVICE_ROLE_KEY` in Vercel Production

**Audit finding:** R1 — HIGH, and the highest-priority item overall.
**Owner:** Release owner.
**Break-glass required:** **No.** This changes no database object and no
production SQL. It is a Vercel environment change plus a redeploy, both permitted
by freeze §2 ("application deploys from `main` through the existing gated CI path,
provided they carry no migration").
**Estimated time:** 10 minutes plus a deploy.

---

## Why this is first

`POST /api/admin/provision-farmer` returns
`500 {"ok":false,"error":"Provisioning endpoint is not configured."}` on every
production surface. That string is emitted only when `buildDeps()` returns `null`
(`api/admin/provision-farmer.ts:42-45,106-110`), i.e. `SUPABASE_URL` or
`SUPABASE_SERVICE_ROLE_KEY` is unset or empty.

Migration 21 makes provisioning deliberately admin-only: **this endpoint is the
only supported way an account comes into existence.** With it down the entire
supplier funnel terminates — a visitor can file an access request, and no
administrator can act on it.

## Pre-state — confirm the variable really is the missing one

Three independent lines agree. Reproduce whichever you prefer; all are read-only.

**(a) The Vercel configuration listing.** Names only — this never prints a value:

```bash
cd "/Users/mac/DDP AUDIT/ddp-brokerage-demo"
vercel env ls
```

Expected today — `SUPABASE_SERVICE_ROLE_KEY` is **absent from the list entirely**:

```
 name                       value        environments
 VITE_SUPABASE_ANON_KEY     Encrypted    Preview, Production
 VITE_SUPABASE_URL          Encrypted    Preview, Production
 AI_SUMMARY_MODEL           Encrypted    Production
 ANTHROPIC_API_KEY          Encrypted    Production, Preview
 SUPABASE_ANON_KEY          Encrypted    Production
 SUPABASE_URL               Encrypted    Production
```

**(b) The endpoint itself:**

```bash
curl -s -X POST https://www.ddpbrokerage.com/api/admin/provision-farmer \
  -H 'Content-Type: application/json' -d '{}'
```

Expected now: `{"ok":false,"error":"Provisioning endpoint is not configured."}` with
HTTP **500**.

**(c) The sibling endpoint proves `SUPABASE_URL` is present.**
`/api/compliance/ai-summary` reads the same `SUPABASE_URL` plus
`SUPABASE_ANON_KEY` and gets as far as token validation:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  https://www.ddpbrokerage.com/api/compliance/ai-summary \
  -H 'Content-Type: application/json' -d '{}'
```

Expected: **401**, not 500. So the missing variable is the service-role key alone.

## Statements to run

There are none — this is a dashboard action, and **the key must never be pasted
into a terminal, a file, a commit, or a chat window.**

1. Supabase → Project `iihxjrfxmycjafbtjvvq` → **Project Settings → API Keys**.
   Copy the **`service_role`** secret. It is not the `anon`/publishable key.
2. Vercel → project `ddp-brokerage-demo` → **Settings → Environment Variables**.
3. Add:
   - **Name:** `SUPABASE_SERVICE_ROLE_KEY`
   - **Environments:** **Production only.** Do **not** tick Preview — Preview
     deployments are reachable by anyone holding the URL, and this key bypasses
     RLS entirely.
   - **Type:** Sensitive / encrypted.
4. Save. Environment variables apply at build time, so **redeploy**: merge to
   `main`, or re-run the latest `Deploy to Production` job. Do not use dashboard
   promotion or Instant Rollback — freeze §3 classes those as break-glass because
   they move production off the verified SHA.

### While you are there

If PR #85 (public intake throttle) has merged, also set `PUBLIC_INTAKE_IP_SALT`
(Production, sensitive, any long random string). It is optional — the code falls
back to `SUPABASE_URL` — but a dedicated salt is better.

## Post-state verification — the test that matters

An unauthenticated `POST` must return **401**, not 500. 401 means the endpoint is
configured and reached token validation; 500 means it is still unconfigured.

```bash
for host in www.ddpbrokerage.com ddp-brokerage-demo.vercel.app; do
  printf '%s -> ' "$host"
  curl -s -o /dev/null -w '%{http_code}\n' -X POST \
    "https://$host/api/admin/provision-farmer" \
    -H 'Content-Type: application/json' -d '{}'
done
```

**PASS:** both print `401`.
**FAIL:** either prints `500` — the variable did not reach the build. Confirm it is
scoped to Production and that a **new** deployment was produced after saving it.

Then confirm the deployed commit is still the verified one:

```bash
curl -s https://www.ddpbrokerage.com/version.json
```

`commitSha` must equal `origin/main`.

Finally, end to end: sign in as a `ddp_admin`, invite a test address, and confirm
the invitation email arrives. Nothing short of that proves the funnel works —
401 only proves the endpoint is configured.

## Rollback

Delete the variable in Vercel → Settings → Environment Variables and redeploy.
Production returns to its current state (provisioning down, 500). No database
object changes in either direction, so there is nothing to reconcile.

**If the key is ever exposed:** rotate it in Supabase → API Keys, then update
Vercel and redeploy. Rotation invalidates the old key immediately.

## Do not

- Print, echo, log, screenshot or commit the key. It bypasses RLS completely — it
  is equivalent to full database access.
- Set it in Preview, or in any `VITE_`-prefixed variable. A `VITE_` name is
  **bundled into the browser**, which would publish it to every visitor.
- Add it to `.env`, `.env.local` or `.env.staging` in this repository.

## Operator record

| Field | Value |
|---|---|
| Operator (name / role) | |
| Date / time (ISO 8601, UTC) | |
| Pre-state captured (a/b/c) | |
| Deployment SHA after redeploy | |
| `www.ddpbrokerage.com` → 401 | ☐ |
| `ddp-brokerage-demo.vercel.app` → 401 | ☐ |
| End-to-end invite delivered | ☐ |
| Notes | |
