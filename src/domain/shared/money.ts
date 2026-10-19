import Decimal from "decimal.js";
import { CurrencyMismatchError, InvalidMoneyError } from "./domain-error";

export interface MoneyProps {
  amount: string;
  currency: string;
}

const ISO_CURRENCY_REGEX = /^[A-Z]{3}$/;
const STRICT_NON_NEGATIVE_DECIMAL_REGEX = /^\d+(\.\d{1,2})?$/;
const STRICT_SIGNED_DECIMAL_REGEX = /^-?\d+(\.\d{1,2})?$/;

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    if (!props || typeof props !== "object") {
      throw new InvalidMoneyError("Money props must be an object");
    }

    const { amount, currency } = props;

    if (typeof currency !== "string" || !ISO_CURRENCY_REGEX.test(currency)) {
      throw new InvalidMoneyError(
        `Invalid ISO-4217 currency code: '${String(currency)}'`,
      );
    }

    if (typeof amount !== "string" || amount.length === 0) {
      throw new InvalidMoneyError("Money amount must be a non-empty string");
    }

    if (!STRICT_NON_NEGATIVE_DECIMAL_REGEX.test(amount)) {
      throw new InvalidMoneyError(
        `Invalid money amount '${amount}': must be a non-negative decimal string with at most 2 decimal places`,
      );
    }

    const decimalValue = new Decimal(amount);
    if (!decimalValue.isFinite() || decimalValue.isNaN()) {
      throw new InvalidMoneyError(`Invalid money amount '${amount}'`);
    }

    return new Money(
      decimalValue.toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN),
      currency,
    );
  }

  /**
   * Reconstrução a partir do banco de dados ou cálculos internos (ex.: diferença de reconciliação).
   */
  static rehydrate(props: MoneyProps): Money {
    if (
      !props ||
      typeof props.currency !== "string" ||
      !ISO_CURRENCY_REGEX.test(props.currency) ||
      typeof props.amount !== "string" ||
      !STRICT_SIGNED_DECIMAL_REGEX.test(props.amount)
    ) {
      throw new InvalidMoneyError("Invalid persisted money state");
    }
    return new Money(
      new Decimal(props.amount).toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN),
      props.currency,
    );
  }

  /**
   * Arredondamento explícito (Banker's Rounding / HALF_EVEN) para cálculos intermediários quando necessário.
   */
  static fromUnscaledDecimal(rawAmount: string, currency: string): Money {
    if (typeof currency !== "string" || !ISO_CURRENCY_REGEX.test(currency)) {
      throw new InvalidMoneyError(
        `Invalid ISO-4217 currency code: '${String(currency)}'`,
      );
    }
    if (
      typeof rawAmount !== "string" ||
      !/^\d+(\.\d+)?$/.test(rawAmount)
    ) {
      throw new InvalidMoneyError(`Invalid raw decimal amount '${rawAmount}'`);
    }
    const rounded = new Decimal(rawAmount).toDecimalPlaces(
      2,
      Decimal.ROUND_HALF_EVEN,
    );
    return new Money(rounded, currency);
  }

  static zero(currency: string): Money {
    if (typeof currency !== "string" || !ISO_CURRENCY_REGEX.test(currency)) {
      throw new InvalidMoneyError(
        `Invalid ISO-4217 currency code: '${String(currency)}'`,
      );
    }
    return new Money(new Decimal("0.00"), currency);
  }

  get amount(): string {
    return this.value.toFixed(2);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(
      this.value
        .plus(other.value)
        .toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN),
      this.currency,
    );
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(
      this.value
        .minus(other.value)
        .toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN),
      this.currency,
    );
  }

  negate(): Money {
    if (this.isZero()) {
      return new Money(new Decimal("0.00"), this.currency);
    }
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return {
      amount: this.value.toFixed(2),
      currency: this.currency,
    };
  }

  toString(): string {
    return `${this.value.toFixed(2)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (!(other instanceof Money)) {
      throw new InvalidMoneyError("Operand must be an instance of Money");
    }
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}

