# W1 — How should a compliance rule express a condition?

**Status: DECISION REQUIRED. Nothing is implemented.** This document exists so the choice is made deliberately rather than settled by whoever writes the first line of code.

Related: `docs/WATCHTOWER_CANONICAL_ARCHITECTURE.md` §9 (W1), and #157 which closed W8.

---

## The problem in one paragraph

Since #157, an approved blocking rule **does** stop a buyer pack — but only once a human has raised a `compliance_alerts` row linking that rule to that batch. The rule supplies the authority; a person supplies the judgement that this batch violates it. W1 is about the system making that judgement itself.

It cannot today, for a reason that is easy to miss: **a rule has no machine-readable condition.** The whole of `compliance_rules` is:

| column | what it holds |
|---|---|
| `title`, `description` | free text a human wrote |
| `jurisdiction`, `entity_type` | labels |
| `severity`, `is_blocking` | how much it matters |
| `status`, `effective_from`, `effective_to` | whether it is in force |

There is nothing that says *"THC must be ≤ 0.2%"*. A rule is a sentence plus metadata. That is almost certainly why enforcement was never wired up in the first place — not an oversight, but the absence of anything to evaluate.

## What a rule could evaluate against

`InventoryItem` (`src/types.ts:500`) already carries genuinely checkable fields:

`thcPct` · `cbdPct` · `moisturePct` · `waterActivity` · `harvestDate` · `cureDate` · `quantityKg` · `pricePerKg` · `priceCurrency` · `qualityGrade` · `certFileName` · `location` · `status`

So the target is realistic: *"THC above 0.2% in Thailand"*, *"moisture above 12%"*, *"harvested more than 365 days ago"*, *"no COA file attached"*. These are the shapes of real regulatory limits.

---

## Option A — A structured predicate, stored as JSON

Add `condition JSONB` to `compliance_rules`:

```json
{ "all": [
  { "field": "thcPct",       "op": "gt", "value": 0.2 },
  { "field": "jurisdiction", "op": "eq", "value": "Thailand" }
]}
```

A registry declares which fields are evaluable and their types; an evaluator walks the tree; `any` / `all` / `not` compose.

**For**
- No code execution of any kind — the gate never interprets user-authored code.
- Fully validatable on write: an unknown field or a type mismatch is rejected before the rule can be saved.
- **Explainable.** The UI can render *"THC % is above 0.2 AND jurisdiction is Thailand"* and, when it fires, say exactly which clause matched. On a gate that blocks revenue, being able to show the operator *why* is not a nicety.
- Storable, diffable, and testable as data. A rule's history is auditable.

**Against**
- Only expresses what the registry allows. Cross-entity logic (*"this farm's licence expires before this batch ships"*) needs the registry extended.
- Needs a migration and a small interpreter — perhaps 300–400 lines with tests.

## Option B — Named checks in code, selected by key

Rule stores `check_key = 'thc_over_limit'` plus `check_params = { "limit": 0.2 }`. The implementations live in TypeScript.

**For**
- Maximum expressiveness — a check can do anything, including cross-entity queries.
- Type-safe end to end; no interpreter to get wrong; trivial to unit test.
- Fastest to a first working rule.

**Against**
- **A compliance officer cannot author a rule.** Every new regulation needs a developer and a deploy. That is the opposite of the Watchtower's premise, where a regulator publishes something and a human turns it into an enforceable rule the same day.
- The rules table stops being the source of truth about what is enforced; the code becomes it.

## Option C — An expression string, parsed and evaluated

`thcPct > 0.2 && jurisdiction == "Thailand"`, parsed by a small sandboxed evaluator.

**For**
- Most natural to author and read.
- Arbitrary composition without a tree structure.

**Against**
- **Needs a parser, and this is a security gate.** Anything short of a real sandbox risks evaluating attacker-influenced input; `eval` and `new Function` are disqualifying. A hand-written parser is more code to be wrong than Option A's tree-walker.
- Poor failure behaviour: a typo becomes a runtime error, and the fail-closed contract turns it into a blocked pack with an unhelpful message.
- Hardest of the three to explain back to an operator.

---

## Recommendation: **A, with B as an escape hatch**

Structured predicates for everything expressible as *field / operator / value*, which covers the regulatory limits actually seen in this domain. Where a rule genuinely needs cross-entity logic, allow `{"check": "named_key"}` as one predicate type, implemented in code and referenced by name. That keeps the common case authorable by a human and the hard case possible, without a parser anywhere near the gate.

## Whichever is chosen, these hold

1. **Fail closed, as the gate already does.** If a rule's condition cannot be evaluated — unknown field, absent data, evaluator error — that is not "no violation". It must raise an alert for a human, never silently pass. This mirrors `rulesUnverified` in `computeBuyerDisclosureStatus`.
2. **Evaluation raises an alert; it never blocks directly.** The alert stays the single thing the gate reads, so there is one blocking path rather than two. #157's gate needs no change.
3. **An auto-raised alert must be distinguishable from a human-raised one** and must record which rule version fired against which batch data, or nobody can audit why a pack was blocked.
4. **Never auto-*resolve*.** A machine may raise a block; only a human may clear one. The reverse would let a data edit silently unblock a pack.
5. **Dry-run before enforcement.** A new rule should be runnable across existing batches to show what it *would* flag, before it is allowed to block anything. Without this, the first enforcing rule is authored blind — and 182 candidates are already queued.

## Open question this depends on

`isRuleEnforcedNow` accepts `approved` **and** `active`; the database's `compliance_rules_currently_enforced()` accepts only `active` (#162). Auto-evaluation makes that divergence sharper — a rule that starts raising alerts the moment it is approved behaves very differently from one that waits to be switched on. **Decide what `approved` means before building this.**
