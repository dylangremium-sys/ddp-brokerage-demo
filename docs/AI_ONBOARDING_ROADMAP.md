# DDP Onboarding AI Roadmap

**Type:** Forward-looking specification. Non-runtime. **Base commit:** `b81fa1f` (`origin/main`).
**Status:** **Nothing in this document exists. Nothing here is approved for build.** No capability described here is implemented, wired, scheduled, or committed to.
Evidence tags: **[VERIFIED]** / **[JUDGEMENT]** / **[UNKNOWN]**.

Companion to `docs/AI_SYSTEM_REGISTER.md`, `docs/AI_AUTHORITY_AND_DATA_BOUNDARIES.md`, `docs/AI_THREAT_MODEL.md`, `docs/AI_EVALUATION_PLAN.md`.

---

## 1. What this proposes, and what it refuses

A future **internal-only onboarding evidence assistant**: it reads documents a farmer has already submitted (COAs, cultivation licences, certificates), extracts candidate fields, compares them against what the farmer typed into the form, and hands a DDP administrator a structured brief of **potential inconsistencies requiring verification**.

**It is a reading and comparing tool. It is not a deciding tool.**

DDP's principle applies without exception:

> AI detects or extracts → AI drafts or summarises → **human reviews** → approved information may be used by the system.

**The stakes are higher than the current capability, and the register must say so plainly [JUDGEMENT]:** today's AI reads *public regulatory text* and produces a *transient* draft for one administrator. Onboarding AI would read a **named farmer's personal and commercial documents** and produce output that **influences whether that farmer is onboarded**. Every finding in `docs/AI_THREAT_MODEL.md` gets worse: the data becomes personal (T20), the output acquires consequence (T22), and the source documents arrive from an **unvetted external party who has an incentive to shape them** (T1, T7). That last point is new and material — today's sources are regulators with no interest in DDP; tomorrow's are applicants with a direct interest in the outcome.

---

## 2. Categorically rejected — not deferred, rejected

**[JUDGEMENT]** These are not "later" or "with more safeguards". They are outside what AI may do at DDP, and no prerequisite unlocks them.

| Rejected capability | Why |
|---|---|
| **Autonomous approval** of a farmer, farm, batch, or document | Approval is a human legal act. No confidence score substitutes. |
| **Autonomous rejection** | Rejection harms a real party with no human accountable. Silent, unappealable, at scale. |
| **Autonomous fraud determination** | An accusation about a person. Wrong = defamatory and discriminatory. AI may surface a **potential inconsistency requiring verification** — never "fraudulent". |
| **Automated legal compliance certification** | Certification is a legal conclusion. Structurally impossible today and must remain so. |
| **Public AI advice** | Unreviewed AI text to the public is legal advice DDP is not authorised to give. |
| **Buyer-facing AI conclusions** | Buyers rely on DDP's word commercially. AI output is never DDP's word. |
| **Automatic procurement decisions** | Money, contracts, counterparties. Human decision, always. |

**No AI output may ever state that a document is authentic.** It may state: **potential inconsistency**, **verification required**, **issuing-authority check required**, **human review required**. Authenticity is established by the issuing authority — never by a model, and never by DDP inferring from a model.

---

## 3. Capability register

**Users:** *Admin* = DDP administrator (internal, the only AI audience). *Farmer* = document submitter, **never an AI audience**.

**Legend:** **BUILD LATER** = acceptable in principle once prerequisites are met. **REJECT** = never.

### 3.1 Field extraction

| Capability | User | Input | Candidate output | Authoritative source | Validation | Human review | Potential harm | Prerequisite | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| **COA field extraction** | Admin | Farmer-submitted COA | Candidate fields + span citations | **The COA itself; ultimately the issuing laboratory** | Every field span-anchored to the document; verbatim | **Mandatory per field** | Misread analyte → wrong batch judgement | P1–P6 | **BUILD LATER** |
| **Cultivation-licence extraction** | Admin | Licence document | Licence number, holder, validity dates | **The issuing authority's register** | Span-anchored; **never** "valid" | **Mandatory** | Forged/expired licence read as present | P1–P6 | **BUILD LATER** |
| **Laboratory-name extraction** | Admin | COA | Candidate lab name | **Accredited-laboratory register** | Span-anchored; match against a known-lab list; unknown → flag, never reject | **Mandatory** | Fabricated lab (T18) accepted | P1–P6, known-lab list | **BUILD LATER** |
| **Certificate-number extraction** | Admin | Certificate | Candidate number | **Issuing authority** | Span-anchored; format check only | **Mandatory** | Transcription error propagates | P1–P6 | **BUILD LATER** |
| **Batch-ID extraction** | Admin | COA / packing docs | Candidate batch id | **DDP's own batch record** | Span-anchored; compared, never written | **Mandatory** | Wrong batch linked to wrong COA | P1–P6 | **BUILD LATER** |
| **Issue & expiry dates** | Admin | Any certificate | Candidate dates | **The document; then the authority** | Span-anchored; **abstain if absent — never infer** (T17) | **Mandatory** | Hallucinated expiry → expired licence looks live | P1–P6 | **BUILD LATER** |

### 3.2 Result extraction (higher stakes — numbers drive decisions)

| Capability | User | Input | Candidate output | Authoritative source | Validation | Human review | Potential harm | Prerequisite | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| **THC & CBD results** | Admin | COA | Candidate values + units + span | **The issuing laboratory** | Span-anchored; **unit must be extracted, never assumed**; abstain on ambiguity | **Mandatory, every value** | **A misread THC value is a controlled-substance error with criminal exposure** | P1–P7 | **BUILD LATER — highest scrutiny** |
| **Moisture** | Admin | COA | Candidate value + unit | Laboratory | Span-anchored; unit explicit | **Mandatory** | Quality misjudgement | P1–P6 | **BUILD LATER** |
| **Pesticide results** | Admin | COA | Candidate analytes + pass/fail **as printed** | Laboratory | Span-anchored; **transcribe the lab's own verdict; never compute one** | **Mandatory** | Missed exceedance → unsafe product | P1–P7 | **BUILD LATER — highest scrutiny** |
| **Microbiology** | Admin | COA | Candidate results **as printed** | Laboratory | As pesticides | **Mandatory** | Missed contamination | P1–P7 | **BUILD LATER — highest scrutiny** |
| **Heavy metals** | Admin | COA | Candidate results **as printed** | Laboratory | As pesticides | **Mandatory** | Missed contamination | P1–P7 | **BUILD LATER — highest scrutiny** |

**[JUDGEMENT] The rule that makes this category safe:** AI **transcribes the laboratory's own conclusion**; it never evaluates a value against a limit. "Lead: 0.4 ppm (limit 0.5 — PASS, as printed)" is transcription. "Lead is within limits" is a compliance conclusion and is **rejected**. The moment AI compares a number to a threshold, it is deciding compliance — the exact thing DDP forbids.

### 3.3 Comparison and detection

| Capability | User | Input | Candidate output | Authoritative source | Validation | Human review | Potential harm | Prerequisite | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| **Form-to-document comparison** | Admin | Farmer form + documents | **Potential inconsistencies requiring verification** | Both artefacts | Both sides span-cited; **difference reported, never adjudicated** | **Mandatory** | Framed as fraud → wrongful rejection | P1–P6 | **BUILD LATER — the highest-value capability** |
| **Farm-name matching** | Admin | Form name vs document name | Similarity + **potential inconsistency** | Registry | Both sides cited; **never a match/no-match verdict** | **Mandatory** | Legitimate variants (transliteration, legal suffixes, **Thai/Latin script**) misread as mismatch | P1–P6, transliteration handling | **BUILD LATER** |
| **Duplicate-document detection** | Admin | Submitted documents | Candidate duplicate pairs | The documents | **Hash-based first — deterministic, no AI needed** | Required to action | False duplicate → valid evidence discarded | P1–P4 | **BUILD LATER — start deterministic** |
| **Inconsistent-date detection** | Admin | Dates across documents | **Potential inconsistencies** | The documents | Every date span-cited; **arithmetic is deterministic, not AI** | **Mandatory** | Hallucinated date → phantom inconsistency | P1–P6 | **BUILD LATER** |

**[JUDGEMENT]** Duplicate detection and date arithmetic are **not AI problems**. A hash and a date comparison are exact, free, instant, and cannot hallucinate. Use AI only to *extract* the date; never to *compare* it. Every capability that can be deterministic should be.

### 3.4 Drafting and language

| Capability | User | Input | Candidate output | Authoritative source | Validation | Human review | Potential harm | Prerequisite | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| **Administrator review brief** | Admin | Extractions + comparisons | Structured internal brief | The underlying evidence | Every claim span-cited; **no recommendation, no score, no verdict** | **Mandatory** | **Over-reliance (T22): the brief becomes the review** | P1–P6, C1 sampling | **BUILD LATER — but see the warning below** |
| **Missing-information message drafts** | Admin | Gap list | **Draft** message for admin editing | DDP's own requirements | Wording guard; **never auto-sent** | **Mandatory — admin edits and sends** | Auto-send = AI communicating a decision (**prohibited**) | P1–P6, no send path | **BUILD LATER** |
| **Controlled Thai/English translation** | Admin | Thai document text | **Draft** translation, clearly labelled | **The original Thai text — always authoritative** | Original always displayed alongside; **translation never used as evidence** | **Mandatory; native-speaker review for consequential text** | Mistranslation → wrong legal reading | P1–P6, **Thai/Czech guard lexicons (F6)** | **BUILD LATER** |

**[JUDGEMENT] The review brief is the most dangerous capability in this roadmap** — and it looks the most benign. It has no authority, writes nothing, decides nothing. But it is *fluent, structured, and complete*, and it arrives before the administrator has read the documents. That is precisely how a draft becomes the decision. **[VERIFIED]** T22 is rated High/High with **no effective control today**, and the brief amplifies it more than any extraction does. It must not ship before human-review sampling (C1) can measure whether reviewers are still reviewing.

**Translation, stated precisely:** the Thai original is the evidence. The translation is a **reading aid**. No compliance conclusion may rest on a translated string. **[VERIFIED]** DDP already treats Thai review as a human, native-speaker matter (`docs/THAI_NATIVE_SPEAKER_REVIEW.md`, `docs/THAI_LEGAL_REVIEW_BUYER_DISCUSSION.md`) — AI translation must not erode that.

---

## 4. Prerequisites — none of which exist today

**[VERIFIED]** Every one of these is absent at `b81fa1f`. **No onboarding AI capability may be built until P1–P6 are met.**

| # | Prerequisite | Why | Blocking finding |
|---|---|---|---|
| **P1** | **Server-authoritative document loading** — the server loads the document by id under the authenticated admin context; the client sends **only** an id and a capability | Today the server summarises whatever the client sends. Applied to farmer documents, that means the "document analysed" need not be the document submitted (**T5**) | **F1** |
| **P2** | **Evidence-integrity verification** — recompute the canonical hash over the stored artefact; refuse on mismatch | Today the checksum is format-checked and never recomputed. Applied to a COA, the integrity guarantee is decorative (**T10**) | **F2** |
| **P3** | **Span-anchored citation with server-side validation** — every extracted field carries an offset + verbatim quote, validated against the document | Today citations are validated against nothing and are the **only field exempt from the wording guard**. **An extraction system without citation validation is a hallucination system with good formatting** (**T3**, **T6**) | **F3** |
| **P4** | **Durable AI execution log** — actor, capability, document id, evidence hash, prompt version, resolved model, outcome, timestamp | Today an AI call leaves **no trace**. Onboarding AI touching personal data with no record is indefensible to a regulator, an auditor, or the farmer (**T26**) | **F4**, **F5** |
| **P5** | **Enforceable data classification** — personal/sensitive content classified and gated **before** egress, fail-closed | Today "no personal data" is a **comment** (`aiComplianceProvider.ts:79-80`). Onboarding documents are personal data **by definition** — the comment becomes false the day this ships (**T20**) | **F10** |
| **P6** | **Multilingual guard + rate limits + cost budget** — Thai and Czech lexicons; per-actor limits; fail-closed budget | Today the guard is 8 English terms in a Thai/Czech product, with no spend ceiling (**T8**, **T24**) | **F6**, **F9** |
| **P7** | **Independent validation for result extraction** — second-pass or deterministic cross-check for THC/CBD/pesticide/microbiology/heavy metals | A misread controlled-substance value carries criminal exposure. Single-pass extraction is not enough | — |

**[JUDGEMENT]** P1–P3 are the same fix the current capability needs. **The onboarding roadmap is blocked on the recommended next PR** — which is the strongest argument for doing it first: it is not just remediation of today's capability, it is the foundation of tomorrow's.

---

## 5. Sequencing

**Phase 0 — Foundation (no AI).** P1–P6. Deterministic wins first: **hash-based duplicate detection** and **date arithmetic** need no model and should never use one.

**Phase 1 — Extraction with mandatory citation.** COA fields, licence fields, identifiers, dates. Every field span-cited. Admin verifies each. No comparison, no brief. Category A evals green.

**Phase 2 — Comparison.** Form-to-document, farm-name, date consistency. **Potential inconsistencies requiring verification** only.

**Phase 3 — Results extraction.** THC/CBD/pesticides/microbiology/heavy metals. Transcription only, P7 satisfied.

**Phase 4 — Drafting.** Review briefs and message drafts — **only after C1 sampling can measure over-reliance**.

**Never:** autonomous approval · autonomous rejection · autonomous fraud determination · automated legal certification · public AI advice · buyer-facing AI conclusions · automatic procurement decisions.

---

## 6. Standing constraints

1. **Internal only.** No farmer or buyer ever sees AI output. No AI text is ever sent to an external party unedited.
2. **Extraction is a candidate, never a fact.** Nothing is written to a farm, batch, or document record without a human act.
3. **Citation or it did not happen.** An uncited extraction is discarded, not displayed.
4. **Abstention is success.** "Not present in this document" is a correct, valuable answer. **[VERIFIED]** The existing design already understands this (`uncertainties` is a first-class section) — preserve it.
5. **Transcribe, never adjudicate.** Report what the laboratory concluded; never conclude.
6. **The authoritative source is never the model.** It is the issuing authority, the laboratory, the register, or the original-language document.
7. **AI cannot authenticate.** Potential inconsistency · verification required · issuing-authority check required · human review required.
8. **Every capability ships with its Category A evals** (`docs/AI_EVALUATION_PLAN.md`) in the same PR.
