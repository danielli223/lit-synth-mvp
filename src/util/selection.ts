/**
 * Parses user list/range selections like "1-5,8,12-15" into a sorted,
 * de-duplicated list of 1-based indices, validated against [min, max].
 *
 * Shared by the comparison picker and the candidate picker so range/comma
 * handling is identical and unit-testable.
 */
export interface SelectionResult {
  values: number[];
  errors: string[];
}

export function parseNumberSelection(
  input: string,
  min: number,
  max: number,
): SelectionResult {
  const values = new Set<number>();
  const errors: string[] = [];
  const trimmed = input.trim();
  if (!trimmed) return { values: [], errors: [] };

  for (const rawToken of trimmed.split(",")) {
    const token = rawToken.trim();
    if (!token) continue;

    const rangeMatch = token.match(/^(\d+)\s*-\s*(\d+)$/);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      const [lo, hi] = start <= end ? [start, end] : [end, start];
      for (let n = lo; n <= hi; n++) {
        if (n < min || n > max) {
          errors.push(`${n} is out of range (${min}-${max})`);
        } else {
          values.add(n);
        }
      }
      continue;
    }

    if (/^\d+$/.test(token)) {
      const n = Number(token);
      if (n < min || n > max) {
        errors.push(`${n} is out of range (${min}-${max})`);
      } else {
        values.add(n);
      }
      continue;
    }

    errors.push(`"${token}" is not a number or range`);
  }

  return {
    values: [...values].sort((a, b) => a - b),
    errors,
  };
}
