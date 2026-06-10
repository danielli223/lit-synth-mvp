---
name: elderberry-lit-synth
description: Generate a literature-cited markdown + PDF report from a Thermo Compound Discoverer metabolomics Excel export of an elderberry/Sambucus study. It researches EVERY named compound — no ranking, no comparisons, no p-value/fold-change/statistics of any kind. For each unique compound it queries PubMed live, labels the most specific literature tier it appears in (elderberry > other berries > other plants > none), and writes a cited reasoned paragraph on whether it plausibly occurs in elderberry. Duplicate detections of the same compound are mapped back, not re-researched. Claude does the research directly (subagents for scale), so no OpenAI/Anthropic API key is needed. Use when the user asks to analyze an elderberry metabolome xlsx, run lit-synth on an elderberry study, or generate an elderberry literature report.
---

# elderberry-lit-synth

Self-contained skill. Claude acts as the LLM directly — **no API key, no external program**. It researches **every named compound** in a Compound Discoverer export against the literature. **No statistics anywhere** — no ranking, no comparisons, no p-value, fold-change, m/z, RT, or composite scores in the logic or the report. Every named compound is researched and reported.

## Setup (first run only)

The helper scripts need `xlsx` (extraction) and `marked` (PDF). From **this skill's directory**, if `node_modules` is missing, install once:

```bash
cd "<this skill's directory>" && npm install
```

`<this skill's directory>` is the base directory printed when this skill loads (e.g. `~/.claude/skills/elderberry-lit-synth`). Run all helper-script commands below from there so `xlsx`/`marked` resolve.

## Inputs

Ask the user if missing:
- `xlsx` — absolute path to the Compound Discoverer export
- `output` — report path (default `<xlsx-dir>/elderberry-report.md`)

There is **no comparison or ranking choice to make** — every named compound is researched.

## Step 1 — Extract every named compound

```bash
node extract.mjs --xlsx <path> --summary   # counts: total named rows, unique, redundant
node extract.mjs --xlsx <path>             # full JSON
```

The script:
- keeps **every row that has a Name** — no statistics, no filtering, no ranking, no comparisons
- de-duplicates by **name + formula**: a compound detected as several features (different retention times / adducts) is the *same molecule*, so only the **representative** (first occurrence) is researched
- emits the unique compound list **and** the full row→unique mapping for join-back

Output JSON: `{source, total_named_rows, unique_count, redundant_rows, unique:[{uid, name, formula, feature_count, member_feature_ids}], rows:[{feature_id, name, formula, uid, representative}]}`.

## Step 2 — Research each UNIQUE compound

Research only the `unique` compounds (researching a duplicate gives an identical literature answer). For each, query PubMed tiered Title/Abstract searches, most specific first (~0.4s spacing to dodge HTTP 429; URL-encode the name):

```bash
NAME=<urlencoded compound name>
# elderberry tier:
curl -s "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&retmax=6&term=%22${NAME}%22%5Btiab%5D+AND+(Sambucus+OR+elderberry)"
# other-berries tier:
curl -s "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&retmax=6&term=%22${NAME}%22%5Btiab%5D+AND+(blueberry+OR+blackcurrant+OR+cranberry+OR+grape+OR+raspberry+OR+bilberry+OR+strawberry+OR+blackberry+OR+berry)"
# other-plants tier:
curl -s "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&retmax=6&term=%22${NAME}%22%5Btiab%5D+AND+(plant+OR+fruit+OR+leaf+OR+phytochemical+OR+phytochemistry+OR+botanical)"
```

`esummary` the returned PMIDs for title / authors / year / journal, then **judge relevance yourself** — beware false friends ("elder" matching an author surname or "elderly"; "Sambucus nigra agglutinin / SNA" used merely as a lab reagent; a berry word in an unrelated context). A paper only counts if it genuinely reports **this** compound in that matrix.

If nothing relevant is retrieved at any tier, say "no supporting literature retrieved" and rest the assessment on chemical reasoning — do **not** exclude the compound. It still belongs in the report.

### Scaling to many compounds (subagent fan-out)

Researching more than ~8 compounds inline bloats this conversation's context. For larger runs (the full unique set, e.g. hundreds), **dispatch parallel research subagents**:

1. Split the `unique` list into batches (~8–12 compounds each).
2. Each subagent runs the Step-2 tiered searches for its compounds and returns, per compound, a structured result — `{uid, name, formula, evidenceTier, paragraph, citations:[{pmid, authors, year, title, journal}]}` — where `evidenceTier` is the most specific tier (`elderberry` | `berries` | `plants` | `none`) with a genuinely-relevant retrieved paper, and `citations` lists **only PMIDs that subagent actually retrieved**.
3. Have each subagent space its PubMed calls (~0.4s) and retry on HTTP 429, so the shared rate limit holds.
4. The main thread collects results and assembles the report.

This keeps the main context small and runs on your subscription tokens — no API key.

## Step 3 — Map duplicates back

Using the `rows` mapping from Step 1, every named feature is covered:
- a **representative** row carries its compound's full researched entry;
- a **redundant** row is the same molecule re-detected — mark it redundant and point it to its compound's `uid`. **Do not re-research it.**

## Step 4 — Write the report (markdown)

Save markdown to the output path with this structure. **No statistics** — identity (name + formula) and literature only:

```
# Elderberry Metabolomics Literature Synthesis

Source: <xlsx path>
Generated: <ISO date>
Coverage: <total_named_rows> named features → <unique_count> unique compounds researched (<redundant_rows> duplicate detections mapped back).

## Results

### 1. <name>

**Literature evidence: <Elderberry (Sambucus) | Other berries | Other plants | None retrieved>**

Formula: <formula>

<reasoning, 100–200 words: a brief description of what kind of compound this is, what the retrieved literature actually says about its occurrence in elderberry/Sambucus, other berries, or other plant matrices, and a reasoned argument for whether it may plausibly occur in elderberry. If retrieved literature is non-plant or absent, state that plainly.>

Citations:
1. <Authors> (<Year>). <Title>. <Journal>. [https://pubmed.ncbi.nlm.nih.gov/<PMID>/](https://pubmed.ncbi.nlm.nih.gov/<PMID>/)

---

### 2. ...

## Duplicate detections

These named features are repeat detections of a compound already reported above; they were mapped back, not re-researched:

- feature <id> "<name>" → see compound #<n> (<name>)
```

### Literature-evidence label — most specific tier with retrieved support

Pick the **single most specific tier** that has at least one actually-retrieved supporting paper (more specific wins):

1. **Elderberry (Sambucus)** — a retrieved paper reports the compound in elderberry / *Sambucus*. Use this even when it's also reported in other berries and plants.
2. **Other berries** — *not* found in elderberry, but a retrieved paper reports it in another berry (blueberry, blackcurrant, cranberry, grape, raspberry, etc.).
3. **Other plants** — *not* found in any berry, but a retrieved paper reports it in some plant.
4. **None retrieved** — no retrieved paper places it in elderberry, a berry, or a plant (nothing came back, or only non-plant literature such as mammalian pharmacology or industrial chemistry).

## Step 5 — Render to PDF (clickable links)

After the markdown is saved, **always** render a PDF alongside it:

```bash
node make-pdf.mjs <markdown-path>
```

This writes `<same-basename>.pdf` next to the markdown using the user's installed Chrome (headless); PMID links render as clickable hyperlinks. Return both the `.md` source and the `.pdf` deliverable.

## Hard rules

- **Cite only PMIDs actually returned by the PubMed calls in this run.** Never invent PMIDs from training memory. If a paragraph would need a citation you didn't retrieve, rewrite it without that claim. With subagents, a citation is valid only if that subagent retrieved its PMID.
- **Research every named compound — never exclude one.** No statistics decide inclusion; every named compound is reported regardless of its literature label.
- **No statistics in the report** — no ranking, p-value, fold-change, m/z, RT, or composite. Identity (name + formula) and literature only.
- **No likelihood-verdict tags** beyond the literature-evidence tier label. Report what the literature shows and reason honestly.
- **Honesty over polish.** "No elderberry-specific literature was retrieved; the identity rests on the Compound Discoverer spectral match alone" is better than padding with tangential citations.
