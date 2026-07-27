import { InvalidStateTransitionError } from "./errors.js";

export type TransitionTable<S extends string> = Record<S, readonly S[]>;

/**
 * A small, explicit finite-state machine. It only ever answers "is this
 * transition legal" and "what are the legal transitions from here" — it does
 * not carry side effects. Callers apply the transition and are responsible
 * for persisting the new state and recording the audit event atomically.
 */
export class StateMachine<S extends string> {
  constructor(
    private readonly entityName: string,
    private readonly table: TransitionTable<S>,
  ) {}

  allowedNext(current: S): readonly S[] {
    return this.table[current] ?? [];
  }

  canTransition(from: S, to: S): boolean {
    return this.allowedNext(from).includes(to);
  }

  assertTransition(from: S, to: S): void {
    if (!this.canTransition(from, to)) {
      throw new InvalidStateTransitionError(this.entityName, from, to);
    }
  }
}
