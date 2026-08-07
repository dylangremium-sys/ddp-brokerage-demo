# DDP Brokerage — Search Exposure & Compliance Master Plan

**Purpose:** single execution document for controlling public search exposure, protecting private application surfaces, improving technical integrity, and making public company information accurate and auditable.

**Status:** DOCUMENTATION ONLY. This file does not itself change production behaviour, DNS, Vercel configuration, Search Console, application metadata, authentication, routing, or indexing. Every implementation item below requires evidence before it can be marked complete.

**Baseline branch:** `main`

**Baseline commit at document creation:** `b5816403a952c40fc4d0630a7c742e8748263425`

**Created:** 2026-08-07

---

## 1. Scope and boundaries

This plan is intentionally limited to:

- public/private search-exposure boundaries;
- canonical-domain consistency;
- robots and sitemap correctness;
- accurate non-promotional metadata;
- prevention of accidental indexing of authenticated or sensitive surfaces;
- public legal/company-information clarity;
- accessibility and performance hygiene;
- privacy and information-leak prevention;
- search-engine monitoring for indexing errors and stale URLs;
- automated regression tests and deployment verification.

This plan does **not** authorize:

- public indexing of inventory, batch availability, prices, offers, buyer information, farmer evidence, COAs, internal procurement decisions, or authenticated dashboards;
- consumer acquisition campaigns;
- product-rich-result markup, merchant feeds, price/availability schema, or shopping integrations;
- unsupported legal, regulatory, export, certification, pharmaceutical, quality, or compliance claims;
- publishing documents simply because they exist in the database or repository.

The controlling principle is:

> **Public search should expose only information intentionally approved for public corporate communication. Operational, transactional, identity, evidence, and review data remain outside public search.**

---

## 2. Verified repository baseline

The following statements were directly checked against GitHub at creation time.

### 2.1 Global HTML metadata

`index.html` currently contains:

- `<html lang="en">`;
- favicon;
- viewport metadata;
- title: `DDP Brokerage — Procurement Intelligence`;
- font preconnect/imports.

At the audited baseline, `index.html` does **not** contain a canonical link, meta description, or global robots directive.

**Evidence:** `index.html`

### 2.2 Routing model

The application is primarily state-routed rather than conventional URL-routed. `App.tsx` imports public, farmer, and admin pages and synchronizes selected application state to the browser URL through `src/lib/urlRouting.ts`.

At the audited baseline, the explicit cold-load path mapping is:

- `/farmer` → `farmer-register`

Other application pages generally revert the address bar to `/` unless explicitly added to `PAGE_TO_PATH`.

**Evidence:** `src/App.tsx`, `src/lib/urlRouting.ts`

### 2.3 Public navigation classes

`src/lib/navigationGuard.ts` currently classifies:

- `landing`
- `login`
- `farmer-register`
- `set-password`
- `forgot-password`

as public application states, while farmer operational pages and DDP admin pages are protected by navigation logic.

**Important:** client-side navigation classification is not a substitute for authentication, authorization, database RLS, or server-side data protection.

### 2.4 robots discovery

A repository code search for `robots` returned no matching file at document creation time. This must be re-verified before implementation because repository state can change after this document is written.

---

## 3. Status vocabulary

Use only these completion labels in this workstream.

| Label | Meaning |
|---|---|
| `NOT STARTED` | No implementation evidence exists. |
| `IN PROGRESS` | Work exists but the acceptance test is not complete. |
| `IMPLEMENTED — UNVERIFIED` | Code/config is present but deployed behaviour has not been proved. |
| `VERIFIED` | Repository evidence and required deployed/runtime evidence both pass. |
| `BLOCKED` | A named external dependency prevents completion. |
| `REJECTED` | Proposed change was reviewed and deliberately not adopted. |

A checkbox alone is not proof. Every `VERIFIED` item must link or point to its evidence.

---

# 4. Priority matrix

## P0 — exposure and correctness

- [ ] P0.1 Re-baseline current `main` before making changes.
- [ ] P0.2 Establish one canonical hostname and prove redirects.
- [ ] P0.3 Create an explicit public-search route register.
- [ ] P0.4 Prevent `/farmer` and any future onboarding/auth deep links from being indexed unless specifically approved for public indexing.
- [ ] P0.5 Confirm authenticated/admin/farmer operational data is not reachable anonymously.
- [ ] P0.6 Ensure sitemap contains only approved public corporate URLs.
- [ ] P0.7 Prevent operational documents, COAs, buyer packs, signed URLs, storage objects, and API responses from becoming indexable public URLs.
- [ ] P0.8 Add regression tests for all above controls.

## P1 — public-information integrity

- [ ] P1.1 Add accurate public company/legal-information surfaces where required.
- [ ] P1.2 Add accurate page titles/descriptions for approved public corporate pages.
- [ ] P1.3 Add canonical metadata to approved public pages.
- [ ] P1.4 Add privacy, terms, contact, and compliance-methodology links where legally/business appropriate.
- [ ] P1.5 Remove unsupported absolute compliance/certification language from public surfaces.
- [ ] P1.6 Confirm accessibility baseline and fix critical violations.
- [ ] P1.7 Confirm Core Web Vitals/performance regressions are not introduced by public-site changes.

## P2 — monitoring and governance

- [ ] P2.1 Establish Search Console ownership for monitoring/removal purposes.
- [ ] P2.2 Submit the approved public sitemap.
- [ ] P2.3 Monitor indexing for unexpected application/auth URLs.
- [ ] P2.4 Create a release checklist for search-exposure changes.
- [ ] P2.5 Add an automated sensitive-content exposure scan to CI.

---

# 5. Phase 0 — re-baseline before implementation

Do not implement against this document's August 7 snapshot without first re-checking current `main`.

## Required evidence

Record the following in the implementation PR:

```text
git rev-parse HEAD
git status --short
npm test
npx tsc -b
npm run lint
npm run build
```

Also record:

- current `index.html` metadata;
- current `vercel.json`;
- current URL mappings in `src/lib/urlRouting.ts`;
- current `PUBLIC_PAGES` in `src/lib/navigationGuard.ts`;
- presence/absence and contents of `robots.txt`;
- presence/absence and contents of `sitemap.xml`;
- current production responses for canonical-host checks.

### Gate 0

**PASS only when the implementation PR states the exact commit audited.**

---

# 6. Phase 1 — public-search route register

Create:

```text
docs/PUBLIC_SEARCH_ROUTE_REGISTER.md
```

Every externally reachable route must be assigned exactly one classification:

| Classification | Meaning |
|---|---|
| `PUBLIC_INDEXABLE` | Approved corporate information intended for public search. |
| `PUBLIC_NOINDEX` | Reachable without prior login but not intended for search indexing. |
| `AUTHENTICATED` | Requires authenticated session and authorization. |
| `SERVER_ONLY` | API/server route; never a public document surface. |
| `REMOVED` | Legacy URL that must redirect, return 404/410, or be removed from indexes. |

Minimum entries to audit:

```text
/
/farmer
/login (if/when deep-linkable)
/forgot-password (if/when deep-linkable)
/set-password (if/when deep-linkable)
all future public legal/company pages
all /api/* routes
all storage/public-object URL patterns
all signed-document URL patterns
all preview/share-link patterns
```

For every route record:

- classification;
- owner;
- authentication requirement;
- whether search indexing is allowed;
- canonical URL if indexable;
- robots/X-Robots-Tag behaviour;
- sitemap inclusion yes/no;
- data sensitivity;
- test that proves the classification.

### Gate 1

No route may enter production without a row in the register.

---

# 7. Phase 2 — canonical-domain control

Choose exactly one production hostname as canonical. If `https://www.ddpbrokerage.com/` remains the canonical origin, all alternate protocol/hostname variants must redirect directly to it.

Verify these variants:

```text
http://ddpbrokerage.com/
https://ddpbrokerage.com/
http://www.ddpbrokerage.com/
https://www.ddpbrokerage.com/
```

Acceptance requirements:

1. One variant returns the final `200` response.
2. Every other variant returns a permanent redirect (`301` or `308`).
3. No redirect loop.
4. Avoid unnecessary multi-hop redirect chains.
5. The final public page emits the chosen canonical URL.
6. `version.json` remains reachable through the canonical deployment path used by CI.

Record the exact `curl -I` output in the implementation evidence.

### Gate 2

A developer statement such as "Vercel is configured" is insufficient. The deployed HTTP response is the evidence.

---

# 8. Phase 3 — robots, noindex and sitemap controls

## 8.1 Key rule

`robots.txt` is **not** an access-control mechanism.

Sensitive information must be protected through authentication, authorization, RLS/storage policy, signed URL rules, and/or server controls. Search directives are an additional publication boundary only.

## 8.2 Public-noindex surfaces

Any unauthenticated route used for account setup, password recovery, invitation completion, supplier onboarding, or similar workflow should default to `PUBLIC_NOINDEX` unless an explicit review approves indexing.

Because `/farmer` is currently a real deep link, it requires an explicit indexing decision and test.

Prefer a response-level `X-Robots-Tag: noindex, nofollow` where infrastructure allows reliable path-specific headers. If metadata is set client-side, add a test proving the correct directive appears for the rendered public-noindex state and is removed/replaced when navigating back to an approved indexable public page.

## 8.3 robots.txt

Create a deliberate robots policy rather than treating absence as a default policy.

Requirements:

- do not rely on `Disallow` to hide sensitive content;
- do not list secret/private URL patterns that would unnecessarily advertise implementation details;
- reference the canonical sitemap if one exists;
- keep the file minimal and reviewed.

## 8.4 sitemap.xml

The sitemap must contain **only** `PUBLIC_INDEXABLE` canonical pages.

It must never contain:

- onboarding/authentication URLs;
- farmer/admin application states;
- API endpoints;
- storage objects;
- inventory/batch documents;
- document download links;
- signed URLs;
- preview tokens;
- internal search/filter URLs;
- demo/test paths;
- redirects or non-200 pages.

### Gate 3

Automated test must compare sitemap URLs with the approved route register.

---

# 9. Phase 4 — public metadata framework

The current Vite entry point has one global HTML title. Introduce an explicit metadata model for approved public corporate pages only.

Minimum supported fields:

```ts
interface PublicPageMetadata {
  title: string
  description: string
  canonicalPath: string
  robots: 'index,follow' | 'noindex,nofollow'
}
```

Requirements:

- one descriptive title per approved public page;
- one accurate description per approved public page;
- canonical URL derived from the approved production origin;
- no product availability, pricing, purchase calls, or transactional inventory metadata on public pages;
- no unsupported legal/regulatory claims;
- metadata updates when the state-routed application changes public page;
- stale metadata must not survive navigation between application states.

### Required tests

- landing page gets its expected title/description/canonical;
- public-noindex state gets `noindex,nofollow`;
- returning from public-noindex to landing restores indexable landing metadata;
- authenticated states cannot accidentally inject operational record values into document `<head>`;
- metadata strings do not contain test/demo fixture values.

---

# 10. Phase 5 — public corporate-information architecture

Public pages should explain the organization and its controls without exposing transactional inventory.

Candidate corporate pages, subject to legal/business approval:

```text
/about
/contact
/privacy
/terms
/compliance-methodology
```

Each page must have:

- named content owner;
- last-reviewed date;
- evidence source for factual corporate claims;
- route-register classification;
- canonical metadata;
- accessibility review;
- explicit decision on indexability.

## Compliance-language rule

Do not publish absolute claims unless documentary/legal authority exists for the exact claim.

Examples requiring strong evidence and explicit review include:

```text
fully compliant
legally compliant
approved for export
export ready
pharmaceutical approved
certified pharmaceutical grade
guaranteed compliant
verified supplier
verified batch
```

Prefer language that reflects the system's actual evidence status and human-review model.

### Gate 5

Every regulated/compliance claim on a public page must have a named source or be removed/rewritten before release.

---

# 11. Phase 6 — private-data search-exposure audit

This is a mandatory security/privacy review, not merely an SEO task.

Audit for accidental anonymous access to:

- admin pages;
- farmer operational pages;
- buyer previews;
- batch/inventory records;
- farm records;
- COAs and uploaded evidence;
- buyer packs;
- review requests;
- compliance records intended for internal use;
- signed URLs;
- storage buckets/objects;
- API responses;
- source maps containing sensitive build-time values;
- demo fixtures rendered in production.

For each surface, prove one of:

```text
401/403/404 to anonymous caller
OR
no public URL exists
OR
content is intentionally approved public corporate information
```

Search directives do not count as the proof of confidentiality.

### Gate 6

Any anonymous exposure of operational records is a release blocker.

---

# 12. Phase 7 — accessibility and performance hygiene

Public-site changes must not degrade usability.

Minimum checks:

- semantic heading order;
- keyboard navigation;
- visible focus states;
- form labels and error association;
- sufficient text/background contrast;
- meaningful link/button text;
- image alt text where images convey information;
- language attribute correctness;
- no unexpected horizontal scrolling on mobile;
- no layout shift caused by late-loaded public assets;
- reasonable initial JavaScript and font loading;
- no console errors on public pages.

Performance work must be measured before and after. Do not mark an optimization complete from code inspection alone.

### Gate 7

Attach before/after measurements or automated results to the PR.

---

# 13. Phase 8 — Search Console monitoring and stale-result cleanup

Use Search Console as a monitoring and removal-control surface.

Required operational checks:

- verify the canonical domain property;
- submit only the approved sitemap;
- inspect indexed URLs for unexpected application/auth paths;
- inspect Google-selected canonical values;
- investigate duplicate/stale hostname results;
- request removal of URLs that should never have been public when appropriate;
- record manual actions/security issues if present;
- review indexing after every search-exposure release.

Do not treat Search Console screenshots alone as proof that authentication/security controls work.

### Gate 8

Unexpected operational URLs appearing in the index become tracked defects with severity based on exposed data.

---

# 14. Phase 9 — automated regression suite

Add tests so search-exposure controls cannot silently regress.

Suggested test files:

```text
scripts/search-exposure.test.mjs
src/lib/publicMetadata.test.ts
src/lib/urlRouting.test.ts       # extend existing coverage
src/lib/navigationGuard.test.ts  # extend existing coverage where relevant
```

Minimum assertions:

1. Approved public route register exists.
2. `/farmer` has the approved search classification.
3. Public-noindex deep links receive the required robots control.
4. Sitemap contains no route classified `PUBLIC_NOINDEX`, `AUTHENTICATED`, `SERVER_ONLY`, or `REMOVED`.
5. Sitemap URLs use the canonical origin.
6. Sitemap contains no obvious token/query secrets.
7. Public metadata contains no demo fixture names/emails/IDs.
8. Public metadata contains no inventory price/availability fields.
9. `index.html` and runtime metadata do not conflict on canonical origin.
10. Production routing config keeps the canonical-host redirect policy intact.

Integrate the suite into the existing CI verification path.

### Gate 9

The full existing suite, TypeScript build, lint, production build, and new search-exposure tests must pass.

---

# 15. Phase 10 — deployment and production verification

A merged implementation is not complete until deployed behaviour is verified.

Record:

- deployed commit SHA;
- production `version.json` commit SHA;
- canonical redirect outputs;
- `robots.txt` response;
- `sitemap.xml` response;
- `/farmer` robots behaviour;
- landing-page canonical metadata;
- anonymous-access tests for protected surfaces;
- browser console check;
- accessibility/performance evidence.

Do not disable or bypass the existing CI-controlled deployment/version verification process for this workstream.

---

# 16. Implementation issue breakdown

Use these as GitHub issues or agent work packages.

## Issue A — Search exposure ground truth

**Priority:** P0

- [ ] Re-baseline current main.
- [ ] Inventory all externally reachable paths.
- [ ] Create `PUBLIC_SEARCH_ROUTE_REGISTER.md`.
- [ ] Record current production HTTP behaviour.

**Done when:** route register is reviewed and every known route has a classification.

## Issue B — Canonical host and redirects

**Priority:** P0

- [ ] Select canonical hostname.
- [ ] Implement redirects if needed.
- [ ] Add canonical metadata.
- [ ] Add regression checks.
- [ ] Prove deployed responses.

## Issue C — Public-noindex controls

**Priority:** P0

- [ ] Decide `/farmer` classification.
- [ ] Apply reliable noindex control if `PUBLIC_NOINDEX`.
- [ ] Cover future auth/onboarding deep links.
- [ ] Test state transitions do not leave stale robots metadata.

## Issue D — robots and sitemap

**Priority:** P0

- [ ] Add deliberate robots policy.
- [ ] Generate/maintain approved sitemap.
- [ ] Test sitemap against route register.

## Issue E — Private-data exposure audit

**Priority:** P0

- [ ] Anonymous browser/API checks.
- [ ] Storage/document URL checks.
- [ ] Buyer/farmer/admin record checks.
- [ ] Evidence log for every result.

## Issue F — Public corporate information

**Priority:** P1

- [ ] About.
- [ ] Contact.
- [ ] Privacy.
- [ ] Terms.
- [ ] Compliance methodology.
- [ ] Claim-evidence review.

## Issue G — Public metadata framework

**Priority:** P1

- [ ] Route/state metadata map.
- [ ] Title/description/canonical handling.
- [ ] Robots-state handling.
- [ ] Regression tests.

## Issue H — Accessibility/performance baseline

**Priority:** P1

- [ ] Baseline measurements.
- [ ] Critical accessibility fixes.
- [ ] Public performance regressions fixed.
- [ ] Evidence attached.

## Issue I — Search monitoring

**Priority:** P2

- [ ] Domain property verification.
- [ ] Approved sitemap submission.
- [ ] Unexpected indexed-URL review.
- [ ] Stale/incorrect URL remediation log.

---

# 17. Evidence template

Every implementation PR should contain this table.

| Requirement | Status | Repository evidence | Runtime/deployed evidence | Notes |
|---|---|---|---|---|
| Exact baseline commit recorded |  |  | N/A |  |
| Route register updated |  |  | N/A |  |
| Canonical host verified |  |  |  |  |
| Public-noindex routes verified |  |  |  |  |
| Sitemap restricted to approved public URLs |  |  |  |  |
| Anonymous protected-data access denied |  |  |  |  |
| Metadata tests passing |  |  |  |  |
| Accessibility checks passing |  |  |  |  |
| Performance checked |  |  |  |  |
| Full CI passing |  |  |  |  |
| Production version matches merged commit |  |  |  |  |

---

# 18. Definition of Done

This master plan is considered implemented only when all P0 items and approved P1 items are `VERIFIED`, not merely merged.

Minimum final-state requirements:

1. One canonical production hostname is proven by HTTP responses.
2. A maintained route register defines every public-search decision.
3. Only approved public corporate pages are indexable.
4. Onboarding/authentication deep links are noindex unless explicitly approved otherwise.
5. No authenticated operational records are anonymously accessible.
6. No inventory, pricing, document, COA, buyer-pack, signed-storage, or internal-review URLs are included in the public sitemap.
7. Public corporate claims are evidence-backed and reviewed.
8. Automated tests prevent sitemap/robots/canonical regressions.
9. Existing security/test/type/lint/build gates remain green.
10. Production serves the exact verified commit.
11. Search monitoring shows no known unintended operational URLs requiring remediation.

---

# 19. Change-control rule

Any future feature that creates a new URL, share link, public document, public profile, server route, or storage-access pattern must answer these questions before merge:

```text
1. What is its PUBLIC_SEARCH_ROUTE_REGISTER classification?
2. Can an anonymous user reach it?
3. Can a search crawler reach it?
4. Should it be indexed?
5. What data can it reveal?
6. Is it in the sitemap?
7. What canonical/robots behaviour applies?
8. What automated test prevents exposure regression?
```

If these questions cannot be answered, the feature is not ready to ship.

---

# 20. Final operating principle

Search exposure is a publication decision, not a side effect of routing.

DDP should treat every indexable URL as information intentionally published to the open internet. Everything else must be explicitly classified, protected, tested, and monitored.