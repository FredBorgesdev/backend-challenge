import { describe, expect, it } from "bun:test";
import {
  CurrencyMismatchError,
  InvalidMoneyError,
} from "../../src/domain/shared/domain-error";
import { Money } from "../../src/domain/shared/money";

describe("Money (Value Object)", () => {
  it("creates valid Money with fixed 2 decimal scale and preserves immutability", () => {
    const a = Money.from({ amount: "25.00", currency: "BRL" });
    const b = Money.from({ amount: "10.5", currency: "BRL" });
    const sum = a.add(b);

    expect(a.toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
    expect(b.toJSON()).toEqual({ amount: "10.50", currency: "BRL" });
    expect(sum.toJSON()).toEqual({ amount: "35.50", currency: "BRL" });
    // Immutability check: original instances unchanged
    expect(a.amount).toBe("25.00");
    expect(b.amount).toBe("10.50");
  });

  it("handles floating-point precision traps (0.10 + 0.20 === 0.30)", () => {
    const m1 = Money.from({ amount: "0.10", currency: "BRL" });
    const m2 = Money.from({ amount: "0.20", currency: "BRL" });
    const result = m1.add(m2);

    expect(result.amount).toBe("0.30");
    expect(result.equals(Money.from({ amount: "0.30", currency: "BRL" }))).toBe(
      true,
    );
  });

  it("supports subtract, negate, isZero, isPositive, isNegative, isLessThan, equals", () => {
    const zero = Money.zero("BRL");
    const ten = Money.from({ amount: "10.00", currency: "BRL" });
    const twenty = Money.from({ amount: "20.00", currency: "BRL" });

    expect(zero.isZero()).toBe(true);
    expect(zero.isPositive()).toBe(false);
    expect(zero.isNegative()).toBe(false);

    expect(ten.isPositive()).toBe(true);
    expect(ten.isLessThan(twenty)).toBe(true);
    expect(twenty.isLessThan(ten)).toBe(false);

    const negTen = ten.negate();
    expect(negTen.isNegative()).toBe(true);
    expect(negTen.toJSON()).toEqual({ amount: "-10.00", currency: "BRL" });

    const diff = ten.subtract(twenty);
    expect(diff.isNegative()).toBe(true);
    expect(diff.equals(negTen)).toBe(true);
  });

  it("applies deterministic Banker's Rounding (HALF_EVEN) in fromUnscaledDecimal", () => {
    const r1 = Money.fromUnscaledDecimal("10.005", "BRL");
    const r2 = Money.fromUnscaledDecimal("10.015", "BRL");
    expect(r1.amount).toBe("10.00");
    expect(r2.amount).toBe("10.02");
  });

  it("rejects invalid inputs: NaN, Infinity, scientific notation, empty string, >2 decimal places, negative input", () => {
    const invalidAmounts = [
      "",
      " ",
      "NaN",
      "Infinity",
      "-Infinity",
      "1e2",
      "1E-2",
      "25.000",
      "0.123",
      "-10.00",
      "-0.01",
      "+10.00",
      "25.",
      ".50",
      "abc",
      "25,00",
    ];

    for (const amount of invalidAmounts) {
      expect(() => Money.from({ amount, currency: "BRL" })).toThrow(
        InvalidMoneyError,
      );
    }

    const invalidCurrencies = ["", "br", "BRLX", "123", "bRl"];
    for (const currency of invalidCurrencies) {
      expect(() => Money.from({ amount: "10.00", currency })).toThrow(
        InvalidMoneyError,
      );
    }
  });

  it("throws CurrencyMismatchError when operating across different currencies", () => {
    const brl = Money.from({ amount: "50.00", currency: "BRL" });
    const usd = Money.from({ amount: "50.00", currency: "USD" });

    expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.isLessThan(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.equals(usd)).toThrow(CurrencyMismatchError);
  });
});

