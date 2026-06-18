// Shared occurrence invariant + tier order — the SINGLE source of truth for all three
// renderers (gen-sample3 / gen-csv / gen-xlsx), matching SKILL.md.
//
// A plant tier (elderberry / other_berry / other_plant) is valid only if it is backed by a
// role:"occurrence" citation (an abstract-confirmed paper, OR a LOTUS QID carried as an
// occurrence-role citation) OR a non-empty occurrence_basis; otherwise the renderer downgrades
// it to "Source not established" (tier key "unknown"). NOTE: this enforces the *tier* invariant
// only — it checks the role TAG, not whether an abstract was actually read. Abstract-grounding of
// that occurrence tag is the agent's discipline + the optional abstract-verification pass, NOT a
// render-time check.
export const TIER_ORDER = ["elderberry", "other_berry", "other_plant", "non_plant", "unknown"];

export function effectiveTier(r) {
  const p = r.provenance;
  // An unidentified molecule (disposition identity_unresolved) cannot hold a documented
  // natural occurrence — any occurrence cite is necessarily for a DIFFERENT, named compound
  // of the same formula, not this peak. Force "Source not established" regardless of provenance.
  if (r.disposition === "identity_unresolved" && p !== "unknown")
    return { tier: "unknown", downgraded: true, original: p, reason: "identity_unresolved" };
  // A confirmed man-made compound (disposition synthetic_contaminant) has a KNOWN, non-plant
  // origin — that is positive non-plant evidence. It belongs in non_plant, not in the bottom
  // "no documented occurrence" tier. Upgrade an unclassified (unknown) synthetic to non_plant.
  if (r.disposition === "synthetic_contaminant" && p === "unknown")
    return { tier: "non_plant", upgraded: true, original: p, reason: "synthetic" };
  if (!["elderberry", "other_berry", "other_plant"].includes(p)) return { tier: p, downgraded: false };
  const hasOcc = (r.citations || []).some((c) => c.role === "occurrence") || !!String(r.occurrence_basis || "").trim();
  return hasOcc ? { tier: p, downgraded: false } : { tier: "unknown", downgraded: true, original: p, reason: "no_occurrence" };
}
