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

It researches **every named compound** — no ranking, no comparisons, no
statistics of any kind.

1. **Extract** (deterministic) — `extract.mjs` pulls every row that has a Name
   and de-duplicates by **name + formula** (duplicate detections of the same
   molecule become one entry). **No statistics** — no p-value, fold-change, m/z,
   RT, ranking, or comparisons. Emits the unique list plus the full row→unique
   mapping.
2. **Research + write** — for each unique compound, Claude queries PubMed for
   elderberry/*Sambucus* → other berries → other plants context, labels the most
   specific literature tier the compound appears in (**elderberry → other berries
   → other plants → none**, more specific wins), and writes a 100–200 word
   reasoned paragraph **citing only papers it actually retrieved**. Duplicate
   detections are mapped back, not re-researched. Then it renders a clickable-link
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
| `extract.mjs` | Lists every named compound and de-duplicates by name+formula. No statistics. Standalone (resolves `xlsx` from this dir). |
| `make-pdf.mjs` | Markdown → styled HTML → PDF (headless Chrome), clickable PMID links. Needs `marked`. |
| `package.json` | Declares the two deps: `xlsx`, `marked`. |

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

# render a finished report to PDF:
node make-pdf.mjs /path/to/elderberry-report.md
```
