# Cannamonitor — Compliance Watchtower Integration

**Status: INACTIVE AND UNREACHABLE. Retrieval is disabled and cannot be enabled from the application.**

This document describes the safety foundation for a *possible future* Cannamonitor integration. No Cannamonitor source exists in any database. No Cannamonitor content has been retrieved, stored, or processed. Nothing here activates anything.

---

## 1. What Cannamonitor is, in this system

Cannamonitor (`cannamonitor.com`) is classified as a **secondary commercial intelligence source**:

- **non-authoritative** — it is not a regulator and not a government body;
- **not a statement of law** — it cannot establish legal truth;
- **insufficient on its own** — it can never be the sole evidentiary basis for an approved or active compliance rule.

The permanent control model is unchanged by this work:

> Source detects → system records evidence → AI may summarise → human reviews → qualified human decides → approved rule may be enforced.

A Cannamonitor item may, at most, cause a human to go and look at an official primary source. It carries no readiness, alert, or enforcement consequence.

---

## 2. Why the source is blocked (the licensing fact)

This is a **permissions** blocker, not a technical one.

**This document is not legal advice and does not state a legal conclusion.** It records DDP's own risk-controlled operating interpretation, which requires confirmation from qualified counsel or from Cannamonitor.

What the published notice says (quoted, verified once, read-only): reproduction, distribution and public communication of *"all or part of the contents of this website **for commercial purposes**, in any format and by any technical means, **without authorization, is expressly prohibited**."* The publisher is Arnau Valdovinos Agustí, Barcelona, Spain; Spanish law governs.

DDP is a commercial brokerage. **DDP's current risk-controlled interpretation** of that notice is therefore:

- Copying or retaining Cannamonitor website content in this commercial system **should not occur** without written authorization or an appropriate licence. *(Interpretation — requires confirmation from qualified counsel or Cannamonitor.)*
- Forwarding such text to a third-party AI provider would be a further disclosure, and an irreversible one, so it should not occur on the same basis. *(Interpretation.)*
- **The feed being publicly accessible is not, on its own, a licence.** Storage, text/data mining, scraping and automated access are simply *not mentioned* in the notice. We treat that silence as *not constituting permission* rather than as permission — a conservative reading, adopted deliberately. *(Interpretation.)*

Whether that reading is correct is **not** a question this project can answer for itself. The operational control is fail-closed precisely so the system stays safe while the question is open: nothing is retrieved, stored, or sent to an AI provider in the meantime.

Verified facts about the feed (`https://cannamonitor.com/feed/`, checked once, read-only):

| Property | Finding |
|---|---|
| Format | Valid RSS 2.0, no redirect, no paywall |
| Per-item metadata | `<title>`, `<link>`, `<guid>`, `<pubDate>` all present |
| `<description>` | Present — an excerpt of roughly 100–150 characters |
| `<content:encoded>` | Present — **the full article body**, roughly 2,000–8,000+ words |

The feed therefore carries substantial copyrighted text. Retrieving it through the generic connector would have copied that text into `legal_updates.raw_text` and forwarded it to an AI provider.

**Remaining blocker: written commercial permission or a licence from Cannamonitor. Obtaining it is a business/legal decision, not a coding one.**

---

## 3. How the block is enforced

Two **independent** controls. Either one alone would stop prohibited content; both are present because the failure is irreversible.

### 3.1 Permission gate (fail-closed)

`src/lib/complianceCannamonitorPolicy.ts` exports:

```ts
export const CANNAMONITOR_PERMISSION_STATUS: CannamonitorPermissionStatus = 'unverified'
```

While this is `'unverified'`, monitoring and AI are denied **before any network call is attempted**.

It is a compile-time constant on purpose. There is **no admin toggle, no database column, and no environment variable** that can flip it — so it cannot be enabled by accident, by a non-legal actor, or from the UI. Changing it requires a reviewed code change, and doing so without a signed licence would put the project in breach.

**Marking the source active does not enable it.** Monitoring requires **both**:

1. the source is active under the existing registry control; **and**
2. the Cannamonitor permission policy is `verified`.

An active source with unverified permission is denied (`permission_unverified`). Verified permission on an inactive source is denied (`source_inactive`).

The gate is enforced in two places so it cannot be bypassed:

- `evaluateManualMonitoringEligibility` (`complianceManualMonitoring.ts`) — so the UI disables the action with an honest reason;
- `executeRssConnector` (`complianceRssConnector.ts`) — evaluated *first*, before the fetch, so calling the connector directly does not get around it.

### 3.2 Metadata-only projection

Even in a hypothetical future where permission is verified, article content stays prohibited.

`CANNAMONITOR_METADATA_ONLY_PROJECTION` is a `FeedItemFieldPolicy` applied to the parsed **fields**, *before* `finalizeItem()` assembles `rawText`.

**The ordering is the safeguard, not an implementation detail.** A policy applied after `rawText` was built would have to scrub prohibited text back out of an existing string — meaning the text would have existed in a retained value, would have been in the checksum basis, and would be one refactor away from persistence. Projecting first means prohibited content is **never concatenated at all**, so it cannot reach the checksum, the monitoring decision, a proposed draft, the repository, or an AI provider.

| Retained (permitted) | Discarded (prohibited) |
|---|---|
| `title` | `description` |
| canonical item URL (`link`) | `summary` |
| `guid` / feed item id | `content` |
| publication date | `content:encoded` (full body) |
| source identifier | HTML, images |
| retrieval timestamp | article body, copied excerpts |
| | author commentary, subscriber content |

Checksum basis is exactly: **title + canonical URL + item id + publication date**.

`summary` and `content` are **hard-nulled regardless of what the parser produced**. Today the RSS extractor happens not to read `<content:encoded>` — but that is an accident of which tags it matches, not a safeguard. If a future change teaches it to read `<content:encoded>` (a natural-looking "improvement"), the projection still discards the body. A test pins this explicitly.

### 3.3 AI boundary (defence-in-depth)

`watchtowerAiSummary.ts` blocks AI summarisation for any legal update whose **`sourceUrl` identifies an approved Cannamonitor host**, while permission is unverified. It is enforced in **both** `evaluateAiSummaryEligibility` (button state) and `runAiDraftSummary` (execution), so a UI that forgot to check eligibility still cannot reach the provider.

The projection alone is not sufficient here, because it guards only **one path into `rawText`**, while the AI call consumes `update.rawText` *however it got there*:

- a row created before this policy existed carries whatever raw text it was created with;
- a future parser or wiring regression could reintroduce body text upstream;
- an admin can paste Cannamonitor text straight into the manual legal-update form, which never touches the RSS parser.

A projection guards **ingestion**; this gate guards **consumption**. It is strictly source-specific: no provider configuration, model, prompt, or general AI behaviour changes, and unrelated sources are evaluated exactly as before.

#### Known limitation — the gate identifies Cannamonitor by URL, not by content

**This is a governance dependency, and it must not be mistaken for a claim that all manually pasted Cannamonitor material is automatically detectable.**

The source-specific gate recognises a Cannamonitor-derived update **solely through its recorded `sourceUrl`**. Concretely:

- Manually pasted Cannamonitor text **is** blocked when the recorded `sourceUrl` identifies an approved Cannamonitor host (`cannamonitor.com` / `www.cannamonitor.com`).
- Manually pasted Cannamonitor text with a **blank, inaccurate, or unrelated `sourceUrl`** **cannot be reliably identified** by this gate, and will be treated as an ordinary update.

**Content-sniffing is intentionally not used.** Attempting to detect Cannamonitor material by inspecting the text itself would be unreliable in both directions — it would miss paraphrased or reformatted material while falsely flagging unrelated regulatory text — so it would produce false confidence rather than real protection. The gate is deliberately kept to a precise, predictable URL-based rule.

The control therefore depends on a human doing the right thing: **administrators must record the correct canonical Cannamonitor source URL** on any update derived from Cannamonitor. That obligation is a process control, not an automated one.

Note what this limitation does **not** affect: the automated RSS ingestion path is unaffected, because retrieval is denied outright and the metadata-only projection applies regardless. The limitation is confined to manually authored updates whose provenance a human recorded incorrectly. A test pins this dependency explicitly, so it stays visible rather than being silently assumed away.

---

## 4. Host and transport controls

Approved hosts are **exact, whole-host** matches only:

- `cannamonitor.com`
- `www.cannamonitor.com` (included intentionally — omitting it would silently route the `www` host down the generic, unrestricted path)

Rejected, each with a distinct denial code:

| Case | Behaviour |
|---|---|
| `cannamonitor.com.evil.example` | **Not matched** — a different site, owned by someone else. It never inherits Cannamonitor's permission, even if permission is later granted. |
| `staging.cannamonitor.com` (unapproved subdomain) | **Matched but denied** (`unapproved_subdomain`) — still Cannamonitor-owned, so it must not fall through to the generic path. |
| `http://` | Denied (`not_https`) |
| Embedded credentials | Denied (`credentials_in_url`); no credentials are ever sent |
| Unexpected port | Denied (`unexpected_port`) |
| Malformed URL naming cannamonitor | Denied (`malformed_url`) — fails closed rather than waved through |

Note the deliberate asymmetry: **matching is broad, permission is narrow.** A Cannamonitor URL that failed to *match* would fall through to the generic connector and be fetched and stored normally — so the matcher errs toward matching, and the denial codes do the restricting.

Transport safety is **reused, not reimplemented**. HTTPS-only, the exact-match deny-by-default host allowlist, the SSRF guard (loopback / private / link-local / cloud-metadata), the port policy, redirect refusal, credential omission, timeout and response-size caps all already live in `complianceSourceConnectorRuntime.ts` and `complianceRssConnector.ts`. This policy only **adds** restrictions on top; it weakens nothing.

---

## 5. Known limitation — body-only edits are not detected

Metadata-only monitoring compares title, canonical URL, item id and publication date.

**It cannot detect a body-only edit.** If an article's text is silently rewritten while its title, URL, id and date stay the same, the system will report `unchanged`.

This is an accepted, deliberate trade: change-detection sensitivity is given up in exchange for not copying the body. It is not a bug, and it must not be "fixed" by hashing the content — doing so would reintroduce the copyright problem. A test documents this behaviour explicitly.

---

## 6. Human-review workflow

A Cannamonitor item surfaces as:

> **Potential development identified — primary-source verification required.**

The UI additionally states, on every Cannamonitor source:

- Cannamonitor is not an official regulatory authority. It is a secondary commercial intelligence source.
- Cannamonitor cannot be the sole basis for an approved or active compliance rule.
- A qualified human must locate and assess an official primary source before any compliance conclusion is drawn.
- No readiness, alert or enforcement consequence follows from a Cannamonitor item.

Before any substantive legal review, a human must supply the official primary-source URL, the official publisher, the jurisdiction, the publication/effective date, human-authored notes, and a verification outcome. **No automatic legal verification is implemented, and none should be.**

---

## 7. Compliance boundary (unchanged)

Cannamonitor monitoring can produce **at most** a proposed legal-update draft with `status: 'new'`, which still goes through the existing human Review Queue. That guarantee is structural, not conventional: `ProposedLegalUpdateIntent.status` is the TypeScript literal `'new'` (`complianceSourceMonitoring.ts`), so an approved or active status is unrepresentable.

Monitoring **cannot**: create a compliance rule; create an alert; alter export-readiness; or mutate a farm, batch, COA, buyer, shipment or document. No compliance scoring or rule-approval logic was modified.

---

## 8. Kill switch

Deactivating the source through the existing registry `is_active` control immediately blocks future monitoring (`evaluateManualMonitoringEligibility` refuses an inactive source before any network call). Deactivation deletes no audit evidence.

Today this is belt-and-braces: the permission gate already denies retrieval regardless of the active flag.

---

## 9. Proposed future registry entry (NOT created)

**No row has been created.** Recorded here only as a specification for a future, separately-approved step:

| Field | Value |
|---|---|
| Name | `Cannamonitor — international cannabis intelligence` |
| Jurisdiction | `International — secondary commercial intelligence` |
| Source type | `other` |
| URL | the verified monitoring endpoint (`https://cannamonitor.com/feed/`), **not** the consulting-services page |
| Active | `false` |

No migration was added and none is required: the permission gate is application-level. A narrow future migration would only be justified if durable, auditable permission evidence must live in the database — that is not proposed here.

---

## 10. To actually enable this (do not do this without a licence)

1. **Obtain written commercial permission or a licence from Cannamonitor.** This is the real blocker and the only one that matters.
2. Have the licence terms reviewed — in particular, confirm whether even title/URL/date/GUID metadata retention is permitted, and what attribution is required. (The ordinary reading is that linking metadata is fine, but "all or part of the contents" is drafted broadly and this is a lawyer's call, not an engineer's.)
3. Only then, in a reviewed code change, set `CANNAMONITOR_PERMISSION_STATUS = 'verified'`.
4. Create the inactive registry entry, under separate explicit approval.
5. Activate deliberately.

Even after all of that, the metadata-only projection stays. Article bodies remain prohibited unless the licence explicitly permits storing them — and nothing in the current legal notice does.
