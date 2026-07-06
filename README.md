# elderberry-lit-synth

A self-contained **Claude Code skill** that turns a Thermo **Compound Discoverer**
metabolomics Excel export (an elderberry / *Sambucus* study) into a
literature-cited Markdown, CSV, Excel, **and** PDF report.

Claude does the literature research directly — querying **PubMed** and **Europe
PMC** live and writing a cited paragraph per compound — so there is **no
OpenAI/Anthropic API key and no separate program to run**. Heavy runs fan out
across subagents, using your Claude Code subscription tokens.

## What it does

It researches **every named compound** — no ranking, no comparisons, no
statistics of any kind.

1. **Extract** (deterministic) — `extract.mjs` pulls every row that has a Name
   and de-duplicates by **name + formula** (duplicate detections of the same
   molecule become one entry). **No statistics** — no p-value, fold-change, m/z,
   RT, ranking, or comparisons. Emits the unique list plus the full row→unique
   mapping.
2. **Pre-resolve identity + occurrence** (deterministic, no model tokens) —
   `resolve.mjs` looks up each unique compound's PubChem identity (CID,
   InChIKey, clean synonyms) and, for identities it trusts, checks
   LOTUS/Wikidata for documented occurrence, bucketed by taxon. A **formula
   trust-guard** only accepts a PubChem match when the resolved formula agrees
   with the compound's reported formula; otherwise it flags the compound for
   the agent to re-resolve.
3. **Research + classify** (AI-driven) — for each unique compound, Claude
   trusts the pre-resolved identity (re-resolving only if flagged), then uses
   `litesearch.mjs` for fast PubMed/Europe PMC triage and `abstract.mjs` to
   read the actual abstract text of promising hits before relying on them.
   Occurrence is credited by **reasoned judgment over the totality of the
   evidence** — a LOTUS record, an abstract, contextual literature, or sound
   chemical inference — while never fabricating a source. Each compound gets
   two independent labels: **biogenic provenance** (elderberry → other berry →
   other plant → non-plant → unknown, most specific wins) and **detection
   disposition** (native / oxidation-processing artifact / synthetic
   contaminant / foreign / identity-unresolved / undetermined), the latter
   judged from chemistry and literature alone — the agent never sees the raw
   instrument data (m/z, retention time, MS/MS, library-match score).
4. **Cite** — `cite.mjs` resolves every PMID the agent cited to **verbatim**
   bibliographic metadata via PubMed esummary. The model never writes
   authors/year/title/journal itself; any PMID that doesn't resolve is dropped
   rather than shown with guessed details.
5. **Render** — `gen-sample3.mjs` (tier-grouped Markdown), `gen-csv.mjs` (one
   self-contained row per compound), and `gen-xlsx.mjs` (formatted spreadsheet
   with a "How to read" tab) all share one occurrence-tier rule (`tier.mjs`),
   so a plant-tier claim with no citation tagged as supporting occurrence is
   downgraded to "unknown" identically across every format. Then
   `make-pdf.mjs` renders the Markdown to a clickable-link PDF via Chrome.

A run is not resumable: if it's interrupted partway through, it restarts from
the beginning rather than picking up where it left off.

## Install as a skill

Clone (or symlink) this repo into your Claude Code skills directory, then
install the Node dependencies once:

```bash
git clone https://github.com/danielli223/lit-synth-mvp.git \
  ~/.claude/skills/elderberry-lit-synth
cd ~/.claude/skills/elderberry-lit-synth && npm install
```

Then in Claude Code just ask: *"run lit-synth on this elderberry export: /path/to/study.xlsx"*.

A free NCBI API key in `~/.ncbi_api_key` lifts the eutils rate limit from ~3 to
~10 requests/second — recommended for large runs.

## Files

| File | Role |
| --- | --- |
| `SKILL.md` | The skill definition Claude follows (the full procedure + hard rules). |
| `extract.mjs` | Lists every named compound and de-duplicates by name+formula. No statistics. |
| `resolve.mjs` | Deterministic pre-pass (no model tokens): PubChem identity + LOTUS occurrence, with a formula trust-guard. |
| `litesearch.mjs` | Lean PubMed/Europe PMC search — compact `{pmid,title,year,journal}` hits for fast triage. |
| `abstract.mjs` | Fetches the actual abstract text for given PMIDs, so the agent judges from real content, not titles. |
| `cite.mjs` | Resolves PMIDs to verbatim bibliographic metadata (fabrication guard). |
| `tier.mjs` | Shared occurrence-tier rule used by all three renderers, so they can't disagree with each other. |
| `gen-sample3.mjs` | Renders the tier-grouped Markdown report. |
| `gen-csv.mjs` | Renders one self-contained CSV row per compound. |
| `gen-xlsx.mjs` | Renders a formatted Excel workbook with a "How to read" tab. |
| `make-pdf.mjs` | Markdown → styled HTML → PDF (headless Chrome), clickable links. |
| `package.json` | Declares the deps: `xlsx`, `marked`, `exceljs`. |

## Requirements

- Node ≥ 20
- Google Chrome (for PDF rendering, macOS path hardcoded in `make-pdf.mjs`)
- Claude Code (Claude is the research engine — no API key)

## Helper-script usage (standalone)

```bash
# count named / unique / duplicate compounds in an export:
node extract.mjs --xlsx /path/to/study.xlsx --summary

# list every named compound (unique list + row→unique mapping):
node extract.mjs --xlsx /path/to/study.xlsx

# pre-resolve identity + occurrence for every compound (deterministic, free):
node resolve.mjs --in compounds.json --out identities.json

# search PubMed or Europe PMC for a compound:
node litesearch.mjs --db pubmed    --query 'sambunigrin AND (Sambucus OR elderberry)'
node litesearch.mjs --db europepmc --query '"betulalbuside" AND elderberry'

# fetch real abstract text for given PMIDs:
node abstract.mjs --pmids 10854744,27734518

# resolve PMIDs to verbatim bibliographic metadata:
node cite.mjs --pmids 27484408,10854744

# render results to Markdown / CSV / Excel:
node gen-sample3.mjs workflow-output.json report.md
node gen-csv.mjs     workflow-output.json report.csv
node gen-xlsx.mjs    workflow-output.json report.xlsx

# render a finished Markdown report to PDF:
node make-pdf.mjs report.md
```
