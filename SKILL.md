---
name: elderberry-lit-synth
description: Generate a literature-cited report (markdown + PDF + spreadsheet) from a Thermo Compound Discoverer metabolomics Excel export of an elderberry/Sambucus study. It researches EVERY named compound — no ranking, no comparisons, no p-value/fold-change/statistics of any kind. The query step is AI-driven: per compound an agent resolves identity (PubChem), occurrence (LOTUS/Wikidata), and literature (PubMed/Europe PMC), and credits occurrence by reasoned judgment over the totality of that evidence — LOTUS records count on their own, abstracts and reviews are read rather than title-guessed, and sound chemical inference is allowed — while never fabricating a source. It assigns two independent axes — biogenic provenance (elderberry / other berry / other plant / non-plant / source-not-established) and detection disposition (native / oxidation-artifact / synthetic-contaminant / foreign / identity-unresolved / undetermined) — with role-tagged, evidence-grounded citations. Claude is the engine (subagents for scale), so no OpenAI/Anthropic API key is needed. Use when the user asks to analyze an elderberry metabolome xlsx, run lit-synth on an elderberry study, or generate an elderberry literature report.
---

# elderberry-lit-synth

Self-contained skill. Claude is the research engine directly — **no API key, no external LLM program**. It researches **every named compound** in a Compound Discoverer export against the literature. **No statistics anywhere** — no ranking, comparisons, p-value, fold-change, m/z, RT, or composite scores in the logic or the report. Every named compound is researched and reported.

The **query step is AI-driven, not hardcoded**: the agent decides which names to search, composes its own queries, iterates, and — the load-bearing rule — **credits occurrence by reasoned judgment over the totality of the evidence** (LOTUS/database records, abstracts it actually reads, contextual literature, and sound chemical inference), citing every real source it reasoned from. It never fabricates a citation, and it flags when an occurrence rests on inference rather than a direct statement.

## The thin tools (one job each; the agent orchestrates them)

| Tool | Job |
| --- | --- |
| `extract.mjs` | List every named compound; de-duplicate by name+formula. No statistics. |
| `resolve.mjs` | Deterministic pre-pass (no model tokens): PubChem identity (CID/InChIKey/clean synonyms) + LOTUS occurrence (bucketed taxa), compact output. **Formula trust-guard**: only trusts a resolution when the resolved formula matches the given one; otherwise flags `needs_identity` for the agent to redo. Emits `lotus_found` separately. |
| `litesearch.mjs` | Lean literature search (PubMed E-utilities + Europe PMC) → compact `{pmid,title,year,journal}` for fast triage. Uses the NCBI API key if present (`~/.ncbi_api_key`). |
| `abstract.mjs` | Fetch the **actual abstract** for given PMIDs (XML `<AbstractText>`), so the agent can read what a paper reports rather than guess from the title. Abstracts inform judgment — they are evidence, not a mandatory gate. Uses the NCBI key. |
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
   - **Literature:** `litesearch.mjs` for fast triage, then `abstract.mjs` to read the abstract of promising candidates. Read before relying on a paper — but the abstract need not contain a verbatim presence statement for the paper to count (see the occurrence rule).
3. **EVIDENCE-GROUNDED OCCURRENCE (reasoned judgment, not a mechanical gate).** Tag a citation `role:"occurrence"` whenever, weighing the evidence, you reasonably judge the compound occurs in the claimed matrix (elderberry / a berry / a plant). Sufficient evidence is *any* of: a LOTUS/Wikidata occurrence record (counts on its own; the taxon sets the tier); a paper whose abstract names it present; a paper/review whose context supports occurrence even without the exact phrase; or sound chemical reasoning from cited facts (e.g. it is the known glycoside of an aglycone documented in the plant). Don't blindly trust a bare title, don't confuse a *different* compound (a C12 vs C18 amide; an 18:1 vs 18:2 acyl chain; the class but not this member) for this one, and never fabricate — but you do **not** need an abstract that literally states presence. Record how it's supported in the citation note / `occurrence_evidence_type` (lotus / abstract / contextual / inference) and be honest when it rests on inference.
4. **Asymmetric search budget.** Stop early once you have a confirmed occurrence at the most specific applicable tier. If you have nothing, keep digging (other synonyms, parent class, the other database, LOTUS) up to ~10 searches. A compound that yields no documented occurrence is a valid, honest result — still cited by its PubChem CID (and LOTUS QID if any). Never pad; never fabricate.
5. **Two-axis verdict** (see below) + **cite-everything** (3 anchor types, every real source reasoned from), emitting only `{type,id,role,note}` per citation — metadata is filled verbatim by `cite.mjs` later.
6. **Persist** the result (`{uid,name,formula,provenance,disposition,occurrence_basis,what_it_is,where_reported,assessment,citations,...}`).

### The two-axis rule

Assign two **independent** labels:

**A) Biogenic provenance — where the molecule is documented to occur in nature** (most specific plant tier with occurrence evidence wins): `elderberry` > `other_berry` > `other_plant` > `non_plant` (only with *positive* non-plant evidence — a confirmed synthetic reagent/drug/agrochemical, or a strictly mammal/microbe/fungal metabolite; absence from LOTUS is NOT such evidence) > `unknown` (identity unresolved, or a plausibly-biogenic class simply not curated — **default here when in doubt, not `non_plant`**).

**Occurrence invariant (enforced by the renderers via the shared `tier.mjs`):** a plant provenance MUST be backed by a `role:"occurrence"` citation OR a non-empty `occurrence_basis`; otherwise the renderer downgrades it to "Source not established". (A LOTUS occurrence is carried as a `role:"occurrence"` citation, so it satisfies this.) **This guards the *tier* only — it checks the role *tag*, not the quality of the evidence behind it.** Whether an occurrence tag is well-judged (grounded in a real LOTUS record, abstract, contextual literature, or sound inference — never fabricated) is the agent's discipline plus the optional verification pass; it is **not** mechanically enforced at render time. Run the verification pass when correctness matters.

**B) Detection disposition — is THIS peak a genuine elderberry constituent?** A reasoned chemical judgment, **independent of provenance** (a compound can be `other_plant` by provenance yet `native_plausible` in this sample). The agent **never sees the raw machine data** — no m/z, retention time, MS/MS, mass error, or library-match score — so it can never claim the *instrument's identification* is wrong; it judges only whether the *named* compound is a credible elderberry constituent. Pick exactly one:

- `native_plausible` — plausibly a genuine elderberry metabolite (it belongs).
- `oxidation_processing` — real, but a known oxidation/processing product of a native precursor (e.g. a trans-isomer of a native cis fatty acid; a lipid hydroperoxide/oxylipin) more likely formed during drying/extraction than in the live plant. Use **only** with a positive chemical reason.
- `synthetic_contaminant` — has a hard industrial/synthetic identity (plasticizer, slip agent like oleamide, preservative, lab reagent) that marks the peak as exogenous carry-over. Use **only** when the identity itself is the evidence.
- `foreign` — **shouldn't be in an elderberry sample**, but the mechanism can't be pinned to oxidation or contaminant. This is the honest default for "doesn't belong" when the basis is biogeographic (a signature compound of an unrelated taxon, no elderberry/berry/relevant-plant occurrence). The agent does **not** assert the ID is wrong (it has no spectra) — only that the named compound is not a credible native constituent. NOTE: a checkable name↔formula mismatch on an *otherwise-native* compound is **not** `foreign` — label it `native_plausible` and note the formula error in the assessment.
- `identity_unresolved` — the name/formula don't resolve to a real compound (PubChem formula mismatch, garbled or generic name), so disposition can't be judged.
- `undetermined` — a plausible plant compound that genuinely can't be placed as belonging vs. not (documented in other plants/berries but not elderberry, evidence split). Distinct from `foreign`, which is a *confident* "doesn't belong" with an unclear mechanism.

## Step 4 — Render

```bash
node gen-csv.mjs   results.json out.csv     # self-contained CSV (one row/compound)
node gen-xlsx.mjs  results.json out.xlsx    # formatted spreadsheet + "How to read" tab
node gen-sample3.mjs results.json out.md && node make-pdf.mjs out.md out.pdf
```
Reports group by provenance tier and enforce the occurrence invariant (a plant tier with no surviving occurrence citation is shown as "Source not established"). Citation metadata is pulled verbatim from PubMed esummary by `cite.mjs` at render time.

## Hard rules

- **Evidence-grounded occurrence (reasoned judgment).** Credit occurrence from the totality of evidence — a LOTUS record, an abstract you read, contextual literature, or sound inference — not from a bare title and never from a fabricated source. An abstract need not literally state presence; a reasoned judgment grounded in real sources is enough. Flag when it rests on inference. (Agent discipline + the optional verification pass — the renderers do **not** check it.)
- **Cite only PMIDs actually retrieved this run; never invent one.** Metadata comes verbatim from `cite.mjs`/esummary — the model never writes authors/year/title/journal.
- **LOTUS/Wikidata via structured SPARQL only — never WebFetch** (it hallucinates QID↔taxon).
- **Research every named compound — never exclude one.** No statistics decide inclusion.
- **Two axes only, and don't over-claim.** Reserve `non_plant` for positive non-plant evidence; default to `unknown`/`undetermined` when the evidence is silent.
- **Honesty over polish.** "No documented elderberry occurrence found; the identity rests on the spectral match alone" is better than inventing a source. Reasoned inference from real sources is allowed — fabrication never is.
