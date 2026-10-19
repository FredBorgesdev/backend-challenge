import { computeWagerPayloadHash } from "../shared/canonical-hash";
import {
  BusinessRuleViolationError,
  CurrencyMismatchError,
  InvalidDomainValidationError,
  InvalidTransactionStateError,
} from "../shared/domain-error";
import { Money } from "../shared/money";
import {
  FailureCode,
  LedgerDirection,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "./enums";

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash?: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt?: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId: string | undefined;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  observedBalance?: Money;
  retryCount?: number;
  nextRetryAt?: Date;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** id no provedor — não o id interno */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _observedBalance?: Money,
    private _retryCount: number = 0,
    private _nextRetryAt?: Date,
  ) {}

  /** Nasce em PENDING. Valida a exigência de referência por kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidDomainValidationError(
        "OPENING transaction kind is internal only and cannot be submitted externally",
      );
    }

    if (
      !props.id ||
      !props.providerId ||
      !props.externalTransactionId ||
      !props.idempotencyKey ||
      !props.walletId ||
      !props.playerId ||
      !props.roundId ||
      !props.gameId
    ) {
      throw new InvalidDomainValidationError(
        "Missing required fields for WagerTransaction",
      );
    }

    if (
      props.kind !== WagerTransactionKind.Loss &&
      !props.money.isPositive()
    ) {
      throw new InvalidDomainValidationError(
        `Transaction of kind ${props.kind} requires a strictly positive money amount`,
      );
    }

    const refExtId =
      props.referenceExternalTransactionId?.trim() || undefined;

    if (
      (props.kind === WagerTransactionKind.Refund ||
        props.kind === WagerTransactionKind.Rollback) &&
      !refExtId
    ) {
      throw new InvalidDomainValidationError(
        `${props.kind} requires referenceExternalTransactionId`,
      );
    }

    if (
      (props.kind === WagerTransactionKind.Bet ||
        props.kind === WagerTransactionKind.Loss) &&
      refExtId
    ) {
      throw new InvalidDomainValidationError(
        `${props.kind} must not specify referenceExternalTransactionId`,
      );
    }

    const payloadHash =
      props.payloadHash ??
      computeWagerPayloadHash({
        providerId: props.providerId,
        externalTransactionId: props.externalTransactionId,
        playerId: props.playerId,
        walletId: props.walletId,
        roundId: props.roundId,
        gameId: props.gameId,
        kind: props.kind,
        money: props.money.toJSON(),
        referenceExternalTransactionId: refExtId,
      });

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      refExtId,
      props.createdAt ?? new Date(),
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
    );
  }

  /** Cria a transação interna OPENING usada exclusivamente na abertura de Wallet com saldo > 0. */
  static createOpening(props: {
    id: string;
    walletId: string;
    playerId: string;
    money: Money;
    createdAt?: Date;
  }): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new InvalidDomainValidationError(
        "OPENING transaction requires positive initial balance",
      );
    }
    const now = props.createdAt ?? new Date();
    const externalTransactionId = `opening:${props.walletId}`;
    const idempotencyKey = `internal:${externalTransactionId}`;
    const payloadHash = computeWagerPayloadHash({
      providerId: "internal",
      externalTransactionId,
      playerId: props.playerId,
      walletId: props.walletId,
      roundId: `opening:${props.walletId}`,
      gameId: "system-wallet-opening",
      kind: WagerTransactionKind.Opening,
      money: props.money.toJSON(),
    });

    const tx = new WagerTransaction(
      props.id,
      "internal",
      externalTransactionId,
      idempotencyKey,
      payloadHash,
      props.walletId,
      props.playerId,
      `opening:${props.walletId}`,
      "system-wallet-opening",
      WagerTransactionKind.Opening,
      props.money,
      undefined,
      now,
      WagerTransactionStatus.Pending,
    );
    tx.markProcessed(undefined, now, props.money);
    return tx;
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.observedBalance,
      state.retryCount ?? 0,
      state.nextRetryAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }

  get retryCount(): number {
    return this._retryCount;
  }

  get nextRetryAt(): Date | undefined {
    return this._nextRetryAt;
  }

  // ---- transições (lançam InvalidTransactionStateError se o estado atual for terminal)

  markProcessed(
    referenceTransactionId: string | undefined,
    at: Date,
    observedBalance?: Money,
  ): void {
    this.assertNotTerminal("markProcessed");

    if (this.requiresReference() && !referenceTransactionId) {
      throw new InvalidDomainValidationError(
        `${this.kind} requires a resolved internal referenceTransactionId to be marked as PROCESSED`,
      );
    }

    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._failureCode = undefined;
    this._nextRetryAt = undefined;
    if (observedBalance) {
      this._observedBalance = observedBalance;
    }
  }

  markPendingReference(now: Date = new Date()): void {
    this.assertNotTerminal("markPendingReference");

    if (!this.requiresReference()) {
      throw new InvalidTransactionStateError(
        this._status,
        `markPendingReference (not allowed for kind ${this.kind})`,
      );
    }

    this._status = WagerTransactionStatus.PendingReference;
    this._nextRetryAt = new Date(now.getTime() + this.computeBackoffMs(0));
  }

  scheduleReferenceRetry(now: Date = new Date()): void {
    this.assertNotTerminal("scheduleReferenceRetry");
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(
        this._status,
        "scheduleReferenceRetry",
      );
    }
    this._retryCount += 1;
    this._nextRetryAt = new Date(
      now.getTime() + this.computeBackoffMs(this._retryCount),
    );
  }

  reject(
    code: FailureCode,
    at: Date = new Date(),
    observedBalance?: Money,
  ): void {
    this.assertNotTerminal("reject");
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._processedAt = at;
    this._nextRetryAt = undefined;
    if (observedBalance) {
      this._observedBalance = observedBalance;
    }
  }

  fail(code: FailureCode, at: Date = new Date()): void {
    this.assertNotTerminal("fail");
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = at;
    this._nextRetryAt = undefined;
  }

  // ---- consultas de domínio

  isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed
    );
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return (
      this.kind === WagerTransactionKind.Refund ||
      this.kind === WagerTransactionKind.Rollback
    );
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidDomainValidationError(
            "ROLLBACK requires the referenced transaction to determine ledger direction",
          );
        }
        const refDirection =
          reference.kind === WagerTransactionKind.Bet
            ? LedgerDirection.Debit
            : reference.kind === WagerTransactionKind.Win ||
                reference.kind === WagerTransactionKind.Refund
              ? LedgerDirection.Credit
              : undefined;
        if (!refDirection) {
          throw new BusinessRuleViolationError(
            `Cannot rollback transaction of kind ${reference.kind}`,
            FailureCode.InvalidReferenceKind,
          );
        }
        return refDirection === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidDomainValidationError(
          "LOSS transaction does not generate a ledger entry",
        );
    }
  }

  /**
   * Valida todas as invariantes de negócio da seção 7 entre a transação atual e a transação referenciada.
   */
  validateReference(reference: WagerTransaction): void {
    if (this.money.currency !== reference.money.currency) {
      throw new CurrencyMismatchError(
        reference.money.currency,
        this.money.currency,
      );
    }

    if (
      reference.providerId !== this.providerId ||
      reference.playerId !== this.playerId ||
      reference.walletId !== this.walletId ||
      reference.roundId !== this.roundId
    ) {
      throw new BusinessRuleViolationError(
        "Referenced transaction context (provider, player, wallet, or round) does not match",
        FailureCode.ReferenceContextMismatch,
      );
    }

    if (reference.status !== WagerTransactionStatus.Processed) {
      throw new BusinessRuleViolationError(
        `Referenced transaction is in status ${reference.status}, expected PROCESSED`,
        FailureCode.ReferenceNotProcessed,
      );
    }

    if (this.kind === WagerTransactionKind.Win) {
      if (reference.kind !== WagerTransactionKind.Bet) {
        throw new BusinessRuleViolationError(
          `WIN can only reference a BET transaction, got ${reference.kind}`,
          FailureCode.WinReferenceInvalid,
        );
      }
      return;
    }

    if (this.kind === WagerTransactionKind.Refund) {
      if (reference.kind !== WagerTransactionKind.Bet) {
        throw new BusinessRuleViolationError(
          `REFUND can only reference a BET transaction, got ${reference.kind}`,
          FailureCode.InvalidReferenceKind,
        );
      }
      if (!this.money.equals(reference.money)) {
        throw new BusinessRuleViolationError(
          `REFUND amount (${this.money.toString()}) must equal referenced BET amount (${reference.money.toString()})`,
          FailureCode.ReferenceAmountMismatch,
        );
      }
      return;
    }

    if (this.kind === WagerTransactionKind.Rollback) {
      if (
        reference.kind !== WagerTransactionKind.Bet &&
        reference.kind !== WagerTransactionKind.Win &&
        reference.kind !== WagerTransactionKind.Refund
      ) {
        throw new BusinessRuleViolationError(
          `ROLLBACK can only reference BET, WIN, or REFUND, got ${reference.kind}`,
          FailureCode.InvalidReferenceKind,
        );
      }
      if (!this.money.equals(reference.money)) {
        throw new BusinessRuleViolationError(
          `ROLLBACK amount (${this.money.toString()}) must equal referenced transaction amount (${reference.money.toString()})`,
          FailureCode.ReferenceAmountMismatch,
        );
      }
    }
  }

  private assertNotTerminal(action: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this._status, action);
    }
  }

  private computeBackoffMs(attempt: number): number {
    // Backoff exponencial: 200ms, 400ms, 800ms, 1600ms, 3200ms...
    const baseMs = 200;
    return Math.min(baseMs * Math.pow(2, attempt), 10_000);
  }
}

