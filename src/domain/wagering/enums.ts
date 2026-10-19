export enum WagerTransactionKind {
  Opening = "OPENING",
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  Pending = "PENDING",
  PendingReference = "PENDING_REFERENCE",
  Processed = "PROCESSED",
  Rejected = "REJECTED",
  Failed = "FAILED",
}

export enum LedgerDirection {
  Debit = "DEBIT",
  Credit = "CREDIT",
}

export enum FailureCode {
  InsufficientFunds = "INSUFFICIENT_FUNDS",
  NegativeBalanceOnReversal = "NEGATIVE_BALANCE_ON_REVERSAL",
  CurrencyMismatch = "CURRENCY_MISMATCH",
  ReferenceNotFound = "REFERENCE_NOT_FOUND",
  InvalidReferenceKind = "INVALID_REFERENCE_KIND",
  ReferenceNotProcessed = "REFERENCE_NOT_PROCESSED",
  ReferenceContextMismatch = "REFERENCE_CONTEXT_MISMATCH",
  ReferenceAmountMismatch = "REFERENCE_AMOUNT_MISMATCH",
  ReferenceAlreadyReversed = "REFERENCE_ALREADY_REVERSED",
  WinReferenceInvalid = "WIN_REFERENCE_INVALID",
  PermanentInfrastructureFailure = "PERMANENT_INFRASTRUCTURE_FAILURE",
}

