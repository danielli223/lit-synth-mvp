---
name: elderberry-lit-synth
description: Generate a literature-cited report (markdown + PDF + spreadsheet) from a Thermo Compound Discoverer metabolomics Excel export of an elderberry/Sambucus study. It researches EVERY named compound — no ranking, no comparisons, no p-value/fold-change/statistics of any kind. The query step is AI-driven: per compound an agent resolves identity (PubChem), occurrence (LOTUS/Wikidata), and literature (PubMed/Europe PMC), and — crucially — reads the actual ABSTRACT before crediting any paper with occurrence (never a title-guess). It assigns two independent axes — biogenic provenance (elderberry / other berry / other plant / non-plant / source-not-established) and detection disposition (native / oxidation-artifact / synthetic-contaminant / misannotation / identity-unresolved / undetermined) — with role-tagged, abstract-grounded citations. Claude is the engine (subagents for scale), so no OpenAI/Anthropic API key is needed. Use when the user asks to analyze an elderberry metabolome xlsx, run lit-synth on an elderberry study, or generate an elderberry literature report.
---

# elderberry-lit-synth

Self-contained skill. Claude is the research engine directly — **no API key, no external LLM program**. It researches **every named compound** in a Compound Discoverer export against the literature. **No statistics anywhere** — no ranking, comparisons, p-value, fold-change, m/z, RT, or composite scores in the logic or the report. Every named compound is researched and reported.

The **query step is AI-driven, not hardcoded**: the agent decides which names to search, composes its own queries, iterates, and — the load-bearing rule — **reads the paper's abstract before tagging it as occurrence evidence**, so an occurrence claim is grounded in what the abstract actually says, not in the title.

## The thin tools (one job each; the agent orchestrates them)

| Tool | Job |
| --- | --- |
| `extract.mjs` | List every named compound; de-duplicate by name+formula. No statistics. |
| `resolve.mjs` | Deterministic pre-pass (no model tokens): PubChem identity (CID/InChIKey/clean synonyms) + LOTUS occurrence (bucketed taxa), compact output. **Formula trust-guard**: only trusts a resolution when the resolved formula matches the given one; otherwise flags `needs_identity` for the agent to redo. Emits `lotus_found` separately. |
| `litesearch.mjs` | Lean literature search (PubMed E-utilities + Europe PMC) → compact `{pmid,title,year,journal}` for fast triage. Uses the NCBI API key if present (`~/.ncbi_api_key`). |
| `abstract.mjs` | Fetch the **actual abstract** for given PMIDs (XML `<AbstractText>`), so occurrence is judged from the abstract, not the title. Uses the NCBI key. |
| `cite.mjs` | Resolve PMIDs to **verbatim** bibliographic metadata via PubMed esummary. The model never writes authors/year/title/journal; any PMID that doesn't resolve is dropped (fabrication guard). |
| `gen-sample3.mjs` / `gen-csv.mjs` / `gen-xlsx.mjs` | Render the report — markdown (tier-grouped), CSV (one self-contained row per compound), and formatted xlsx (wrap, frozen header, "How to read" tab). All enforce the occurrence invariant. |
| `make-pdf.mjs` | Markdown → styled PDF (clickable links). |

LOTUS/Wikidata is queried **only** through the structured SPARQL endpoint (`query.wikidata.org/sparql`, selecting taxon *names*). **Never** WebFetch a Wikidata page — that hallucinates the QID↔taxon mapping.

## Setup (first run only)

From this skill's directory, install deps once: `npm install` (gets `xlsx`, `marked`, `exceljs`). A free **NCBI API key** in `~/.ncbi_api_key` lifts the eutils rate limit (3 → ~10 req/s) — recommended for large runs and required if you fan out across many agents on one IP.

## Inputs

Ask the user if missing: `xlsx` (absolute path to the export) and `output` (report path). There is **no comparison or ranking choice** — every named compound is researched.

## Step 1 — Extract every named compound

```bash
node extract.mjs --xlsx <path> --summary   # counts
node extract.mjs --xlsx <path>             # full JSON (unique list + row->unique map)
```
Keeps every row with a Name; de-duplicates by **name + formula** (a compound detected as several features is the same molecule — only the representative is researched). Save the JSON for the duplicate map.

## Step 2 — Pre-resolve identity + occurrence (deterministic, free)

```bash
node resolve.mjs --in compounds.json --out identities.json
```
Per compound this resolves PubChem identity + LOTUS occurrence and emits compact blocks with two flags: `needs_identity` (the formula trust-guard didn't trust the deterministic match → the agent must re-resolve) and `lotus_found` (a curated occurrence record exists). This offloads the rote lookups so the agent spends tokens only on judgment.

## Step 3 — Research each UNIQUE compound (AI-driven; subagents for scale)

Dispatch **one research subagent per compound, in parallel** (Sonnet is the cost-effective default; the agent reads abstracts, so the judgment is grounded). Each subagent, for its compound:

1. **Identity.** If `needs_identity` is false, trust the pre-resolved CID/InChIKey/clean names. If true, re-resolve via PubChem (try name variants; require the resolved formula to match the given one).
2. **Occurrence — two evidence streams:**
   - **LOTUS** (`lotus_found`/SPARQL): structured occurrence — which organisms the compound is documented in. A LOTUS taxon is occurrence-grade on its own.
   - **Literature:** `litesearch.mjs` for fast title triage, then **`abstract.mjs` to read the abstract of any candidate before crediting it.**
3. **ABSTRACT-GROUNDED OCCURRENCE (hard rule).** A paper is tagged `role:"occurrence"` **only if its abstract names this compound (or an unambiguous synonym) present in the claimed matrix** (elderberry / a berry / a plant). If the abstract names a *different* compound (e.g. a C12 amide vs this C18 amide; an 18:1 vs 18:2 acyl chain; the class but not this member) or is silent, it is `role:"context"`, not occurrence. **Never** credit occurrence from a title alone.
4. **Asymmetric search budget.** Stop early once you have an abstract-confirmed occurrence at the most specific applicable tier. If you have nothing, keep digging (other synonyms, parent class, the other database) up to ~10 searches. A compound that yields no confirmed occurrence is a valid, honest result — still cited by its PubChem CID (and LOTUS QID if any). Never pad; never fabricate.
5. **Two-axis verdict** (see below) + **cite-everything** (3 anchor types, abstract-grounded), emitting only `{type,id,role,note}` per citation — metadata is filled verbatim by `cite.mjs` later.
6. **Persist** the result (`{uid,name,formula,provenance,disposition,occurrence_basis,what_it_is,where_reported,assessment,citations,...}`).

### The two-axis rule

Assign two **independent** labels:

**A) Biogenic provenance — where the molecule is documented to occur in nature** (most specific plant tier with occurrence evidence wins): `elderberry` > `other_berry` > `other_plant` > `non_plant` (only with *positive* non-plant evidence — a confirmed synthetic reagent/drug/agrochemical, or a strictly mammal/microbe/fungal metabolite; absence from LOTUS is NOT such evidence) > `unknown` (identity unresolved, or a plausibly-biogenic class simply not curated — **default here when in doubt, not `non_plant`**).

**Occurrence invariant (enforced by the renderers via the shared `tier.mjs`):** a plant provenance MUST be backed by a `role:"occurrence"` citation OR a non-empty `occurrence_basis`; otherwise the renderer downgrades it to "Source not established". (A LOTUS occurrence is carried as a `role:"occurrence"` citation, so it satisfies this.) **This guards the *tier* only — it checks the role *tag*, not whether an abstract was actually read.** Abstract-grounding of that tag (the hard rule below) is the agent's discipline plus the optional abstract-verification pass; it is **not** mechanically enforced at render time, and a subagent that mis-tags `occurrence` from a title would pass the renderer. Run the verification pass when correctness matters.

**B) Detection disposition — what THIS detection most likely is:** `native_plausible` · `oxidation_processing` · `synthetic_contaminant` · `misannotation` · `identity_unresolved` · `undetermined`. This is a reasoned chemical judgment (the agent never sees raw machine data), independent of provenance — a compound can be `other_plant` by provenance yet `native_plausible` in this sample.

## Step 4 — Render

```bash
node gen-csv.mjs   results.json out.csv     # self-contained CSV (one row/compound)
node gen-xlsx.mjs  results.json out.xlsx    # formatted spreadsheet + "How to read" tab
node gen-sample3.mjs results.json out.md && node make-pdf.mjs out.md out.pdf
```
Reports group by provenance tier and enforce the occurrence invariant (a plant tier with no surviving occurrence citation is shown as "Source not established"). Citation metadata is pulled verbatim from PubMed esummary by `cite.mjs` at render time.

## Hard rules

- **Abstract-grounded occurrence.** Never tag a paper `occurrence` without reading its abstract and confirming this compound is named present in that matrix. A title match is triage, not evidence. (This is agent discipline + the optional abstract-verification pass — the renderers do **not** check it.)
- **Cite only PMIDs actually retrieved this run; never invent one.** Metadata comes verbatim from `cite.mjs`/esummary — the model never writes authors/year/title/journal.
- **LOTUS/Wikidata via structured SPARQL only — never WebFetch** (it hallucinates QID↔taxon).
- **Research every named compound — never exclude one.** No statistics decide inclusion.
- **Two axes only, and don't over-claim.** Reserve `non_plant` for positive non-plant evidence; default to `unknown`/`undetermined` when the evidence is silent.
- **Honesty over polish.** "No abstract-confirmed elderberry occurrence; the identity rests on the spectral match alone" is better than padding with a paper whose abstract doesn't name the compound.
