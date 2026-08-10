# COA extraction — design, for reading before any code is written

**Status:** proposal. Nothing here is built.
**Date:** 10 August 2026.
**Decides:** how a laboratory certificate of analysis becomes rows in
`document_field_extractions`, and where the boundary sits between what a machine
may assert and what only a person or a ruleset may.

Everything below was measured against the real documents. Where this contradicts
`HANDOVER.md`, the handover is wrong and section 2 says so explicitly.

---

## 1. In plain words, before any of the detail

Today a reviewer who wants to know the THC content of a batch opens a
three-page PDF and reads it. There is no other way: the table that records
extracted fields has never held a single row.

The proposal is a program that reads the certificate and writes down what it
says — sample number, batch number, the dates, the cannabinoid figures, the
heavy metals, the microbial counts — so the reviewer sees a filled-in form
instead of a PDF, with every figure carrying a note of where in the document it
came from and how confident the reading is.

The program **writes down what the certificate says. It never says whether that
is good enough.** "Is 21.31% THC acceptable for Germany?" is a question the
program is structurally prevented from answering, because the answer depends on
German law and the program has never been told what German law says. That
answer comes later, from a table of thresholds that a person fills in by citing
the instrument each threshold comes from. That table is empty today.

So this design delivers a reading aid, not a verdict machine. That is on
purpose, and section 8 is the list of things it deliberately will not do.

**The single most important idea in this document** is in section 5.3: the
laboratory prints a total THC figure, and that figure can be recalculated from
two other figures on the same page. When the recalculation agrees, it is proof
that the program paired the right numbers with the right labels. When it
disagrees, something is wrong and the document is flagged rather than trusted.
We checked this against all eleven certificates. It agrees on all eleven, and it
catches the exact failure that the messiest of the three document formats
produces.

---

## 2. Three corrections to `HANDOVER.md`

The handover was written from a partial read. Three of its claims are wrong, and
each changes the design.

### 2.1 One lab, but **two clients and two template vintages** — not one of each

The handover says "All 11 real reports are one lab, one client, one product
form." One lab is right. The rest is not.

| | Calli set | Bienestar set |
|---|---|---|
| Client | Calli Krush Co., LTD | BIENESTAR T&N Co., Ltd. |
| Report number | `RP-E2602-0197` | `2025-A25080` |
| Sample number | `EX26-0191` | `EX25-071` |
| Reported | February 2026 | February 2025 |
| Analytes | ~100 (terpenes, ~60 pesticides) | 14 |

Both cite the same in-house methods (`TNRB-QC-TM-01`, `-02`, `-03-1`, `-07-1`,
`-11`), so it is the same laboratory. But the report-number format differs
entirely, and no regular expression written for one will match the other.

**This strengthens the lab-profile decision and adds a requirement to it:
profiles must be versioned.** "TNR Bioscience" is not enough of a key. A profile
is `(laboratory, template version)`, selected by evidence found in the document,
and a document matching no known profile is queued for a human rather than
guessed at.

### 2.2 "Exactly matches" was an artifact of two-decimal display

The handover states the recomputed total THC "exactly matches" the stated total,
on the strength of one report. Across all eleven:

| Report | d9-THC | THCA | Stated total | Recomputed | Difference |
|---|---|---|---|---|---|
| RP-E2602-0191 | 2.51 | 23.70 | 23.29 | 23.2949 | +0.0049 |
| RP-E2602-0192 | 1.24 | 22.59 | 21.06 | 21.0514 | −0.0086 |
| RP-E2602-0193 | 3.00 | 22.27 | 22.52 | 22.5308 | **+0.0108** |
| RP-E2602-0194 | 2.66 | 19.19 | 19.49 | 19.4896 | −0.0004 |
| RP-E2602-0195 | 0.93 | 25.19 | 23.02 | 23.0216 | +0.0016 |
| RP-E2602-0196 | 2.29 | 28.02 | 26.86 | 26.8635 | +0.0035 |
| RP-E2602-0197 | 0.90 | 23.27 | 21.31 | 21.3078 | −0.0022 |
| EX25-068 | 1.13 | 24.82 | 22.90 | 22.8971 | −0.0029 |
| EX25-069 | 1.79 | 26.40 | 24.94 | 24.9428 | +0.0028 |
| EX25-070 | 1.39 | 25.64 | 23.88 | 23.8763 | −0.0037 |
| EX25-071 | 1.57 | 19.82 | 18.95 | 18.9521 | +0.0021 |

It agrees on all eleven, which is a strong result. It is never exact. The inputs
are published rounded to two decimals, so the recomputation inherits that
rounding, and **an equality test would reject reports 0192 and 0193, both of
which are correct** — they round to 21.05 against a stated 21.06, and 22.53
against a stated 22.52.

The design therefore names a tolerance as a constant with a reason attached.
Largest observed disagreement is 0.011; two inputs each rounded to two decimals
can move the result by up to about 0.015. **The tolerance is ±0.02**, and it
belongs beside the 0.877 factor, not buried in a comparison.

### 2.3 The multi-COA pack is a different file from the one named

The handover names `รวมไฟล์ฉบับแปล Calli 2026*.pdf` as "three copies of a
15-page combined pack" holding five COAs. Measured:

- `รวมไฟล์ฉบับแปล Calli 2026.pdf` is **9 pages**, exists in three byte-identical
  copies, and **yields zero characters of text on every page.** It is a scan.
- `COA's & Licences.pdf` is the 15-page pack: **licences on pages 1–10, COAs on
  pages 11–15.**
- `COA MANGO INDOOR.pdf` is byte-identical to `RP-E2602-0196` under a filename
  carrying no report number.

The COA pages of the 15-page pack hold **four distinct certificates, not five** —
sample `EX25-071` appears on both page 11 and page 15, same report number, same
figures.

Two consequences:

**Deduplication key.** Not the filename, which duplicates and renames freely.
Not the batch number: six of the seven Calli reports share batch `F4-122025`
across six different strains. Not the strain: "Red Dragon" appears on two
reports with different batches and different results. **The key is
`(report_no, sample_no)`.**

**The scanned pack makes optical reading a required input shape, not a
refinement.** A design that assumes a text layer cannot read it at all — not
partially, not with low confidence: not at all.

---

## 3. Three document shapes, and how each one breaks

This is the part that determines the architecture, so it is worth being concrete.

### Shape A — Calli 2026, mostly well behaved

Analyte rows extract cleanly, one row per line, in order:

```
Cannabidiolic acid (CBDA) N/A 0.11 %w/w 0.00003
d9-Tetrahydrocannabinol (d9-THC) N/A 0.90 %w/w 0.00004
```

`analyte · specification · result · unit · limit of detection`. Straightforward.

**But two things break even here.**

*The header fields are detached from their labels.* Page one opens with

```
Report No. :
Sample received date :
Reported on :
```

— three labels with nothing after them. The values `RP-E2602-0197`, `11/02/2026`
and `27/02/2026` appear roughly two thousand characters later, at the foot of
the page. A parser that reads "the value follows the label" extracts three empty
strings and reports success.

*Some analyte names vanish entirely.* Page three of report 0197 contains nine
rows of the form

```
N/A ND mg/kg N/A
```

with **no analyte name at all**. The name is present in the printed page and
absent from the text layer. These are pesticide rows, all "not detected", so
little turns on them here — but a design that silently drops unlabelled rows, or
silently attaches them to whichever analyte came last, is a design that will one
day attribute a detection to the wrong compound.

### Shape B — Bienestar 2025, column-scrambled

Here the text layer does not preserve rows at all. It emits the whole analyte
column, then the whole methods column, then the whole values column, then the
whole units column. Page 11:

```
Arsenic (As) / Cadmium (Cd) / Lead (Pb) / Mercury (Hg) / Loss on drying / …
…in-house methods…
0.01 / 0.04 / 0.12 / 0.03 / 13.72 / 0.87 / 0.03 / 1.57 / 19.82 / 0.89 / 18.95
ppm / ppm / ppm / ppm / %w/w / …
```

Pairing is by position, which would be tolerable if position were stable.
**It is not.** On page 13 of the same file, produced by the same lab from the
same template on the same day, the two totals are emitted *first* instead of
last:

```
page 11:  As, Cd, Pb, Hg, LoD, CBD, CBDA, d9, THCA, TotalCBD, TotalTHC
page 13:  TotalCBD, TotalTHC, As, Cd, Pb, Hg, LoD, CBD, CBDA, d9, THCA
```

A parser that learned the order from page 11 reads page 13 as arsenic 0.96 ppm
and cadmium 24.94 ppm — where the true readings are 0.04 and 0.04 — and puts
the loss-on-drying figure of 13.14 into cannabidiolic acid. Every figure is
wrong, most are individually plausible, and nothing in the schema would catch
it.

**This is the failure the recompute exists to catch,** and section 5.3 shows it
working.

### Shape C — the scanned pack, no text at all

Nine pages, zero extractable characters. Only optical reading applies. Its
output is inherently lower-confidence than shapes A and B and must be marked as
such rather than mixed in.

### Not a COA at all

Pages 1–10 of the 15-page pack are licences: a cultivation licence, an
import-of-seeds licence, and an SGS GACP certificate (`TH24/00000998`). These
are a **different class of document** with different fields, and the first thing
the pipeline must decide about any page is whether it is a COA at all.

---

## 4. The pipeline

Five stages. Each is separately testable, and the boundaries are placed so that
the stages which can be tested without a network are the ones that hold the
logic.

```
  PDF
   │
   ├─ 1. SEGMENT      which pages are COAs, and which COA is each page part of
   │                  → n candidate reports, or "not a COA"
   │
   ├─ 2. PROFILE      which (laboratory, template version) is this
   │                  → a profile, or "unknown" → human queue, stop
   │
   ├─ 3. READ         text layer, or optical if there is none
   │                  → labelled cells with page and position
   │
   ├─ 4. RECONCILE    checks that can fail: arithmetic, dates, units, coverage
   │                  → fields with confidence, and warnings
   │
   └─ 5. PERSIST      rows in document_field_extractions
```

**Stages 1, 2 and 4 are pure.** No network, no Supabase, no PDF library —
they take structured input and return structured output, following the split
`serverAiSummary.ts` already uses. This is where every constraint in section 5
lives, and it is testable against the eleven real certificates as fixtures.

**Stage 3 is the only stage that may call a model,** and it is asked only to
transcribe: "what text is in this cell." It is never asked what a value means,
whether a result passes, or what a threshold is.

---

## 5. The three constraints, made mechanical

A constraint that lives only in a document is a constraint that will be violated
by the third person to touch the code. Each of these is a test.

### 5.1 Dates are DD/MM/YYYY — fixed by profile, never inferred per document

**The format is a property of the lab profile.** It is not detected from the
document, and no evidence found inside a document may change it. This matters
because the tempting alternative is nearly right and completely wrong: one could
observe that `17/02/2026` has no valid month in the first position and conclude
the document is DD/MM. That reasoning works here and fails silently on the first
document where every date happens to be ambiguous.

So: the profile declares DD/MM/YYYY. Two further checks exist, and both have
**one direction of authority — they may reject a date, never reassign the
format:**

*Impossible components.* A first component above 12 under the declared format is
a contradiction; the date is rejected.

*Ordering.* Within one report the dates have a necessary order:

```
sample received  ≤  testing start  ≤  testing end  ≤  reported on
```

On report 0197: received 11/02/2026, testing 17/02→27/02/2026, reported
27/02/2026. Consistent. Read the same document as US-format and "received"
becomes 2 November 2026 — after the report was issued. The check fails and the
dates are rejected.

**Rejection means `null` plus a warning. It never means a second guess.** A
wrong date here is wrong by nine months and parses perfectly.

### 5.2 The model extracts. It never judges.

Enforced in three places rather than trusted:

1. **The prompt contains no thresholds, limits, or the words pass, fail,
   comply or acceptable.** A test asserts this over the prompt text, in the
   manner of `publicCopyConstraints.test.ts`.
2. **The output schema has no verdict field to put one in.** There is no
   `passes`, no `compliant`, no `status`. A model that volunteers a judgement
   has nowhere to write it.
3. **The specification column is captured verbatim and never interpreted.**

On point 3 the handover is right in substance and wrong in detail. It says every
specification cell reads `N/A`. On the Calli reports, so it does. On the
Bienestar reports the same column reads **`Nonspecific`** — eleven times on page
11. Both mean the lab has stated no limit; the tokens differ, and code that
tests `=== 'N/A'` would treat "Nonspecific" as a limit that had been stated.

The rule is simpler than either: **the specification column is transcribed and
never parsed.** Whatever it says, it is not a threshold this system will act on.
Thresholds come from `destination_rulesets` alone.

### 5.3 The recompute is a structural check on the extraction, not just on the lab

`total_thc = d9_thc + (THCA × 0.877)`, compared to the stated total within
**±0.02** (section 2.2).

The handover frames this as a confidence signal about the laboratory. It is
much more useful than that. **It is the strongest evidence available that the
extractor paired the right labels with the right values,** because it uses three
numbers from three different rows and can only agree if all three were read
correctly.

Worked on the real failure from section 3, shape B. Page 13, parsed with the
column order learned from page 11:

```
  read as:      d9-THC 0.92    THCA 0.05    stated total 26.40
  recomputed:   0.92 + (0.05 × 0.877) = 0.9639
  against:      26.40
  difference:   25.44   →  exceeds ±0.02  →  FLAGGED
```

And parsed correctly:

```
  read as:      d9-THC 1.79    THCA 26.40   stated total 24.94
  recomputed:   1.79 + (26.40 × 0.877) = 24.9428
  difference:   0.0028  →  within ±0.02   →  consistent
```

Here the mis-parse happens to be gross. It need not be: reorder two adjacent
cannabinoid rows instead of eleven and every figure stays inside its normal
range, so no plausibility check on individual values would fire. The arithmetic
fires anyway, because it is the only check that tests the *relationship between*
three cells rather than the credibility of one.

Where a report states no total, the recomputed value is recorded as
`machine_extracted` with the working shown in provenance, and is not presented
as the lab's figure.

---

## 6. Confidence, warnings, and what must never be blank

`document_field_extractions` already carries `provenance` and `confidence`, and
migration 28 already constrains them. The design conforms rather than extends.

**Confidence.** `machine_extracted` requires a confidence in [0,1]; every other
provenance forbids one. A value outside [0,1] is **a broken reply, not a
confident one** — it is rejected, not clamped, because clamping 1.5 to 1.0
promotes an unvalidated reading to certainty.

Proposed bands, to be argued about now rather than after the first hundred rows:

| Band | Meaning |
|---|---|
| 0.95 | Text layer, labelled row, arithmetic consistent |
| 0.80 | Text layer, labelled row, no arithmetic check applies |
| 0.60 | Text layer, position-paired (shape B), arithmetic consistent |
| 0.40 | Optically read (shape C) |
| — | Position-paired and arithmetic *inconsistent* → not written; warning |

**Absent fields are warnings, never blanks.** Migration 28 enforces
`CHECK (field_value_text IS NOT NULL OR extraction_warning IS NOT NULL)`, and
three fields are simply not in this laboratory's panel:

- `water_activity` — this lab reports **loss on drying** instead (10.76 %w/w on
  report 0197). These are different measurements and one must not be recorded as
  the other.
- `residual_solvents_result` — not tested.
- `accreditation_reference` — not printed.

Each is written with a warning naming the reason. A buyer asking "what is the
water activity" gets "this laboratory does not measure it", which is an answer.
A blank is not.

**Unlabelled rows** (section 3, shape A) are recorded as warnings against the
report, with the page and row position, and are never attached to a neighbouring
analyte.

---

## 7. What gets written

Per certificate, keyed `(report_no, sample_no)`:

- **Identity** — report no, sample no, sample name, batch no, material batch no
- **Dates** — received, testing start, testing end, reported, manufacturing,
  expiry (each independently nullable, per 5.1)
- **Physical** — appearance, colour, foreign matter, moisture, loss on drying
- **Identification** — macroscopic, microscopic, HPLC retention
- **Cannabinoids** — each analyte, with unit and limit of detection; both stated
  totals; the recomputed total and its agreement
- **Heavy metals, mycotoxins, pesticides, microbials** — as reported, `ND`
  preserved as `ND` and never converted to zero
- **Warnings** — absent fields, unlabelled rows, failed checks

`ND` is "below the limit of detection", not "zero". The limit of detection is
printed beside it (`0.00004 %w/w` for d9-THC) and is the only honest way to
express what is known. Recording zero asserts an absence the instrument cannot
demonstrate.

---

## 8. What this deliberately does not do

- **It issues no verdict**, for any destination, ever. `destination_rulesets`
  holds zero rows; with no thresholds there are no verdicts, and that is correct
  behaviour rather than a gap to be worked around.
- **It does not decide whether a document is authentic.** It reads what is
  printed. A forged certificate extracts perfectly.
- **It does not read licences** (pages 1–10 of the pack). Different class,
  different design, later.
- **It does not touch `inventory_items`.** That was PR #137's approach and the
  column it wrote to does not exist.
- **It shows nothing to a buyer.** Reviewer-facing only, until a person has
  looked at extracted output against the source PDF enough times to trust it.

---

## 9. Four questions only the owner can answer

**9.1 How should a multi-COA file be represented?**
`document_field_extractions` ties rows to one document, and one file holds four
certificates. Three options: one document row per certificate at upload
(cleanest, changes intake); a sub-document key on the extraction rows (schema
change); or refusing multi-COA files (simplest, and the supplier sent one
anyway). **This is a schema decision and blocks stage 5, not stages 1–4.**

**9.2 Confirm the confidence bands in section 6.** They are proposed, not
derived. Once rows exist they are hard to re-scale.

**9.3 The split of `max_thc_pct` — confirm the migration.**
Into `max_total_thc_pct` and `max_delta9_thc_pct`, both nullable, as agreed.
Next free number is **67**. Worth doing before the first ruleset row, not after
fifty. Note that the reports state both figures, so a jurisdiction regulating
either can be served — but only if the column exists to record which.

**9.4 One flagged fact, outside this design's scope.**
The SGS GACP certificate in the evidence pack, `TH24/00000998` for BIENESTAR
T&N, was valid **27 December 2024 until 26 December 2025**. It expired nearly
eight months ago. Nothing in this design acts on that — it is recorded here
because it was read in passing and someone should know.

---

## 10. Build order

Each step is useful on its own and independently reviewable.

1. **Fixtures.** The nine distinct files — carrying eleven distinct
   certificates — as committed test data, with their measured shapes recorded.
   Everything else is tested against these.
2. **Stage 4, reconcile** — pure, no dependencies, holds every constraint in
   section 5. Written first because it is the part that must be right.
3. **Stage 2, profile** — Calli 2026 and Bienestar 2025 as two versioned
   profiles; unknown routes to a human.
4. **Stage 1, segment** — COA versus licence, and page-to-certificate grouping,
   proven against the 15-page pack including its duplicated page.
5. **Stage 3, read** — text layer first. Optical reading is deferred until the
   text path is trusted, and the scanned pack stays unread until then.
6. **Stage 5, persist** — last, and blocked on question 9.1.

Steps 1–4 need no model, no network and no database, and cover every constraint
in this document. If the work stops after step 4, what exists is a tested reader
with nothing to write to — which is a better position than the current one,
where nothing has ever been extracted at all.
