# P5 — Turn OFF Supabase "Allow new users to sign up"

**Audit finding:** R5b — MEDIUM, and explicitly **contained**.
**Owner:** Release owner (Supabase dashboard access).
**Break-glass required:** **No.** This is an authentication *setting*, not a schema,
privilege or DML change. Freeze §1.4 covers changes to the `auth` **schema** and its
privileges; a GoTrue configuration toggle is neither. Record it in §5 anyway — it
alters production behaviour, and a one-line note costs nothing.
**Estimated time:** 2 minutes.

---

## ⚠️ Read this before acting

**This is not a breach, and must not be re-raised as an incident.**

`GET /auth/v1/settings` on the production project returns `disable_signup: false`,
so anyone can create an Auth account directly against the Supabase endpoint,
bypassing the application's invite-only design. But a self-registrant lands on an
**inert** account:

- `handle_new_user()` stamps every new user `pending` — **migration 21 is applied**,
  verified directly on 2026-07-28.
- The self-promotion guard policy is present.
- Every farmer-facing RLS policy is scoped to farm **membership**, not to
  `role='farmer'` — so a `pending` account with no membership sees nothing.
- `postLoginRouting.ts:28-29` denies a `pending` account with
  `reason: 'pending-approval'`.

A self-registrant therefore has no memberships, no data and no route to promotion.
**The real severity is unwanted account creation — spam and noise — plus the fact
that it gives the enquiry queue a second channel.**

**Do NOT run `scripts/prod-selfsignup-containment.sql`.** It is a **no-op** against
this project's current state: the containment it installs is already present. Running
it would be an unnecessary production write during an active freeze, for no effect.

## Pre-state (read-only)

```bash
ASSET=$(curl -sS https://www.ddpbrokerage.com/ | grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' | head -1)
KEY=$(curl -sS "https://www.ddpbrokerage.com$ASSET" | grep -oE 'sb_publishable_[A-Za-z0-9_-]+' | head -1)
curl -sS "https://iihxjrfxmycjafbtjvvq.supabase.co/auth/v1/settings" -H "apikey: $KEY" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print({k:v for k,v in d.items() if k!='external'})"
```

Measured 2026-07-28:

```
{'disable_signup': False, 'mailer_autoconfirm': False, 'phone_autoconfirm': False,
 'sms_provider': 'twilio', 'saml_enabled': False,
 'saml_private_key_next_configured': True, 'passkeys_enabled': False}
```

`disable_signup: False` is the finding. (The publishable key used above is public by
design — it ships in the browser bundle. Nothing secret is read here.)

Also confirm the containment is genuinely in place, so the "contained" claim is
verified rather than assumed:

```sql
BEGIN READ ONLY;
-- Migration 21's stamp. Every new user must land 'pending'.
SELECT (p.prosrc ~* 'pending') AS stamps_pending
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'handle_new_user';   -- expect t

-- The role vocabulary the stamp writes into.
SELECT pg_get_constraintdef(con.oid) AS profiles_role_check
FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
JOIN pg_namespace n ON n.oid = rel.relnamespace
WHERE n.nspname='public' AND rel.relname='profiles' AND con.contype='c';
COMMIT;
```

## Statements to run

None. This is a dashboard toggle.

1. Supabase → project `iihxjrfxmycjafbtjvvq` → **Authentication → Sign In / Providers**
   (older UI: **Authentication → Providers → Email**).
2. Turn **"Allow new users to sign up"** → **OFF**.
3. Save.

### Check this does not break provisioning first

DDP onboarding is **invite-by-email** through `/api/admin/provision-farmer`, which
calls `auth.admin.inviteUserByEmail` with the service-role key. Admin invitations
are **not** self-signup and are unaffected by this toggle.

That said, do **P1 first** and confirm the provisioning endpoint works end to end
before turning signup off. Doing it in the other order leaves a window in which
there is no way at all for an account to come into existence — self-signup closed,
provisioning still returning 500.

## Post-state verification

```bash
curl -sS "https://iihxjrfxmycjafbtjvvq.supabase.co/auth/v1/settings" -H "apikey: $KEY" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['disable_signup'])"
```

**PASS:** prints `True`.

Then prove it behaviourally — attempt a signup with a throwaway address:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  "https://iihxjrfxmycjafbtjvvq.supabase.co/auth/v1/signup" \
  -H "apikey: $KEY" -H 'Content-Type: application/json' \
  -d '{"email":"p5-check@example.invalid","password":"not-a-real-password-123456"}'
```

**PASS:** `422` (or another 4xx carrying `signup_disabled`).
**FAIL:** `200`/`201` — an account was created. If so, delete it in
Authentication → Users and re-check the toggle.

Use an `@example.invalid` address: it is reserved by RFC 2606 and cannot be
delivered to, so nothing reaches a real inbox.

Finally, confirm the supported path still works: invite a real test address through
the admin UI and check the invitation arrives.

## Rollback

Turn the same toggle back ON. No database object changes in either direction.

## Follow-up, if any accounts were already created this way

```sql
BEGIN READ ONLY;
-- Requires a credential that can read profiles: ddp_ro has no EXECUTE on
-- is_ddp_admin(), so it cannot read this RLS-gated table.
SELECT count(*) AS pending_profiles FROM public.profiles WHERE role = 'pending';
COMMIT;
```

Any `pending` account is inert by construction. Deleting one is a **destructive
production write** and needs its own break-glass authorisation — do not fold it into
this action.

## Operator record

| Field | Value |
|---|---|
| P1 completed and provisioning verified working first | ☐ |
| Pre-state `disable_signup` = `false` captured | ☐ |
| Containment re-verified (`handle_new_user` stamps `pending`) | ☐ |
| Operator (name / role) | |
| Date / time (ISO 8601, UTC) | |
| Post-state `disable_signup` = `true` | ☐ |
| Signup probe returns 4xx | ☐ |
| Admin invite still delivers | ☐ |
| Recorded in freeze §5 | ☐ |
| `pending` accounts found (count / n/a) | |
| Notes | |
