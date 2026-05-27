import { describe, it, expect } from "vitest";
import { validateCitations } from "../src/validate-citations.js";
import type { Citation, SynthesisResult } from "../src/types.js";

function cite(partial: Partial<Citation>): Citation {
  return {
    title: "t",
    authors_string: "A",
    year: 2020,
    source: "pubmed",
    id: "1",
    url: "u",
    relevance_note: "r",
    ...partial,
  };
}

const base: SynthesisResult = {
  synthesis_paragraph: "para",
  citations: [],
  confidence: "medium",
  caveats: null,
};

describe("validateCitations", () => {
  it("keeps citations whose ids were actually retrieved", () => {
    const result = {
      ...base,
      citations: [
        cite({ source: "pubmed", id: "111" }),
        cite({ source: "semantic_scholar", id: "abc" }),
      ],
    };
    const out = validateCitations(result, {
      pubmedPmids: new Set(["111"]),
      semanticScholarIds: new Set(["abc"]),
    });
    expect(out.droppedCount).toBe(0);
    expect(out.result.citations).toHaveLength(2);
    expect(out.result.caveats).toBeNull();
  });

  it("drops hallucinated citations and appends a caveat", () => {
    const result = {
      ...base,
      citations: [
        cite({ source: "pubmed", id: "111" }),
        cite({ source: "pubmed", id: "999" }), // not retrieved
        cite({ source: "semantic_scholar", id: "ghost" }), // not retrieved
      ],
    };
    const out = validateCitations(result, {
      pubmedPmids: new Set(["111"]),
      semanticScholarIds: new Set(["real"]),
    });
    expect(out.droppedCount).toBe(2);
    expect(out.result.citations).toHaveLength(1);
    expect(out.result.citations[0]!.id).toBe("111");
    expect(out.result.caveats).toContain(
      "2 citations were dropped during validation.",
    );
  });

  it("preserves an existing caveat when appending", () => {
    const result = {
      ...base,
      caveats: "Literature was sparse.",
      citations: [cite({ source: "pubmed", id: "missing" })],
    };
    const out = validateCitations(result, {
      pubmedPmids: new Set<string>(),
      semanticScholarIds: new Set<string>(),
    });
    expect(out.result.caveats).toBe(
      "Literature was sparse. 1 citation was dropped during validation.",
    );
  });

  it("matches ids only against their own source set", () => {
    // Same id string, wrong source -> must be dropped.
    const result = {
      ...base,
      citations: [cite({ source: "semantic_scholar", id: "111" })],
    };
    const out = validateCitations(result, {
      pubmedPmids: new Set(["111"]),
      semanticScholarIds: new Set<string>(),
    });
    expect(out.droppedCount).toBe(1);
    expect(out.result.citations).toHaveLength(0);
  });

  it("does not mutate the input result", () => {
    const result = {
      ...base,
      citations: [cite({ id: "x" })],
    };
    validateCitations(result, {
      pubmedPmids: new Set<string>(),
      semanticScholarIds: new Set<string>(),
    });
    expect(result.citations).toHaveLength(1);
    expect(result.caveats).toBeNull();
  });
});
