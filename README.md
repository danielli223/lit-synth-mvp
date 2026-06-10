# elderberry-lit-synth

A self-contained **Claude Code skill** that turns a Thermo **Compound Discoverer**
metabolomics Excel export (an elderberry / *Sambucus* study) into a
literature-cited Markdown **and** PDF report.

Claude does the literature research directly — querying **PubMed** live and
writing a cited paragraph per compound — so there is **no OpenAI/Anthropic API
key and no separate program to run**. Heavy runs fan out across subagents, using
your Claude Code subscription tokens.

> This repo replaces an earlier TypeScript CLI (`lit-synth-mvp`). That program
> required an OpenAI key and a build step; everything it did is now this skill.
> The old code remains in git history if you ever need it.

## What it does

Two stages only:

1. **Rank** (deterministic) — `rank.mjs` filters compounds (`adj.p < 0.05` and
   `|log2 FC| > 1`), scores them by `|log2 FC| × −log10(adj.p)`, and sorts.
   **No contaminant filtering, no plausibility tiers** — every compound that
   passes the statistical filter is researched and reported.
2. **Research + write** — for each compound, Claude queries PubMed for
   elderberry/*Sambucus*/plant context and writes a 100–200 word paragraph,
   **citing only papers it actually retrieved**. Then it renders a clickable-link
   PDF via `make-pdf.mjs`.

## Install as a skill

Clone (or symlink) this repo into your Claude Code skills directory, then
install the two Node dependencies once:

```bash
git clone https://github.com/danielli223/lit-synth-mvp.git \
  ~/.claude/skills/elderberry-lit-synth
cd ~/.claude/skills/elderberry-lit-synth && npm install
```

Then in Claude Code just ask: *"run lit-synth on this elderberry export: /path/to/study.xlsx"*.

## Files

| File | Role |
| --- | --- |
| `SKILL.md` | The skill definition Claude follows (the full procedure + hard rules). |
| `rank.mjs` | Deterministic ranking of the Compound Discoverer export. Standalone (resolves `xlsx` from this dir). |
| `make-pdf.mjs` | Markdown → styled HTML → PDF (headless Chrome), clickable PMID links. Needs `marked`. |
| `package.json` | Declares the two deps: `xlsx`, `marked`. |

## Requirements

- Node ≥ 20
- Google Chrome (for PDF rendering, macOS path hardcoded in `make-pdf.mjs`)
- Claude Code (Claude is the research engine — no API key)

## Helper-script usage (standalone)

```bash
# list available comparisons in an export:
node rank.mjs --xlsx /path/to/study.xlsx --list

# rank with chosen comparisons, take top 5:
node rank.mjs --xlsx /path/to/study.xlsx --comparisons 3,9,15 --top 5

# render a finished report to PDF:
node make-pdf.mjs /path/to/elderberry-report.md
```
