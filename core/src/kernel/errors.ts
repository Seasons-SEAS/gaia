/** Thrown for inputs the kernel refuses to compute with (negative, non-finite, missing user rate). */
export class KernelInputError extends Error {
  readonly code = "invalid_input" as const;
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "KernelInputError";
  }
}

export function requireFinite(field: string, v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new KernelInputError(field, `${field} must be a finite number`);
  }
  return v;
}

export function requireNonNegative(field: string, v: unknown): number {
  const n = requireFinite(field, v);
  if (n < 0) throw new KernelInputError(field, `${field} must not be negative`);
  return n;
}

export function requirePositive(field: string, v: unknown): number {
  const n = requireFinite(field, v);
  if (n <= 0) throw new KernelInputError(field, `${field} must be greater than 0`);
  return n;
}
