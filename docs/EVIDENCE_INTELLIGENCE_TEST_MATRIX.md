# Evidence Intelligence — Test Matrix (Phase A)

Every required behaviour mapped to its test file, test name, expected result,
and implemented status. All rows are **Implemented** and passing (81 tests
across 4 files) unless noted.

Test files:

- `src/lib/evidenceAiGuard.test.ts`
- `src/lib/evidenceAiAnalysis.test.ts`
- `src/lib/evidenceConflictDetection.test.ts`
- `src/lib/evidenceCompleteness.test.ts`

## Guards — request eligibility

| Requirement | Test file | Test name | Expected | Status |
| --- | --- | --- | --- | --- |
| Missing evidence | analysis | request guards › `rejects missing evidence` | `code: missing_evidence` | ✅ |
| Missing evidence (guard unit) | guard | assessEvidenceRequestEligibility › `rejects missing evidence (null and empty content)` | `missing_evidence` | ✅ |
| Oversized evidence | analysis / guard | `rejects oversized evidence` | `oversized_evidence` | ✅ |
| Absent provider | analysis / guard | `rejects an absent provider` / `rejects when no provider is configured` | `provider_unconfigured` | ✅ |
| Unsupported capability | analysis / guard | `rejects an unsupported capability` | `unsupported_capability` | ✅ |
| Request already in progress | analysis / guard | `rejects when a request is already in progress` | `request_in_progress` | ✅ |
| Allow well-formed request | guard | `allows a well-formed request` | `action: allow` | ✅ |

## Guards — output & provenance validation

| Requirement | Test file | Test name | Expected | Status |
| --- | --- | --- | --- | --- |
| Invalid confidence | guard | validateProviderEnvelope › `rejects an invalid confidence`; isValidConfidence › `accepts finite 0..1 and rejects everything else` | `invalid_confidence` | ✅ |
| Missing provenance | guard | validateProviderEnvelope › `rejects missing / malformed provenance` | `missing_provenance` | ✅ |
| Missing provenance reference (extracted value) | guard | validateExtractedValue › `rejects a non-null value that carries no provenance reference` | `missing_provenance_reference` | ✅ |
| Unknown output fields | guard | validateProviderEnvelope / capability validators › `rejects … unknown fields` | `malformed_output` | ✅ |
| Missing required fields / wrong item types | guard | validateExtractedValue / capability validators | `malformed_output` | ✅ |
| Unsupported evidence type | guard | classification validator › `rejects … unsupported enum values` | `unsupported_type` | ✅ |
| Empty mandatory value | guard | summary/review validators › `rejects an empty …` | `empty_output` | ✅ |
| Malformed provider output | analysis | provider failures › `rejects a malformed envelope` | `malformed_output` | ✅ |
| Empty output | analysis | provider failures › `rejects an empty (null value) output` | `empty_output` | ✅ |

## Guards — wording safety

| Requirement | Test file | Test name | Expected | Status |
| --- | --- | --- | --- | --- |
| Unsafe approval/certification language | guard | guardEvidenceWording › `rejects unqualified approval / certification / authentication claims` | `isSafe: false` | ✅ |
| Unsafe language blocked end-to-end | analysis | provider failures › `rejects a shape-valid draft that makes an approval/certification claim` | `unsafe_output` | ✅ |
| Safe qualified language passes | guard | guardEvidenceWording › `accepts safe, qualified reviewer language` | `isSafe: true` | ✅ |
| Negated claim passes | guard | guardEvidenceWording › `excludes a claim negated within the preceding window` | `isSafe: true` | ✅ |
| Per-field independence | guard | guardEvidenceWordingFields › `a trailing negation in one field cannot mask an unsafe claim in another` | tagged finding | ✅ |
| Prose-only scanning (no enum values) | guard | collectDraftProse › `returns only AI-authored prose, never machine enum values` | `['uncertaintyNote']` | ✅ |

## Guards — prompt injection

| Requirement | Test file | Test name | Expected | Status |
| --- | --- | --- | --- | --- |
| Injected instructions treated as data only | analysis | prompt injection › `treats injected instructions as data: the request keeps its literal guarantees` | request guarantees intact; content passed verbatim | ✅ |
| Coerced approval echo blocked | analysis | prompt injection › `blocks output if the model is coerced into echoing the injected approval claim` | `unsafe_output` | ✅ |

## Guards — provider error / timeout

| Requirement | Test file | Test name | Expected | Status |
| --- | --- | --- | --- | --- |
| Provider error | analysis | provider failures › `maps a thrown error to provider_error` | `provider_error` | ✅ |
| Provider timeout | analysis | provider failures › `maps an AbortError to provider_timeout` | `provider_timeout` | ✅ |

## Conflict detection

| Requirement | Test file | Test name | Expected | Status |
| --- | --- | --- | --- | --- |
| Shared batch identifier across cultivars | conflict | detectSharedBatchAcrossCultivars › `flags one batch identifier linked to multiple cultivars` | `shared_batch_multiple_cultivars` | ✅ |
| Same batch + same cultivar → no false conflict | conflict | `does NOT flag the same batch with the same cultivar` | 0 findings | ✅ |
| Holder / ownership mismatch | conflict | detectEntityOwnershipMismatch › `flags a third-party licence …` | `entity_ownership_mismatch` | ✅ |
| Expired licence / certificate | conflict | detectExpiredEvidence › `flags a certificate expired before the relevant date` | `expired_evidence` | ✅ |
| Expiry deterministic (no clock reliance) | conflict | `skips expiry evaluation entirely when no asOfDate is supplied` | 0 findings | ✅ |
| Sample before harvest | conflict | detectDateChronologyErrors › `flags a sample date before the harvest date` | `sample_before_harvest` | ✅ |
| Report before sample | conflict | `flags a report date before the sample date` | `report_before_sample` | ✅ |
| Missing CoA→batch link | conflict | detectMissingCoaBatchLink › `flags a CoA with no batch identifier` | `missing_coa_batch_link` | ✅ |
| Translation without original | conflict | detectTranslationWithoutOriginal › `flags a translation with no source-language original present` | `translation_without_original` | ✅ |
| Duplicate checksum | conflict | detectDuplicateChecksums › `flags two records sharing an identical checksum` | `duplicate_checksum` | ✅ |
| Same report number, inconsistent values | conflict | detectInconsistentReportValues › `flags the same report number carrying different values` | `inconsistent_report_values` | ✅ |
| Lab result without approved specification | conflict | detectLabResultWithoutApprovedSpecification › `flags a CoA with no approved specification attached` | `lab_result_without_approved_specification` | ✅ |
| Clean record → no findings | conflict | aggregate › `returns no findings for a clean, consistent record` | 0 findings | ✅ |
| Findings are observations, never decisions | conflict | aggregate › `aggregates findings … and never returns a decision field` | `requiresHumanReview: true`, no `decision`/`approved` | ✅ |

## Completeness

| Requirement | Test file | Test name | Expected | Status |
| --- | --- | --- | --- | --- |
| Complete evidence set | completeness | per-requirement status › `reports a satisfied requirement as present` | `present` | ✅ |
| Missing evidence | completeness | `reports an absent requirement as missing` | `missing` | ✅ |
| Incomplete evidence | completeness | `reports a present-but-underpopulated requirement as incomplete` | `incomplete` | ✅ |
| Conflicting evidence | completeness | `reports a requirement whose record has a conflict finding as conflicting` | `conflicting` | ✅ |
| Expired evidence | completeness | `reports an expired certificate as expired` | `expired` | ✅ |
| Not-applicable evidence | completeness | `reports an explicitly not-applicable requirement as not_applicable` | `not_applicable` | ✅ |
| Pending human review | completeness | `reports a record flagged pending as pending_review` | `pending_review` | ✅ |
| Unable to verify | completeness | `reports a record flagged unverifiable as unable_to_verify` | `unable_to_verify` | ✅ |
| Percentage calculation | completeness | percentage › `computes the percentage over applicable requirements only` | `67` | ✅ |
| Percentage never crashes on 0 applicable | completeness | `is 0% when there are no applicable requirements` | `0` | ✅ |
| Explicit non-legal label | completeness | `carries the explicit non-legal label and determination flag` | label + `isLegalComplianceDetermination: false` | ✅ |
| Human review required per requirement | completeness | `every requirement assessment requires human review` | `requiresHumanReview: true` | ✅ |

## Safety guarantees (successful AI results)

| Requirement | Test file | Test name | Expected | Status |
| --- | --- | --- | --- | --- |
| `requiresHumanReview === true` | analysis | success paths › `classify: returns a labelled draft with every safety guarantee set` | true | ✅ |
| `approvesEvidence === false` | analysis | same | false | ✅ |
| `createsRule === false` | analysis | same | false | ✅ |
| `enforces === false` | analysis | same | false | ✅ |
| `issuesBuyerPack === false` | analysis | same | false | ✅ |
| `changesInventory === false` | analysis | same | false | ✅ |
| `makesBuyerFacingDecision === false` | analysis | same | false | ✅ |
| Draft is labelled + transient (not persisted) | analysis | same (`label`, `status: draft_generated`) | `EVIDENCE_DRAFT_LABEL` | ✅ |

## Success paths per capability

| Capability | Test file | Test name | Status |
| --- | --- | --- | --- |
| classify_evidence | analysis | `classify: returns a labelled draft …` | ✅ |
| extract_evidence | analysis | `extract: honestly returns a null value for the unreadable image capture time` | ✅ |
| draft_evidence_summary | analysis | `summary: returns a neutral draft` | ✅ |
| suggest_review_questions | analysis | `review questions: returns reviewer questions` | ✅ |

## Synthetic fixtures used

All fixtures are entirely fictional (no real company, licence, report number,
laboratory, cultivar, address, image, or analytical value).

| Fixture file | Models |
| --- | --- |
| `synthetic-coa-complete.ts` | complete CoA; clean AI input; **prompt-injection variant**; safe classification output; **prohibited approval-language output** |
| `synthetic-coa-no-specification.ts` | CoA with no approved specification |
| `synthetic-shared-batch-identifiers.ts` | one batch / several cultivars + same-batch/same-cultivar control |
| `synthetic-third-party-licence.ts` | licence belonging to a third party (ownership mismatch) |
| `synthetic-expired-certificate.ts` | expired certificate + valid-certificate control + `asOf` date |
| `synthetic-translation-conflict.ts` | translation with no original + with-original control |
| `synthetic-missing-traceability.ts` | record set missing a traceability stage + requirement set |
| `synthetic-image-without-metadata.ts` | image with no metadata; honest null-value extraction output |

Malformed provider output is exercised inline in `evidenceAiAnalysis.test.ts`
(malformed envelope, null value) and `evidenceAiGuard.test.ts` (unknown fields,
wrong types, invalid confidence).
