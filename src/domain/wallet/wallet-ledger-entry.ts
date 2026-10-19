import {
  CurrencyMismatchError,
  InvalidDomainValidationError,
} from "../shared/domain-error";
import { Money } from "../shared/money";
import { LedgerDirection } from "../wagering/enums";

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt?: Date;
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {}

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    if (!props.id || !props.walletId || !props.transactionId) {
      throw new InvalidDomainValidationError(
        "Ledger entry requires id, walletId, and transactionId",
      );
    }

    if (
      props.money.currency !== props.balanceBefore.currency ||
      props.money.currency !== props.balanceAfter.currency
    ) {
      throw new CurrencyMismatchError(
        props.balanceBefore.currency,
        props.money.currency !== props.balanceBefore.currency
          ? props.money.currency
          : props.balanceAfter.currency,
      );
    }

    if (!props.money.isPositive()) {
      throw new InvalidDomainValidationError(
        "Ledger entry amount must be strictly positive",
      );
    }

    if (props.balanceBefore.isNegative() || props.balanceAfter.isNegative()) {
      throw new InvalidDomainValidationError(
        "Ledger entry balances cannot be negative",
      );
    }

    const entry = new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      props.createdAt ?? new Date(),
    );

    if (!entry.isBalanced()) {
      throw new InvalidDomainValidationError(
        `Unbalanced ledger entry: ${props.balanceBefore.toString()} ${
          props.direction === LedgerDirection.Credit ? "+" : "-"
        } ${props.money.toString()} != ${props.balanceAfter.toString()}`,
      );
    }

    return Object.freeze(entry);
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    const entry = new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
    return Object.freeze(entry);
  }

  /** balanceBefore ± money === balanceAfter. Verificada na factory. */
  isBalanced(): boolean {
    if (
      this.money.currency !== this.balanceBefore.currency ||
      this.money.currency !== this.balanceAfter.currency
    ) {
      return false;
    }

    const expectedAfter =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);

    return expectedAfter.equals(this.balanceAfter);
  }
}

