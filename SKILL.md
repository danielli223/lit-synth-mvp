---
name: elderberry-lit-synth
description: Generate a literature-cited markdown + PDF report from a Thermo Compound Discoverer metabolomics Excel export of an elderberry/Sambucus study. It researches EVERY named compound — no ranking, no comparisons, no p-value/fold-change/statistics of any kind. For each unique compound it queries PubMed live, labels the most specific literature tier it appears in (elderberry > other berries > other plants > none), and writes a cited reasoned paragraph on whether it plausibly occurs in elderberry. Duplicate detections of the same compound are mapped back, not re-researched. Claude does the research directly (subagents for scale), so no OpenAI/Anthropic API key is needed. Use when the user asks to analyze an elderberry metabolome xlsx, run lit-synth on an elderberry study, or generate an elderberry literature report.
---

# elderberry-lit-synth

Self-contained skill. Claude acts as the LLM directly — **no API key, no external program**. It researches **every named compound** in a Compound Discoverer export against the literature. **No statistics anywhere** — no ranking, no comparisons, no p-value, fold-change, m/z, RT, or composite scores in the logic or the report. Every named compound is researched and reported.

Two helpers do the heavy lifting so durability and evidence-gathering don't depend on Claude's ephemeral context:
- **`occurrence.mjs`** — per compound, gathers structured evidence: PubChem identity (CID/InChIKey), LOTUS occurrence (which organisms it is documented in, classified into elderberry / other-berry / other-plant via curated genera), and Europe PMC full-text hit counts. It is **evidence only** — a LOTUS hit never short-circuits the reasoned paragraph.
- **`report.mjs`** — crash-safe, resumable writer. Each researched compound is persisted immediately to `<report>.entries.jsonl` (source of truth) and rendered live. A token-out loses **at most the one compound in flight**; resume skips everything already done.

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

Save that JSON to a file (e.g. `extract.json`) — Step 4's `finalize` reads it to map duplicates back. Then **open the report once** before researching:

```bash
node report.mjs init --out <report.md> --source <xlsx> --total <unique_count>
```

## Step 2 — Research each UNIQUE compound

Research only the `unique` compounds (researching a duplicate gives an identical literature answer).

**First, gather structured evidence** with `occurrence.mjs` (PubChem identity + LOTUS organisms + Europe PMC depth):

```bash
node occurrence.mjs --name "<compound name>"   # JSON: {pubchem, lotus{in_sambucus, berry_genera, ...}, europepmc{elderberry/berries/plants hitCounts}}
```

`lotus.in_sambucus: true` is strong evidence the compound occurs in elderberry; `berry_genera` / `n_other_organisms` inform the other-berry / other-plant tiers. **But occurrence is evidence, not a verdict — you still write the full reasoned paragraph for every compound, even one LOTUS confirms in *Sambucus*.** Europe PMC hit counts can be co-occurrence noise (e.g. a compound merely *compared against* elderberry), so judge relevance, don't auto-trust the number.

**Then** add tiered PubMed Title/Abstract searches for retrievable citations, most specific first (~0.4s spacing to dodge HTTP 429; URL-encode the name):

```bash
NAME=<urlencoded compound name>
# elderberry tier:
curl -s "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&retmax=6&term=%22${NAME}%22%5Btiab%5D+AND+(Sambucus+OR+elderberry)"
# other-berries tier — curated edible-berry GENERA (scientific genus + clean common names, not just "*berry" words). Risky bare genera (Morus, Euterpe, Sorbus, Aristotelia, Schisandra, Berberis) are represented by safe common names to avoid false friends:
curl -s "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&retmax=6&term=%22${NAME}%22%5Btiab%5D+AND+(Vaccinium+OR+blueberry+OR+cranberry+OR+bilberry+OR+lingonberry+OR+Ribes+OR+blackcurrant+OR+redcurrant+OR+gooseberry+OR+Vitis+OR+grape+OR+muscadine+OR+Lycium+OR+goji+OR+wolfberry+OR+Physalis+OR+goldenberry+OR+barberry+OR+zereshk+OR+Mahonia+OR+Shepherdia+OR+buffaloberry+OR+Myrciaria+OR+Plinia+OR+jaboticaba+OR+camu-camu+OR+haskap+OR+honeyberry+OR+Fragaria+OR+strawberry+OR+Rubus+OR+raspberry+OR+blackberry+OR+cloudberry+OR+mulberry+OR+crowberry+OR+Amelanchier+OR+serviceberry+OR+Hippophae+OR+seabuckthorn+OR+Aronia+OR+chokeberry+OR+Schizandra+OR+rowanberry+OR+Gaylussacia+OR+goumi+OR+Hylocereus+OR+Selenicereus+OR+dragonfruit+OR+pitaya+OR+acai+OR+maqui)"
# other-plants tier:
curl -s "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&retmax=6&term=%22${NAME}%22%5Btiab%5D+AND+(plant+OR+fruit+OR+leaf+OR+phytochemical+OR+phytochemistry+OR+botanical)"
```

`esummary` the returned PMIDs for title / authors / year / journal, then **judge relevance yourself** — beware false friends ("elder" matching an author surname or "elderly"; "Sambucus nigra agglutinin / SNA" used merely as a lab reagent; a berry genus matched in a non-fruit context, e.g. a grape compound studied only in wine pharmacology, or a *Lycium*/*Physalis* paper about the leaf/root). A paper only counts if it genuinely reports **this** compound in that berry/plant matrix.

If nothing relevant is retrieved at any tier, say "no supporting literature retrieved" and rest the assessment on chemical reasoning — do **not** exclude the compound. It still belongs in the report.

**Always reason, even when occurrence is already confirmed.** A LOTUS `in_sambucus: true` (or any direct hit) is the *starting point* of the paragraph, not a substitute for it. Every compound — confirmed or not — gets the same 100–200 word reasoned write-up: what the compound is, what the evidence (LOTUS organisms + retrieved papers) actually shows, and a reasoned judgment on its plausibility in elderberry. Never collapse a compound to "found in LOTUS, done."

### Scaling to many compounds (subagent fan-out)

Researching more than ~8 compounds inline bloats this conversation's context. For larger runs (the full unique set, e.g. hundreds), **dispatch parallel research subagents**:

1. **Resume first:** `node report.mjs done --out <report.md>` prints the uids already finished. Drop them from the work list so a re-run never re-researches a compound.
2. Split the *remaining* `unique` list into batches (~8–12 compounds each).
3. Each subagent, per compound, runs **both** `occurrence.mjs` **and** the tiered PubMed searches — PubMed is mandatory for *every* compound and is **never skipped just because LOTUS already confirmed occurrence**. It then writes a result `{uid, name, formula, evidenceTier, paragraph, citations:[{pmid, authors, year, title, journal}]}`. `evidenceTier` ∈ (`elderberry` | `berries` | `plants` | `none`) assigned per the **tier rule** in Step 4; `pmid` is a **string** (or omit/null if none); `citations` lists **only PMIDs actually retrieved**.
4. **Persist each result immediately** — write the compound's JSON to a temp file and `node report.mjs append --out <report.md> --json <tmp>`. This is the crash-safety boundary: once appended, that compound survives any later token-out. Append is idempotent on uid, so re-running a batch is safe.
5. Subagents space PubMed calls (~0.4s) and retry on HTTP 429.

Because every compound is persisted the instant it's done, the main thread holds almost nothing in context — and an interruption at compound N keeps all N−1 already on disk.

## Step 3 — Map duplicates back

Every named feature must be covered: a **representative** row carries its compound's researched entry; a **redundant** row is the same molecule re-detected and points to its compound's `uid` (never re-researched). **`report.mjs finalize` does this automatically** from the `rows` mapping in your saved `extract.json` — you don't hand-write it.

## Step 4 — Assemble & finalize the report

The report was written incrementally by `report.mjs append` all through Step 2 (one section per compound, persisted the instant it's researched). To produce the clean, uid-ordered final deliverable, run:

```bash
node report.mjs finalize --out <report.md> --extract <extract.json>
```

`finalize` re-renders the whole report from the durable `<report.md>.entries.jsonl`, sorts sections by uid, adds a tier summary, and appends the duplicate-detection mapping (Step 3). It produces exactly this structure — **no statistics**, identity (name + formula) and literature only:

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

### Literature-evidence label — the tier rule

Pick the **single most specific tier** with genuine supporting evidence, more specific wins. "Supporting evidence" means **either** a genuinely-relevant retrieved PubMed paper **or** a LOTUS occurrence record (LOTUS records are literature-derived and carry their own reference) — both count, so a compound `occurrence.mjs` shows `in_sambucus: true` is Elderberry tier even if PubMed returned nothing.

1. **Elderberry (Sambucus)** — a retrieved paper reports it in elderberry/*Sambucus*, **or** LOTUS `in_sambucus: true`. Use this even when it's also in other berries/plants.
2. **Other berries** — not in elderberry, but a retrieved paper reports it in another berry **or** LOTUS shows a berry genus (`berry_genera` non-empty).
3. **Other plants** — not in any berry, but a retrieved paper reports it in some plant **or** LOTUS shows other plant organisms.
4. **None retrieved** — nothing places it in elderberry, a berry, or a plant (nothing came back, or only non-plant literature such as mammalian pharmacology or industrial chemistry).

**Citations stay PubMed-honest:** cite only PMIDs you actually retrieved. When a tier rests on LOTUS rather than a retrieved paper, say so in the paragraph (e.g. "documented in *S. nigra* per LOTUS/Wikidata") — never fabricate a PMID to justify the tier. If LOTUS was truncated (`truncated: true`), treat a negative berry/other classification as "not seen in the first 1000 organisms", not a hard absence; `in_sambucus` is always authoritative.

### Resuming after an interruption (token-out / crash)

Re-run the same command. The flow self-heals:

1. `node report.mjs done --out <report.md>` → the uids already finished.
2. Research only the remaining compounds (Step 2). `append` is idempotent, so even a half-finished batch is safe to replay.
3. `node report.mjs finalize ...` when the work list is empty.

Nothing already on disk is lost or duplicated; at most the single compound that was mid-flight when it stopped is redone.

## Step 5 — Render to PDF (clickable links)

After the markdown is saved, **always** render a PDF alongside it:

```bash
node make-pdf.mjs <markdown-path>
```

This writes `<same-basename>.pdf` next to the markdown using the user's installed Chrome (headless); PMID links render as clickable hyperlinks. Return both the `.md` source and the `.pdf` deliverable.

## Hard rules

- **Cite only PMIDs actually returned by the PubMed calls in this run.** Never invent PMIDs from training memory. If a paragraph would need a citation you didn't retrieve, rewrite it without that claim. With subagents, a citation is valid only if that subagent retrieved its PMID.
- **Research every named compound — never exclude one.** No statistics decide inclusion; every named compound is reported regardless of its literature label.
- **Persist immediately, resume cleanly.** Append each compound via `report.mjs` the instant it's researched; never hold the whole run in context for one final write. On restart, `report.mjs done` tells you what to skip — never re-research a finished compound.
- **Occurrence evidence informs, never short-circuits.** A LOTUS `in_sambucus`, PubChem identity, or Europe PMC hit may *establish the tier* (with its own reference) but it **never** replaces the reasoned write-up, never excludes a compound, and never excuses skipping the mandatory PubMed search. Every compound — confirmed or not — gets the full reasoned paragraph.
- **No statistics in the report** — no ranking, p-value, fold-change, m/z, RT, or composite. Identity (name + formula) and literature only.
- **No likelihood-verdict tags** beyond the literature-evidence tier label. Report what the literature shows and reason honestly.
- **Honesty over polish.** "No elderberry-specific literature was retrieved; the identity rests on the Compound Discoverer spectral match alone" is better than padding with tangential citations.
