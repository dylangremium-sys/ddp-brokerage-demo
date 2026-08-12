# Baseline — what DDP is, as built

**Measured 10 August 2026** against production, reading as `ddp_ro`, and against
`main` at `6285b55`.

Written because the next stretch of work is inventorying, and a baseline you can
build from has to say what is actually there rather than what was intended. Every
number below is labelled with how it was obtained, because two of them mean
different things.

---

## 1. In plain words

DDP is a **supplier inventory and document system** with two farms, three
batches and five accounts on it, plus a **regulatory watchtower** that has
collected 186 legal updates and is by a wide margin the most exercised part of
the platform.

It is not yet a brokerage in the operational sense. There is no buyer
organisation on the system, no reservation has ever been made, and no buyer pack
is live. That is not a defect — it reflects where the business is — but the
public site is written in the present tense about several of those things, and
§4 lists where.

The machinery merged today can read a certificate of analysis and refuse an
incoherent reading. **It has never produced a row.** Making it do so, once,
against a real document, is the first item in §7.

---

## 2. What is in production

### Real reads — a direct `count(*)` that returned a number

`ddp_ro` is **refused** on most tables (an RLS helper it cannot execute), so
where a count came back it is a true zero and not a filtered view.

| Table | Rows |
|---|---|
| `licences` | **0** |
| `organisations` | **0** |
| `destination_rulesets` | **0** |
| `reservations` | **0** |
| `permits` | **0** |

### Estimates — `pg_stat_user_tables`, because the direct read was refused

These are planner statistics, not counts. `n_live_tup` is an estimate and
`n_tup_ins` counts insert *attempts*.

| Table | Live (est.) | Inserts ever |
|---|---|---|
| `legal_updates` | **186** | 214 |
| `farmer_access_requests` | 6 | 14 |
| `profiles` | 5 | 84 |
| `inventory_batches` | 3 | 61 |
| `farms` | 2 | 92 |
| `farm_profiles` | 2 | 34 |
| `farmer_documents` | 1 | 22 |
| `farmer_photos` | 1 | 1 |
| `farmer_document_reviews` | 1 | 1 |
| `documents` | 0 | 1 |
| `document_field_extractions` | **0** | 8 |
| `buyer_pack_snapshots` | 0 | 2 |

**On `document_field_extractions` — 0 live, 8 inserts.** Do not read the 8 as
"eight extractions were attempted". A rolled-back `INSERT` still increments
`n_tup_ins`, so that figure cannot distinguish an attempt from a rollback from a
later delete. The load-bearing number is the live one: **nothing has ever been
extracted and kept.**

**On the gap between live and inserts generally** — `farms` at 2 live against 92
inserts, `profiles` at 5 against 84 — that is the shape of a system that has been
seeded, torn down and reseeded during development, which is what it was.

---

## 3. Engineering the product does not use

Three pieces exist in the schema and are not wired to anything a user reaches.
Each needs a decision, not necessarily work.

### `licences` — a table with no writers

**Fact.** The table exists, holds 0 rows, and **no code anywhere in `src/` or
`api/` writes to it.**

**Fact.** Licences do have a home: `farmer_documents.document_type` is
constrained to `('coa','licence','photo','other')`, so a licence is stored as a
typed document against a farm and a batch.

So there are two designs in the schema for one thing, and only one of them is
reachable. §6 proposes recording which one is canonical.

### The pass/fail columns on `farmer_documents`

**Fact.** The table carries `heavy_metals_status`, `pesticides_status`,
`microbial_status` and `mycotoxins_status`, each constrained to
`('pass','fail','not_tested')`.

**Fact.** The only thing that assigns them is `src/data.ts`, the demonstration
seed. No form, no API route and no review screen writes them from real input.
`complianceScoring.ts` reads them, and reads them for **presence** rather than
for value.

**Inference, and it cannot be confirmed from here.** The one live
`farmer_documents` row is refused to `ddp_ro`, so whether its status columns are
null is not verifiable with the access available. What is verifiable is that no
path exists to have set them.

**Why it matters beyond tidiness.** A pass/fail column on a document invites a
reviewer to record a verdict, and `destination_rulesets` holds zero thresholds to
judge against. A reviewer marking heavy metals "pass" is supplying an acceptance
limit from memory — the exact failure the extraction design forbids a model to
commit. The columns are currently harmless because nothing writes them. They
would stop being harmless the moment a review screen exposed them.

### `inventory_items` does not exist

**Fact.** The production inventory table is `inventory_batches`. There is no
`inventory_items` table.

This retires the last ambiguity about the closed PR #137: it was not merely
writing to a missing *column*, it was writing to a missing *table*.

---

## 4. Where the public copy and the system disagree

Scope note: the buyer positioning — *"We are buying now, for a certified
pharmaceutical buyer in Central Europe"* — was **confirmed by the owner on
10 August 2026** and is settled. It is not in this table.

| The site says | The system has | Width of the gap |
|---|---|---|
| *"DDP turns farm stock, batch records, COAs, and pricing into clear review packs for serious buyers."* | 0 live `buyer_pack_snapshots`, 0 `organisations` | The **present tense**. The capability is built; it has not been used, and there is no buyer organisation to use it for. The homepage mock beside this line is already captioned *"Illustrative example — not a live batch"*, so the visual is hedged and the sentence is not. |
| *"Licences are verified, laboratory accreditation is confirmed…"* | 0 `licences`; licences storable only as typed documents | Defensible as a description of what the team does by hand. But nothing on the platform records **that it happened**, so the claim has no evidence behind it inside the system. |
| *"helps qualified buyers assess supply, documentation and procurement readiness across licensed producer networks"* | 0 `organisations`; no buyer account | Legacy buyer-side positioning, predating the supplier acquisition rewrite. Two audiences in one page. |

---

## 5. Proposed copy changes — owner decides, nothing changed here

Two edits, verbatim. **Neither is applied.**

**A. The hero line — present tense to capability.**

> **Now:** "DDP turns farm stock, batch records, COAs, and pricing into clear
> review packs for serious buyers."
>
> **Proposed:** "DDP organises farm stock, batch records, COAs and pricing into
> clear review packs for serious buyers."

One word. "Organises" describes what the system does to what it holds; "turns …
into … for buyers" implies a delivery that has not occurred.

> **Correction, 2026-08-12 — this edit would have changed nothing on any page,
> and where to make it instead.** When written, this pointed at the translation
> key `landingHero1`. That key was rendered by no component: the string existed in
> English and Thai and reached no screen, and the phrase "review packs" appeared 0
> times in the served HTML. Editing it would have produced a green diff and an
> unchanged site — the shape of a copy fix that quietly does not land.
>
> The sentence is authored **per locale** in
> `src/pages/public/localisedBuyerContent.ts` as each entry's `lead`, where the
> German and Czech prerendered pages carry it live and already in the present
> tense. So the concern is real and still unaddressed; only the address was wrong.
> `landingHero1` has since been deleted as dead copy, so this edit must be made to
> the `lead` of every locale entry that renders it, not to a translation key.

**B. The licence claim — assertion to process.**

> **Now:** "Licences are verified, laboratory accreditation is confirmed, and
> documents are checked against the material offered."
>
> **Proposed:** "Our team checks licences and laboratory accreditation, and
> records each document against the material it belongs to."

Says the same thing about the work while attaching it to a person and to a record
that exists.

**The cost is not one line each.** Every public string is pinned by
`publicCopyConstraints.test.ts`, exists in up to four languages, and the Thai is
under minimal-diff rules — existing human Thai is reused by key and never
retyped. Each of these is a multi-language change with a test to update. Worth
knowing before saying yes.

---

## 6. Decisions to record

**6.1 Migration numbering — resolved.** The highest migration on `main` is **65**.
Migration 66 was written on the branch behind the now-closed PR #200 and never
landed, so **66 is free**. The `max_thc_pct` split takes **66**, not 67. If #200
is ever revived its migration renumbers, because it is the one that did not ship.

**6.2 Licences — pick one home.** Either populate `licences` and give it a
writer, or drop it and treat `farmer_documents.document_type = 'licence'` as
canonical. For an inventorying baseline the second is the smaller, truer answer.

**6.3 The pass/fail columns — decide before any screen exposes them.** Either
they are a *reviewer's* recorded judgement, in which case they need attribution
like every other decision in this system, or they are vestigial and should go.
They must not become a place where a threshold is invented.

**6.4 COA data has two homes.** `farmer_documents` carries denormalised lab
columns (`lab_name`, `report_number`, `total_thc`, `total_cbd`, `moisture_pct`,
`test_date`); `document_field_extractions` carries the same facts as attributed,
confidence-bearing rows. Both are populated by different paths. **Name the
canonical one** before extraction starts writing, or the same certificate will
disagree with itself.

---

## 7. Next build steps, in order

1. **Run the extraction once, for real.** Everything merged today is pure and
   tested and has produced nothing. One real document, one row in
   `document_field_extractions`, end to end. Until that happens the honest
   status of the feature is "built, never exercised" — and this project has
   shipped that state before without noticing.
2. **Settle 6.4**, because step 1 writes into whichever answer is chosen.
3. **The inventory spine itself** — three batches across two farms is a
   demonstration, not a baseline. What a supplier can record about stock, and
   what a reviewer can see, is the actual next product surface.
4. **Then** the licence decision (6.2) and the pass/fail decision (6.3), both of
   which are small once 6.4 is settled.

Export verdicts are **out of scope by owner decision, 10 August 2026**. The
system is an inventorying site; `destination_rulesets` stays empty and that is
now a deliberate state rather than a gap.
