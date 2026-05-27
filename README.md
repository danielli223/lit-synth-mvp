# lit-synth-mvp

A command-line tool for metabolomics researchers. It takes a **Thermo Compound
Discoverer** Excel export, filters it down to the compounds that matter for a
specific research question, checks each candidate against PubMed to judge how
plausible it is in the researcher's actual sample, lets you review and approve
a shortlist in the terminal, and then synthesizes a publication-ready
literature paragraph for each approved compound — citing **only real papers**
retrieved live from PubMed and Semantic Scholar.

The output is a single markdown report saved to disk.

## Why citations are trustworthy

Every paper returned by every tool call is logged into id sets during the
agent run. After the model produces its synthesis, a **deterministic**
post-processing step (`src/validate-citations.ts`) drops any citation whose
id was not actually retrieved and appends a caveat noting how many were
removed. Hallucinated citations cannot reach the report. This is unit-tested.

## Pipeline

| Stage | What happens |
| --- | --- |
| Parse | Read the `Compounds` sheet; keep only named features; discover all `Log2 Fold Change:` comparisons. |
| Agent 1 (deterministic) | Per compound: max \|log2FC\| across **your selected** comparisons and its adj. p-value. Composite score = `|log2FC| * -log10(adjP + 1e-300)`. Filter (adj.p < 0.05, \|log2FC\| > 1), sort, take top N. |
| Agent 2 (`gpt-5.4-mini`) | Extracts sample keywords from your context, runs a PubMed esearch per compound (`"compound"[tiab] AND (Genus OR common-name)`), then one batched call classifies each candidate as `known` / `plausible` / `unknown` / `unlikely` for the sample. Final ordering: plausibility tier first, then composite statistical score. Advisory only — you can override. |
| Agent 3 (`gpt-5.4`, tools) | Per compound: searches PubMed + Semantic Scholar (≤10 tool calls), writes a 100–200 word cited paragraph. |
| Validate | Deterministic citation validation, then markdown export. |

Model choice follows the spec: smallest current frontier model for cheap batch
flagging, strongest current model for tool-using synthesis (GPT-5.x family;
GPT-5.4 selected). See `src/llm/models.ts`.

All LLM calls go through the provider abstraction in `src/llm/client.ts`.
Nothing under `src/agents/` imports the OpenAI SDK directly.

## Setup

```bash
npm install
cp .env.example .env      # then set OPENAI_API_KEY
```

`OPENAI_API_KEY` is required. PubMed and Semantic Scholar need no key at low
volume (optional `NCBI_API_KEY` / `SEMANTIC_SCHOLAR_API_KEY` raise rate limits).

## Usage

```bash
# Dev (no build step):
npm run dev -- analyze test-data/sample.xlsx

# After building:
npm run build
node dist/index.js analyze path/to/study.xlsx

# Options:
lit-synth analyze path/to/study.xlsx
lit-synth analyze path/to/study.xlsx --output my-report.md --max-candidates 50 --max-synthesize 15
```

| Option | Default | Meaning |
| --- | --- | --- |
| `-o, --output <file>` | `report.md` | Report output path |
| `--max-candidates <n>` | `40` | Ranked candidates to screen/display |
| `--max-synthesize <n>` | `20` | Hard cap on compounds synthesized (≤ 20) |
| `--mock` | off | Force the offline mock LLM (no OpenAI key needed) |
| `--non-interactive` | off | Skip all prompts; use the flags below |
| `--context <text>` | — | Sample context (non-interactive) |
| `--comparisons <csv>` | — | Comparison numbers, e.g. `1,3` (non-interactive) |
| `--select <spec>` | `default` | `default` (= all `known` + `plausible`) or a range spec like `1-5,8` (non-interactive). `clean` is accepted as an alias for `default`. |

### Run with no OpenAI key (offline)

If `OPENAI_API_KEY` is unset (or `--mock` / `LIT_SYNTH_MOCK=1`), an offline
mock LLM is used: deterministic keyword-based plausibility classification and a
synthesis step that **still calls the real PubMed / Semantic Scholar tools**,
so the live retrieval + deterministic citation-validation path is fully
exercised. Example full headless run:

```bash
node dist/index.js analyze test-data/sample.xlsx \
  --mock --non-interactive \
  --context "Wastewater/biofilm environmental microbiome" \
  --comparisons 1,2 --select 1-3 \
  --max-candidates 12 --max-synthesize 3 --output report.md
```

PubMed/Semantic Scholar enforce anonymous rate limits; set `NCBI_API_KEY` /
`SEMANTIC_SCHOLAR_API_KEY` to raise them. The tools back off and fail
gracefully (a sparse/failed search just yields fewer validated citations).

### What you'll be asked

1. **Sample context** — opens `$EDITOR` (falls back to an inline prompt).
2. **Comparisons** — numbered list; pick 1–3 (e.g. `1,3,5`).
3. **Candidate selection** — after the colored table + reasons, enter
   numbers/ranges (`1-5,8,12-15`). Empty input = all `KNOWN` + `PLAUSIBLE`. Then confirm.

## Testing

```bash
npm test
```

Covers citation validation (the non-negotiable part), deterministic ranking,
the list/range selection parser, and Excel parsing against
`test-data/sample.xlsx` (those tests auto-skip if the sample file is absent).

## Scope

In: single Compound Discoverer `.xlsx`, the named compounds only, ≤20-compound
synthesis. Out: web UI, persistence, accounts, other tool exports, unnamed
features, re-querying ChemSpider, multi-file batches.
