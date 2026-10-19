import { describe, expect, it } from "bun:test";
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidDomainValidationError,
  NegativeBalanceOnReversalError,
} from "../../src/domain/shared/domain-error";
import { Money } from "../../src/domain/shared/money";
import {
  FailureCode,
  LedgerDirection,
} from "../../src/domain/wagering/enums";
import { Wallet } from "../../src/domain/wallet/wallet";
import { WalletLedgerEntry } from "../../src/domain/wallet/wallet-ledger-entry";

describe("Wallet & WalletLedgerEntry", () => {
  it("opens a wallet with version 1 and initial balance", () => {
    const wallet = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
    });

    expect(wallet.id).toBe("wallet-1");
    expect(wallet.playerId).toBe("player-1");
    expect(wallet.currency).toBe("BRL");
    expect(wallet.balance.amount).toBe("100.00");
    expect(wallet.version).toBe(1);
  });

  it("debits and credits maintaining consistent ledger entries and incrementing version", () => {
    const wallet = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
    });

    const debitEntry = wallet.debit({
      entryId: "entry-1",
      transactionId: "tx-bet-1",
      amount: Money.from({ amount: "35.00", currency: "BRL" }),
    });

    expect(wallet.balance.amount).toBe("65.00");
    expect(wallet.version).toBe(2);
    expect(debitEntry.direction).toBe(LedgerDirection.Debit);
    expect(debitEntry.balanceBefore.amount).toBe("100.00");
    expect(debitEntry.balanceAfter.amount).toBe("65.00");
    expect(debitEntry.isBalanced()).toBe(true);

    const creditEntry = wallet.credit({
      entryId: "entry-2",
      transactionId: "tx-win-1",
      amount: Money.from({ amount: "50.00", currency: "BRL" }),
    });

    expect(wallet.balance.amount).toBe("115.00");
    expect(wallet.version).toBe(3);
    expect(creditEntry.direction).toBe(LedgerDirection.Credit);
    expect(creditEntry.balanceBefore.amount).toBe("65.00");
    expect(creditEntry.balanceAfter.amount).toBe("115.00");
    expect(creditEntry.isBalanced()).toBe(true);
  });

  it("rejects debit when insufficient funds with INSUFFICIENT_FUNDS and keeps version unchanged", () => {
    const wallet = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: Money.from({ amount: "50.00", currency: "BRL" }),
    });

    expect(() =>
      wallet.debit({
        entryId: "entry-1",
        transactionId: "tx-bet-1",
        amount: Money.from({ amount: "80.00", currency: "BRL" }),
      }),
    ).toThrow(InsufficientFundsError);

    expect(wallet.balance.amount).toBe("50.00");
    expect(wallet.version).toBe(1);
  });

  it("rejects reversal debit that would cause negative balance with distinct NEGATIVE_BALANCE_ON_REVERSAL code", () => {
    const wallet = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: Money.from({ amount: "20.00", currency: "BRL" }),
    });

    try {
      wallet.debit({
        entryId: "entry-rev-1",
        transactionId: "tx-rollback-win",
        amount: Money.from({ amount: "50.00", currency: "BRL" }),
        isReversal: true,
      });
      expect.unreachable("Should have thrown NegativeBalanceOnReversalError");
    } catch (err) {
      expect(err).toBeInstanceOf(NegativeBalanceOnReversalError);
      expect((err as NegativeBalanceOnReversalError).failureCode).toBe(
        FailureCode.NegativeBalanceOnReversal,
      );
    }

    expect(wallet.balance.amount).toBe("20.00");
    expect(wallet.version).toBe(1);
  });

  it("throws CurrencyMismatchError when debit/credit currency differs from wallet currency", () => {
    const wallet = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
    });

    expect(() =>
      wallet.debit({
        entryId: "e-1",
        transactionId: "tx-1",
        amount: Money.from({ amount: "10.00", currency: "USD" }),
      }),
    ).toThrow(CurrencyMismatchError);

    expect(() =>
      wallet.credit({
        entryId: "e-2",
        transactionId: "tx-2",
        amount: Money.from({ amount: "10.00", currency: "EUR" }),
      }),
    ).toThrow(CurrencyMismatchError);
  });

  it("enforces structural immutability and arithmetic check on WalletLedgerEntry", () => {
    const entry = WalletLedgerEntry.create({
      id: "entry-1",
      walletId: "wallet-1",
      transactionId: "tx-1",
      direction: LedgerDirection.Credit,
      money: Money.from({ amount: "25.00", currency: "BRL" }),
      balanceBefore: Money.from({ amount: "100.00", currency: "BRL" }),
      balanceAfter: Money.from({ amount: "125.00", currency: "BRL" }),
    });

    expect(Object.isFrozen(entry)).toBe(true);

    expect(() =>
      WalletLedgerEntry.create({
        id: "entry-bad",
        walletId: "wallet-1",
        transactionId: "tx-2",
        direction: LedgerDirection.Debit,
        money: Money.from({ amount: "25.00", currency: "BRL" }),
        balanceBefore: Money.from({ amount: "100.00", currency: "BRL" }),
        balanceAfter: Money.from({ amount: "80.00", currency: "BRL" }), // wrong math!
      }),
    ).toThrow(InvalidDomainValidationError);
  });
});

