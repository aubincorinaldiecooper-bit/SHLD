export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidStateTransitionError extends DomainError {
  constructor(
    public readonly entity: string,
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`Illegal ${entity} transition: ${from} -> ${to}`);
  }
}

export class AuthorizationError extends DomainError {}

export class TargetAuthorizationError extends DomainError {}

export class PolicyViolationError extends DomainError {}

export class BudgetExceededError extends DomainError {}

export class IdempotencyConflictError extends DomainError {}

export class NotFoundError extends DomainError {}
