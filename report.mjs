#!/usr/bin/env node
/**
 * Crash-safe, resumable report writer for elderberry-lit-synth.
 *
 * Durable store: a directory `<report>.entries/` holding one `<uid>.json` per
 * researched compound, each written ATOMICALLY (temp file + rename). This is the
 * single source of truth. Atomic per-uid files mean:
 *   - a crash mid-write leaves a stray `.tmp` (ignored), never a corrupt entry;
 *   - concurrent subagents writing different uids never collide;
 *   - re-writing the same uid is idempotent (atomic overwrite, last writer wins).
 * `<report>.md` is a derived, human-watchable preview; `finalize` always
 * re-renders it from the store, so any mid-run inconsistency self-heals.
 *
 * A token-out loses AT MOST the single compound in flight; everything already
 * persisted survives, and resume (`done`) skips it.
 *
 *   node report.mjs init     --out <md> --source <xlsx> --total <n>
 *   node report.mjs done      --out <md>                 # -> JSON array of completed uids
 *   node report.mjs append    --out <md> --json <file>   # atomic + idempotent on uid
 *   node report.mjs finalize  --out <md> --extract <extract.json>
 *
 * Compound JSON consumed by `append` (produced by Claude/a subagent):
 *   {uid, name, formula, evidenceTier:"elderberry"|"berries"|"plants"|"none",
 *    paragraph, citations:[{pmid,authors,year,title,journal}]}
 */
import fs from "node:fs";
import path from "node:path";

const [, , cmd, ...rest] = process.argv;
const args = {};
for (let i = 0; i < rest.length; i++) {
  if (!rest[i].startsWith("--")) continue;
  const k = rest[i].slice(2);
  const n = rest[i + 1];
  if (n && !n.startsWith("--")) { args[k] = n; i++; } else args[k] = true;
}
const die = (m) => { console.error(m); process.exit(1); };
if (!cmd) die("Usage: report.mjs <init|done|append|finalize> --out <md> ...");
if (!args.out) die("--out <report.md> is required");

const md = args.out;
const dir = `${md}.entries`;                 // durable per-uid store

// Two ORTHOGONAL axes (per Fable's critique): a single label conflated three different
// questions, so split them. PROVENANCE = where the molecule is documented to occur in
// nature (biogenic). DISPOSITION = what THIS particular detection most likely is.
const PROVENANCE = ["elderberry", "other_berry", "other_plant", "non_plant", "unknown"];
const PROVENANCE_LABEL = {
  elderberry: "Elderberry (Sambucus)",
  other_berry: "Other berry",
  other_plant: "Other plant",
  non_plant: "Non-plant origin",
  unknown: "Unknown / undocumented",
};
const DISPOSITION = ["native_plausible", "oxidation_processing", "synthetic_contaminant", "misannotation", "identity_unresolved", "undetermined"];
const DISPOSITION_LABEL = {
  native_plausible: "plausibly native to this sample",
  oxidation_processing: "oxidation / processing artifact",
  synthetic_contaminant: "synthetic — contaminant / carry-over",
  misannotation: "likely misannotation / cross-sample contaminant",
  identity_unresolved: "identity unresolved",
  undetermined: "origin undetermined",
};
const PLANT_PROV = new Set(["elderberry", "other_berry", "other_plant"]);
const CITE_ROLES = ["occurrence", "identity", "context"];
// read legacy single-axis entries
const LEGACY_PROV = { elderberry: "elderberry", berries: "other_berry", plants: "other_plant", other_berry: "other_berry", other_plant: "other_plant", synthetic: "non_plant", artifact: "unknown", none: "unknown" };
const provOf = (e) => e.provenance || LEGACY_PROV[e.verdict] || LEGACY_PROV[e.evidenceTier] || "unknown";
const dispOf = (e) => e.disposition || "undetermined";

// Write atomically: a crash leaves only the temp file, never a half-written target.
const atomicWrite = (file, data) => {
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
};

const readEntries = () => {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json") || f.includes(".tmp.")) continue;
    try { out.push(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))); }
    catch { console.error(`warning: skipping unreadable entry ${f}`); }
  }
  return out;
};

// Hard-reject structurally broken entries so the source of truth stays clean;
// soft-coerce the optional fields.
const validate = (e) => {
  if (e == null || typeof e !== "object") die("entry is not an object");
  if (!Number.isInteger(e.uid)) die(`entry uid must be an integer, got ${JSON.stringify(e.uid)}`);
  if (!e.name || typeof e.name !== "string") die(`entry ${e.uid}: name must be a non-empty string`);
  const provenance = provOf(e), disposition = dispOf(e);
  if (!PROVENANCE.includes(provenance)) die(`entry ${e.uid}: provenance must be one of ${PROVENANCE.join("|")}, got ${JSON.stringify(provenance)}`);
  if (!DISPOSITION.includes(disposition)) die(`entry ${e.uid}: disposition must be one of ${DISPOSITION.join("|")}, got ${JSON.stringify(disposition)}`);
  e.provenance = provenance; e.disposition = disposition;
  if (e.paragraph != null && typeof e.paragraph !== "string") die(`entry ${e.uid}: paragraph must be a string`);
  if (e.citations != null && !Array.isArray(e.citations)) die(`entry ${e.uid}: citations must be an array`);
  e.paragraph = (e.paragraph || "").toString();
  e.citations = (Array.isArray(e.citations) ? e.citations : []).map((c) => ({
    ...c, role: CITE_ROLES.includes(c.role) ? c.role : "context",  // default unrole'd citations to context
  }));
  // Invariant (Fable): a plant PROVENANCE must be backed by genuine occurrence evidence —
  // an occurrence-role citation OR a curated occurrence record with a reference — never a
  // tangential/context paper. occurrence_basis should name a verifiable record (e.g. Wikidata QID).
  if (PLANT_PROV.has(provenance)) {
    const hasOcc = e.citations.some((c) => c.role === "occurrence") || (e.occurrence_basis && String(e.occurrence_basis).trim());
    if (!hasOcc) die(`entry ${e.uid}: provenance "${provenance}" requires an occurrence-role citation or occurrence_basis (verifiable curated record). Set provenance to non_plant/unknown, or supply the occurrence support.`);
  }
  return e;
};

const renderEntry = (e) => {
  const provL = PROVENANCE_LABEL[provOf(e)] || PROVENANCE_LABEL.unknown;
  const dispL = DISPOSITION_LABEL[dispOf(e)] || DISPOSITION_LABEL.undetermined;
  const cites = (e.citations || []).map((c, i) => {
    const role = CITE_ROLES.includes(c.role) ? c.role : "context";
    const head = `${c.authors || "Unknown"} (${c.year || "n.d."})`;
    const tail = [c.title, c.journal].map((x) => String(x || "").trim().replace(/\.+$/, "")).filter(Boolean).join(". ");
    const link = c.pmid ? ` [https://pubmed.ncbi.nlm.nih.gov/${c.pmid}/](https://pubmed.ncbi.nlm.nih.gov/${c.pmid}/)` : "";
    return `${i + 1}. _[${role}]_ ${head}. ${tail}.${link}`;
  });
  return [
    `### ${e.uid}. ${e.name} <!-- uid:${e.uid} -->`, ``,
    `**Biogenic provenance: ${provL}  ·  Detection disposition: ${dispL}**`, ``,
    `Formula: ${e.formula || "—"}`,
    e.occurrence_basis ? `Occurrence basis: ${e.occurrence_basis}` : ``,
    ``,
    (e.paragraph || "").trim(), ``,
    cites.length ? "Citations _(role-tagged: occurrence = documents it in this matrix · identity = what the compound is · context = related/refuting)_:\n" + cites.join("\n") : "_No literature retrieved this run._", ``,
    `---`, ``,
  ].join("\n").replace(/\n\n\n+/g, "\n\n");
};

const header = (source, total, when) => [
  `# Elderberry Metabolomics Literature Synthesis`, ``,
  `Source: ${source || "—"}`,
  `Generated: ${when}`,
  `Compounds to research: ${total ?? "—"}`, ``,
  `## Results`, ``, ``,
].join("\n");

if (cmd === "init") {
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(md)) atomicWrite(md, header(args.source, args.total, new Date().toISOString()));
  console.log(`initialized ${md} (durable store: ${dir})`);

} else if (cmd === "done") {
  const uids = [...new Set(readEntries().map((e) => e.uid))].filter((u) => Number.isInteger(u)).sort((a, b) => a - b);
  console.log(JSON.stringify(uids));

} else if (cmd === "append") {
  if (!args.json) die("append needs --json <file with the compound result>");
  const entry = validate(JSON.parse(fs.readFileSync(args.json, "utf8")));
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${entry.uid}.json`);
  const firstTime = !fs.existsSync(target);
  atomicWrite(target, JSON.stringify(entry));               // durable, atomic, idempotent
  if (firstTime) {                                          // best-effort live preview (finalize re-renders authoritatively)
    if (!fs.existsSync(md)) atomicWrite(md, header(args.source, args.total, new Date().toISOString()));
    fs.appendFileSync(md, renderEntry(entry));
    console.log(`appended uid ${entry.uid} (${entry.name})`);
  } else {
    console.log(`uid ${entry.uid} already recorded — updated (idempotent)`);
  }

} else if (cmd === "finalize") {
  const entries = readEntries().sort((a, b) => a.uid - b.uid);
  let source = args.source, total = args.total, dupSection = "";
  if (args.extract && fs.existsSync(args.extract)) {
    const ex = JSON.parse(fs.readFileSync(args.extract, "utf8"));
    source = source || ex.source;
    total = total || ex.unique_count;
    const uidName = new Map((ex.unique || []).map((u) => [u.uid, u.name]));
    const dups = (ex.rows || []).filter((r) => !r.representative);
    if (dups.length) {
      dupSection = "\n## Duplicate detections\n\n" +
        "These named features are repeat detections of a compound already reported above; mapped back, not re-researched:\n\n" +
        dups.map((r) => `- feature ${r.feature_id} "${r.name}" → see compound #${r.uid} (${uidName.get(r.uid) || r.name})`).join("\n") + "\n";
    }
  }
  const pc = entries.reduce((m, e) => ((m[provOf(e)] = (m[provOf(e)] || 0) + 1), m), {});
  const dc = entries.reduce((m, e) => ((m[dispOf(e)] = (m[dispOf(e)] || 0) + 1), m), {});
  const summary = `Researched ${entries.length} unique compounds.\n` +
    `Biogenic provenance — Elderberry: ${pc.elderberry || 0}, Other berry: ${pc.other_berry || 0}, Other plant: ${pc.other_plant || 0}, Non-plant: ${pc.non_plant || 0}, Unknown: ${pc.unknown || 0}.\n` +
    `Detection disposition — native-plausible: ${dc.native_plausible || 0}, oxidation/processing: ${dc.oxidation_processing || 0}, synthetic-contaminant: ${dc.synthetic_contaminant || 0}, misannotation: ${dc.misannotation || 0}, identity-unresolved: ${dc.identity_unresolved || 0}, undetermined: ${dc.undetermined || 0}.\n`;
  const body = header(source, total, new Date().toISOString()) + summary + "\n" + entries.map(renderEntry).join("") + dupSection;
  atomicWrite(md, body);                                    // atomic overwrite — never a partial file
  console.log(`finalized ${md}: ${entries.length} compounds`);

} else {
  die(`unknown command: ${cmd}`);
}
