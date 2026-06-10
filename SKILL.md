---
name: elderberry-lit-synth
description: Generate a literature-cited markdown + PDF report from a Thermo Compound Discoverer metabolomics Excel export of an elderberry/Sambucus study. Two steps only — (1) deterministically rank compounds by composite of p-value and |log2 fold change|, (2) for each compound, research how plausible it is to occur in elderberry via live PubMed queries and write a cited paragraph. No contaminant filtering, no plausibility-tier classification — every compound that survives the statistical filter gets researched and reported. Claude does the research directly (subagents for scale), so no OpenAI/Anthropic API key is needed. Use when the user asks to analyze an elderberry metabolome xlsx, run lit-synth on an elderberry study, or generate an elderberry literature report.
---

# elderberry-lit-synth

Self-contained skill. Claude acts as the LLM directly — **no API key, no external program**. Two stages only: deterministic statistical ranking → per-compound elderberry-plausibility research. **No contaminant-classification step.** All helper scripts and dependencies live in this skill's own directory.

## Setup (first run only)

The helper scripts need `xlsx` (ranking) and `marked` (PDF). From **this skill's directory**, if `node_modules` is missing, install once:

```bash
cd "<this skill's directory>" && npm install
```

`<this skill's directory>` is the base directory printed when this skill loads (e.g. `~/.claude/skills/elderberry-lit-synth`). Run all helper-script commands below from there so `xlsx`/`marked` resolve.

## Inputs

Ask the user if missing:
- `xlsx` — absolute path to the Compound Discoverer export
- `comparisons` — 1–3 comparison numbers (e.g. `3,9,15`); `rank.mjs --list` shows what's available
- `top` — how many compounds to research (default 5; this can be the full filtered set for a complete report)
- `output` — report path (default `<xlsx-dir>/elderberry-report.md`)

## Step 1 — Rank

```bash
# list available comparisons:
node rank.mjs --xlsx <path> --list
# then rank with chosen comparison numbers:
node rank.mjs --xlsx <path> --comparisons 3,9,15 --top 5
```

The script:
- filters `adj.p < 0.05` AND `|log2 FC| > 1`
- composite score = `|log2 FC| × −log10(adj.p + 1e-300)`
- sorts descending, takes top N

Output is JSON: `{source, selected, total_passed_filter, top: [{name, formula, mz, rt, bestComparison, absLog2Fc, adjP, compositeScore}]}`.

## Step 2 — Research each compound in elderberry

For every compound in `top`, query PubMed with elderberry-targeted terms (sequential, ~0.4s spacing to dodge HTTP 429):

```bash
NAME=<urlencoded compound name>
curl -s "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=%22${NAME}%22%5Btiab%5D+AND+(elderberry+OR+Sambucus+OR+berry+OR+fruit+OR+plant)&retmax=6&retmode=json"
```

Then `esummary` for the returned PMIDs to get title / authors / year / journal.

If a search returns nothing, broaden by dropping the elderberry term but keep `plant OR fruit OR berry`. If broadened search still returns nothing, note "no supporting literature retrieved" in that compound's paragraph — do **not** demote, exclude, or relabel the compound. It still belongs in the report.

If a search returns only papers from outside the plant/biology domain (e.g. mammalian pharmacology, industrial chemistry), say so honestly in the paragraph. The user wants research findings, not a verdict.

### Scaling to many compounds (subagent fan-out)

Researching more than ~8 compounds inline bloats this conversation's context. For larger runs (dozens to the full filtered set, e.g. 900+), **dispatch parallel research subagents** instead of doing every compound in the main thread:

1. Split the ranked `top` list into batches (~5–10 compounds each).
2. For each batch, spawn a subagent (Agent/Task tool) whose task is: run the Step-2 PubMed queries for its compounds and return, **per compound**, a structured result — `{name, paragraph, citations: [{pmid, authors, year, title, journal}]}` — where `citations` lists **only PMIDs the subagent actually retrieved** in its own curl calls.
3. Run batches concurrently (the runtime caps concurrency; just dispatch them).
4. The main thread collects results, preserves the Step-1 composite-score order, and assembles the report.

Each subagent follows the same per-compound recipe and the same hard rules below. This keeps the main context small while scaling to the whole dataset on your subscription tokens — no API key.

## Step 3 — Write the report (markdown)

Save markdown to the output path with this structure:

```
# Elderberry Metabolomics Literature Synthesis

Source: <xlsx path>
Comparisons used: <display names>
Generated: <ISO date>

## Summary

Top <N> differentially abundant named compounds, ranked by composite of adjusted p-value and |log2 fold change|. For each, Claude queried PubMed for elderberry/Sambucus context and wrote a 100–200 word plausibility paragraph grounded in retrieved citations.

## Results

### 1. <name>

Formula: ... | m/z: ... | RT: ... | |log2FC|: ... | adj.p: ... | composite: ...

<100–200 word paragraph: what kind of metabolite this is, what the retrieved literature says about its occurrence in elderberry/Sambucus or related plant matrices, honest assessment of how plausible it is in this sample. If retrieved literature is non-plant or absent, state that plainly.>

Citations:
1. <Authors> (<Year>). <Title>. <Journal>. [https://pubmed.ncbi.nlm.nih.gov/<PMID>/](https://pubmed.ncbi.nlm.nih.gov/<PMID>/)

---

### 2. ...

...
```

## Step 4 — Render to PDF (clickable links)

After the markdown is saved, **always** render a PDF alongside it so the deliverable can be sent directly:

```bash
node make-pdf.mjs <markdown-path>
```

This writes `<same-basename>.pdf` next to the markdown. The script uses the user's installed Chrome (`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`) in headless mode to convert markdown → styled HTML → PDF; PMID links render as clickable hyperlinks in the PDF.

Return both files (`.md` source and `.pdf` deliverable) to the user. The PDF is what they send to collaborators; the markdown is the editable source.

## Hard rules

- **Cite only PMIDs actually returned by the PubMed calls in this run.** Never invent PMIDs from training memory. If a paragraph would need a citation you didn't retrieve, rewrite it without that claim. When using subagents, a citation is valid only if that subagent retrieved its PMID.
- **Do not drop, demote, or re-rank compounds based on their identity.** The composite-score ordering from Step 1 is final. A paragraph may honestly state "this is commonly seen as a lab contaminant in the literature" if that's what the search turned up — that's research, not filtering.
- **No plausibility tier labels** (no KNOWN / PLAUSIBLE / UNKNOWN / UNLIKELY tags).
- **Honesty over polish.** A paragraph saying "no elderberry-specific literature was retrieved; the compound's identity rests on the Compound Discoverer spectral match alone" is better than padding with tangentially related citations.
