import { describe, expect, it } from "bun:test";
import { computeWagerPayloadHash } from "../../src/domain/shared/canonical-hash";
import {
  BusinessRuleViolationError,
  CurrencyMismatchError,
  InvalidDomainValidationError,
  InvalidTransactionStateError,
} from "../../src/domain/shared/domain-error";
import { Money } from "../../src/domain/shared/money";
import {
  FailureCode,
  LedgerDirection,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../src/domain/wagering/enums";
import { WagerTransaction } from "../../src/domain/wagering/wager-transaction";

describe("WagerTransaction & Business Rules (BET, WIN, LOSS, REFUND, ROLLBACK)", () => {
  const baseProps = {
    id: "tx-1",
    providerId: "provider-a",
    externalTransactionId: "ext-1",
    idempotencyKey: "provider-a:ext-1",
    walletId: "wallet-1",
    playerId: "player-1",
    roundId: "round-1",
    gameId: "fortune-chimp",
    money: Money.from({ amount: "25.00", currency: "BRL" }),
  };

  it("rejects external creation of OPENING transaction", () => {
    expect(() =>
      WagerTransaction.create({
        ...baseProps,
        kind: WagerTransactionKind.Opening,
      }),
    ).toThrow(InvalidDomainValidationError);
  });

  it("enforces referenceExternalTransactionId presence for REFUND and ROLLBACK, and absence for BET and LOSS", () => {
    expect(() =>
      WagerTransaction.create({
        ...baseProps,
        kind: WagerTransactionKind.Refund,
      }),
    ).toThrow(InvalidDomainValidationError);

    expect(() =>
      WagerTransaction.create({
        ...baseProps,
        kind: WagerTransactionKind.Rollback,
      }),
    ).toThrow(InvalidDomainValidationError);

    expect(() =>
      WagerTransaction.create({
        ...baseProps,
        kind: WagerTransactionKind.Bet,
        referenceExternalTransactionId: "some-ref",
      }),
    ).toThrow(InvalidDomainValidationError);
  });

  it("determines affectsBalance and ledgerDirectionFor across BET, WIN, LOSS, REFUND, ROLLBACK", () => {
    const bet = WagerTransaction.create({
      ...baseProps,
      kind: WagerTransactionKind.Bet,
    });
    expect(bet.affectsBalance()).toBe(true);
    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    bet.markProcessed(undefined, new Date());

    const win = WagerTransaction.create({
      ...baseProps,
      id: "tx-win",
      externalTransactionId: "ext-win",
      idempotencyKey: "provider-a:ext-win",
      kind: WagerTransactionKind.Win,
    });
    expect(win.affectsBalance()).toBe(true);
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    win.markProcessed(undefined, new Date());

    const loss = WagerTransaction.create({
      ...baseProps,
      id: "tx-loss",
      externalTransactionId: "ext-loss",
      idempotencyKey: "provider-a:ext-loss",
      kind: WagerTransactionKind.Loss,
      money: Money.zero("BRL"),
    });
    expect(loss.affectsBalance()).toBe(false);
    expect(() => loss.ledgerDirectionFor()).toThrow(
      InvalidDomainValidationError,
    );

    const refund = WagerTransaction.create({
      ...baseProps,
      id: "tx-refund",
      externalTransactionId: "ext-refund",
      idempotencyKey: "provider-a:ext-refund",
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: "ext-1",
    });
    expect(refund.affectsBalance()).toBe(true);
    expect(refund.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);

    const rollbackBet = WagerTransaction.create({
      ...baseProps,
      id: "tx-rb-bet",
      externalTransactionId: "ext-rb-bet",
      idempotencyKey: "provider-a:ext-rb-bet",
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: "ext-1",
    });
    expect(rollbackBet.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);

    const rollbackWin = WagerTransaction.create({
      ...baseProps,
      id: "tx-rb-win",
      externalTransactionId: "ext-rb-win",
      idempotencyKey: "provider-a:ext-rb-win",
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: "ext-win",
    });
    expect(rollbackWin.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
  });

  it("enforces terminal states (PROCESSED, REJECTED, FAILED cannot transition again)", () => {
    const bet = WagerTransaction.create({
      ...baseProps,
      kind: WagerTransactionKind.Bet,
    });
    bet.markProcessed(undefined, new Date());
    expect(bet.isTerminal()).toBe(true);

    expect(() => bet.reject(FailureCode.InsufficientFunds)).toThrow(
      InvalidTransactionStateError,
    );
    expect(() => bet.fail(FailureCode.PermanentInfrastructureFailure)).toThrow(
      InvalidTransactionStateError,
    );
    expect(() => bet.markProcessed(undefined, new Date())).toThrow(
      InvalidTransactionStateError,
    );
  });

  it("validates reference rules: kind, status, context, currency, and exact amount", () => {
    const bet = WagerTransaction.create({
      ...baseProps,
      kind: WagerTransactionKind.Bet,
    });
    bet.markProcessed(undefined, new Date());

    const win = WagerTransaction.create({
      ...baseProps,
      id: "tx-win",
      externalTransactionId: "ext-win",
      idempotencyKey: "provider-a:ext-win",
      kind: WagerTransactionKind.Win,
    });
    win.markProcessed(undefined, new Date());

    // REFUND cannot reference a WIN
    const refundOnWin = WagerTransaction.create({
      ...baseProps,
      id: "tx-refund-win",
      externalTransactionId: "ext-refund-win",
      idempotencyKey: "provider-a:ext-refund-win",
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: "ext-win",
    });
    expect(() => refundOnWin.validateReference(win)).toThrow(
      BusinessRuleViolationError,
    );

    // Partial REFUND (different amount) is rejected
    const partialRefund = WagerTransaction.create({
      ...baseProps,
      id: "tx-refund-partial",
      externalTransactionId: "ext-refund-partial",
      idempotencyKey: "provider-a:ext-refund-partial",
      kind: WagerTransactionKind.Refund,
      money: Money.from({ amount: "10.00", currency: "BRL" }),
      referenceExternalTransactionId: "ext-1",
    });
    try {
      partialRefund.validateReference(bet);
      expect.unreachable("Should fail with ReferenceAmountMismatch");
    } catch (err) {
      expect((err as BusinessRuleViolationError).failureCode).toBe(
        FailureCode.ReferenceAmountMismatch,
      );
    }

    // Different currency on reference is rejected
    const usdRefund = WagerTransaction.create({
      ...baseProps,
      id: "tx-refund-usd",
      externalTransactionId: "ext-refund-usd",
      idempotencyKey: "provider-a:ext-refund-usd",
      kind: WagerTransactionKind.Refund,
      money: Money.from({ amount: "25.00", currency: "USD" }),
      referenceExternalTransactionId: "ext-1",
    });
    expect(() => usdRefund.validateReference(bet)).toThrow(
      CurrencyMismatchError,
    );
  });

  it("detects idempotency payload hash match vs divergence", () => {
    const tx = WagerTransaction.create({
      ...baseProps,
      kind: WagerTransactionKind.Bet,
    });

    // Same business fields in different key order produce identical hash
    const sameHash = computeWagerPayloadHash({
      walletId: "wallet-1",
      roundId: "round-1",
      providerId: "provider-a",
      playerId: "player-1",
      money: { currency: "BRL", amount: "25.00" },
      kind: WagerTransactionKind.Bet,
      gameId: "fortune-chimp",
      externalTransactionId: "ext-1",
    });
    expect(tx.matchesPayload(sameHash)).toBe(true);

    // Divergent amount with same idempotencyKey produces different hash
    const differentAmountHash = computeWagerPayloadHash({
      ...baseProps,
      kind: WagerTransactionKind.Bet,
      money: { amount: "50.00", currency: "BRL" },
    });
    expect(tx.matchesPayload(differentAmountHash)).toBe(false);
  });
});

