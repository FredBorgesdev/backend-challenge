import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidDomainValidationError,
  NegativeBalanceOnReversalError,
} from "../shared/domain-error";
import { Money } from "../shared/money";
import { LedgerDirection } from "../wagering/enums";
import { WalletLedgerEntry } from "./wallet-ledger-entry";

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  createdAt?: Date;
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletMovementProps {
  entryId: string;
  transactionId: string;
  amount: Money;
  occurredAt?: Date;
  isReversal?: boolean;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): Wallet {
    if (!props.id || props.id.trim().length === 0) {
      throw new InvalidDomainValidationError("Wallet id is required");
    }
    if (!props.playerId || props.playerId.trim().length === 0) {
      throw new InvalidDomainValidationError("Wallet playerId is required");
    }
    if (props.initialBalance.isNegative()) {
      throw new InvalidDomainValidationError(
        "Wallet initial balance cannot be negative",
      );
    }

    const now = props.createdAt ?? new Date();
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      now,
      now,
    );
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(props: WalletMovementProps): WalletLedgerEntry {
    this.assertSameCurrency(props.amount);

    if (!props.amount.isPositive()) {
      throw new InvalidDomainValidationError(
        "Debit amount must be strictly positive",
      );
    }

    if (this._balance.isLessThan(props.amount)) {
      if (props.isReversal) {
        throw new NegativeBalanceOnReversalError(this.id);
      }
      throw new InsufficientFundsError(this.id);
    }

    const balanceBefore = this._balance;
    const balanceAfter = this._balance.subtract(props.amount);
    const now = props.occurredAt ?? new Date();

    const entry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction: LedgerDirection.Debit,
      money: props.amount,
      balanceBefore,
      balanceAfter,
      createdAt: now,
    });

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = now;

    return entry;
  }

  credit(props: WalletMovementProps): WalletLedgerEntry {
    this.assertSameCurrency(props.amount);

    if (!props.amount.isPositive()) {
      throw new InvalidDomainValidationError(
        "Credit amount must be strictly positive",
      );
    }

    const balanceBefore = this._balance;
    const balanceAfter = this._balance.add(props.amount);
    const now = props.occurredAt ?? new Date();

    const entry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction: LedgerDirection.Credit,
      money: props.amount,
      balanceBefore,
      balanceAfter,
      createdAt: now,
    });

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = now;

    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (this.currency !== money.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}

