/** Thrown to fail a case with a readable reason. */
export class Failure extends Error {
  constructor(message: string, readonly details?: unknown) {
    super(message);
    this.name = "Failure";
  }
}

/** Thrown to skip a case with a reason (not a failure). */
export class Skip extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Skip";
  }
}

export function check(condition: unknown, message: string, details?: unknown): asserts condition {
  if (!condition) throw new Failure(message, details);
}
