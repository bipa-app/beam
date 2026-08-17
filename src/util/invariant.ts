/**
 * Terminal guard for switches over closed unions. TypeScript proves every
 * call site unreachable; arriving here at runtime means a discriminant no
 * beam release ever wrote came in through persisted state or config —
 * corruption or a foreign writer, never a user mistake. The error names
 * the impossible value so the corrupt artifact can be found and repaired.
 */
export function unreachable(value: never, what: string): never {
  throw new Error(`beam (invariant): impossible ${what}: ${JSON.stringify(value)}`);
}
