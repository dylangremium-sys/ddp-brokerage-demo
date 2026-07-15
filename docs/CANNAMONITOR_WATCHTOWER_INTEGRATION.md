# Cannamonitor — Compliance Watchtower Integration

```
STATUS: INACTIVE AND UNREACHABLE
```

Cannamonitor is represented inside the Compliance Watchtower as a **safety
boundary only**. No source row exists, no network retrieval occurs, and no
mechanism inside the application can activate it. This document describes what
was built, why, and everything that must happen before any future activation
could even be considered.

> The legal wording in this document is DDP's own risk-controlled
> interpretation for the purpose of failing closed. It is **not** definitive
> legal advice and states no legal conclusion as settled fact.

---

## 1. What Cannamonitor is treated as

Cannamonitor (`cannamonitor.com`) is treated as **secondary commercial
intelligence**:

- non-governmental;
- non-authoritative;
- not an official legal or regulatory authority;
- a source that may *identify developments requiring investigation*, but that
  always requires **primary-source confirmation** before any conclusion.

Cannamonitor alone must never establish a legal change, compliance,
non-compliance, export eligibility, pharmaceutical suitability, buyer readiness,
supplier approval, farm approval, batch approval, or COA acceptance. It may only
ever participate in the **first** stage of the Watchtower model:

> Source detects → evidence is recorded → AI may assist drafting → human reviews
> → qualified human decides → approved rule may be enforced.

At most, existing architecture could later propose a human-review draft with
status `new`. **This task does not activate that path for Cannamonitor.**

---

## 2. Permission remains UNVERIFIED (fail closed)

DDP's commercial permission to retrieve and process Cannamonitor content is
**unverified**, and that assumption fails closed.

`CANNAMONITOR_PERMISSION_STATUS` in
`src/lib/complianceCannamonitorPolicy.ts` is the literal `'unverified'`. While it
is unverified:

- monitoring is **denied before any fetch implementation is invoked**;
- marking the source `isActive: true` does **not** bypass the gate (retrieval
  requires *both* verified permission *and* an active source);
- **no UI control, environment variable, database field, or runtime input** can
  switch permission to verified.

There is deliberately **no activation mechanism in the application**. Flipping
the constant is a reviewed source-code change and a legal decision — not a
configuration toggle.

---

## 3. No source row, no retrieval, no persistence

This task created **no** `regulatory_sources` row and called **no**
`createRegulatorySource`. No Supabase write, no migration, no SQL, no cron job,
no scheduled fetch, no environment variable, and no RLS change were made.

For documentation only, the future entry — **not created** — would be:

```
Name:         Cannamonitor — international cannabis intelligence
Jurisdiction: International — secondary commercial intelligence
Source type:  other
Active:       false
Permission:   unverified
```

---

## 4. Metadata-only future design

Under a *hypothetical* future verified-permission state, only the following
fields could ever enter monitoring:

- title;
- canonical URL;
- GUID / item identifier;
- publication date;
- (source identifier and retrieval timestamp where required).

The projection `CANNAMONITOR_METADATA_ONLY_PROJECTION` discards — **before**
`rawText` is assembled — the RSS `description`, summary, `content`,
`content:encoded`, HTML, article body, images, author commentary, and paid /
subscriber content.

The projection runs on the parsed **fields**, ahead of the connector's
`finalizeItem()`. Prohibited content is therefore **never concatenated, hashed,
carried into a monitoring decision or proposed draft, persisted, or handed to an
AI provider**. It is *not* ingested and then scrubbed — it never enters a
retained value at all.

### Body-only edit detection limitation

> Metadata-only monitoring cannot detect edits made solely to an article body
> when its title, URL, identifier, and publication date remain unchanged.

This is an accepted, deliberate trade-off: detection of body-only edits is given
up in exchange for not copying the body. Change detection compares only the
permitted metadata.

---

## 5. AI restrictions (defence in depth)

A source-specific AI block refuses AI processing for correctly-attributed
Cannamonitor updates. It is enforced in layers:

- **Authoritative gate — shared execution layer.** `generateAiDraftSummary`
  (`complianceAiSummarisation.ts`) checks `evaluateCannamonitorAiGate` **before**
  request preparation, prompt construction, provider selection, or provider
  invocation, and returns the stable code `cannamonitor_permission_unverified`.
  This is the single function every caller funnels through, so it covers **both**
  the client controller and the server endpoint — a direct call cannot bypass it,
  and the provider is never reached.
- **Client controller (defence-in-depth).** `evaluateAiSummaryEligibility` and
  `runAiDraftSummary` (`watchtowerAiSummary.ts`) also block at the UI eligibility
  and execution steps, so the action is disabled and never dispatched.
- **Server endpoint.** `api/compliance/ai-summary.ts` →
  `serverAiSummary.ts` (`handleAiSummaryRequest`) inherits the authoritative gate
  automatically because it calls `generateAiDraftSummary`; the denial maps to a
  deterministic `403` controlled response. An authenticated admin POSTing a
  Cannamonitor `sourceUrl` directly to the API therefore still cannot reach the
  provider.

No AI provider configuration, model selection, prompt, or general AI behaviour
for other sources is changed.

### Manual source-URL attribution limitation

Attribution is determined through the **recorded source URL**. Honestly stated:

- content manually pasted with a **blank, false, or unrelated URL** cannot be
  reliably identified by this source-specific rule;
- **content-sniffing is not used** — it would create false positives and false
  negatives;
- administrators must record the **correct canonical source URL**.

This integration does **not** claim that all manually pasted Cannamonitor text
is automatically detectable.

---

## 6. Host and transport safety

Only these exact hosts are approved:

```
cannamonitor.com
www.cannamonitor.com
```

Rejected/denied: deceptive suffix domains (e.g. `cannamonitor.com.evil.example`
— a different site, never treated as Cannamonitor), unexpected subdomains, HTTP,
embedded URL credentials, unexpected ports, malformed URLs, and redirects. The
existing generic connector controls — HTTPS-only, deny-by-default exact-match
host allowlist, the SSRF guard (loopback / private / link-local / cloud-metadata
addresses), the port policy, and redirect refusal — are **reused unchanged**;
this policy only layers additional restrictions on top.

---

## 7. No automatic compliance consequences

The policy cannot automatically create a compliance rule, approve/activate a
rule, create an alert, change readiness, block a batch, or change any farm,
inventory, COA, buyer, document, or shipment. It cannot create a regulatory
source row or schedule monitoring. Every policy decision carries literal-`false`
capability guarantees, and the module imports nothing that performs a write.

---

## 8. Immediate kill-switch model

Because permission is a single compile-time constant and there is no runtime
override, the integration is *off by construction*. Reverting or keeping
`CANNAMONITOR_PERMISSION_STATUS = 'unverified'` is the kill switch: with it
unverified, monitoring is denied before any fetch and AI is blocked, everywhere,
with no configuration able to re-enable it.

---

## 9. Files

**Added**

- `src/lib/complianceCannamonitorPolicy.ts` — the policy (permission state, host
  classification, metadata-only projection, monitoring gate, AI gate,
  governance copy).
- `src/lib/complianceCannamonitorPolicy.test.ts` — the safety-boundary tests.
- `docs/CANNAMONITOR_WATCHTOWER_INTEGRATION.md` — this document.

**Modified (narrowly)**

- `src/lib/complianceRssConnector.ts` — a `FeedItemFieldPolicy` seam (default
  identity) + a pre-fetch policy gate; unrelated sources are unaffected.
- `src/lib/complianceManualMonitoring.ts` — a Cannamonitor eligibility denial.
- `src/lib/watchtowerAiSummary.ts` — the AI block at eligibility and execution.
- `src/pages/admin/DDPComplianceWatchtower.tsx` — a **display-only** warning
  banner (renders only if a matching source ever existed; none does).

---

## 10. Steps required before any future activation

All of the following are prerequisites — none is satisfied today:

1. **Written commercial permission or an appropriate licence** for DDP to
   retrieve and process Cannamonitor content commercially, documented.
2. A reviewed source-code change flipping `CANNAMONITOR_PERMISSION_STATUS` (or an
   equivalent separately-approved *durable* permission mechanism — which does
   not exist and is intentionally not added here).
3. A deliberate decision to register a `regulatory_sources` row (Active: false
   initially) — not created by this task.
4. Confirmation that the metadata-only projection, host allowlist, and AI block
   remain in force for the source, with the documented limitations understood.
5. Primary-source verification workflow confirmed: no Cannamonitor item alone
   may drive a compliance conclusion, readiness change, alert, or enforcement.

> **Remaining blocker:** Written commercial permission or an appropriate licence
> remains required before any activation or retrieval.
