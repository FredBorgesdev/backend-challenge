import { FailureCode } from "../wagering/enums";

export class DomainError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class InvalidMoneyError extends DomainError {
  constructor(message: string) {
    super(message, "INVALID_MONEY");
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor(expected: string, received: string) {
    super(
      `Currency mismatch: expected ${expected}, received ${received}`,
      FailureCode.CurrencyMismatch,
    );
  }
}

export class InvalidTransactionStateError extends DomainError {
  constructor(currentStatus: string, targetAction: string) {
    super(
      `Cannot perform ${targetAction} when transaction is in state ${currentStatus}`,
      "INVALID_TRANSACTION_STATE",
    );
  }
}

export class InvalidDomainValidationError extends DomainError {
  constructor(message: string, code = "INVALID_PAYLOAD") {
    super(message, code);
  }
}

export class BusinessRuleViolationError extends DomainError {
  constructor(
    message: string,
    public readonly failureCode: FailureCode,
  ) {
    super(message, failureCode);
  }
}

export class InsufficientFundsError extends BusinessRuleViolationError {
  constructor(walletId: string) {
    super(
      `Insufficient funds in wallet ${walletId}`,
      FailureCode.InsufficientFunds,
    );
  }
}

export class NegativeBalanceOnReversalError extends BusinessRuleViolationError {
  constructor(walletId: string) {
    super(
      `Reversal would result in negative balance in wallet ${walletId}`,
      FailureCode.NegativeBalanceOnReversal,
    );
  }
}

export class IdempotencyConflictError extends DomainError {
  constructor(idempotencyKey: string) {
    super(
      `Idempotency key '${idempotencyKey}' was already used with a different payload`,
      "IDEMPOTENCY_CONFLICT",
    );
  }
}

export class WalletAlreadyExistsError extends DomainError {
  constructor(playerId: string, currency: string) {
    super(
      `Wallet already exists for player '${playerId}' and currency '${currency}'`,
      "WALLET_ALREADY_EXISTS",
    );
  }
}

export class ResourceNotFoundError extends DomainError {
  constructor(resource: string, identifier: string, code = "NOT_FOUND") {
    super(`${resource} '${identifier}' not found`, code);
  }
}

export class TransientInfrastructureError extends DomainError {
  constructor(message: string) {
    super(message, "TRANSIENT_INFRASTRUCTURE_ERROR");
  }
}

