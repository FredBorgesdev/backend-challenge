import { createHash } from "node:crypto";
import { MoneyProps } from "./money";
import { WagerTransactionKind } from "../wagering/enums";

export interface WagerBusinessPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind | string;
  money: MoneyProps;
  referenceExternalTransactionId?: string | null;
}

/**
 * Serializa recursivamente um objeto JSON com chaves ordenadas lexicograficamente,
 * omitindo chaves com valor `undefined` ou `null` para garantir determinismo.
 */
export function canonicalizeJson(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalizeJson(item));
    return `[${items.join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sortedKeys = Object.keys(record)
      .filter((key) => record[key] !== undefined && record[key] !== null)
      .sort();
    const pairs = sortedKeys.map(
      (key) => `${JSON.stringify(key)}:${canonicalizeJson(record[key])}`,
    );
    return `{${pairs.join(",")}}`;
  }
  return JSON.stringify(String(value));
}

export function computeCanonicalSha256(value: unknown): string {
  const canonical = canonicalizeJson(value);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Calcula o payloadHash de uma transação de aposta usando apenas os campos de negócio
 * (excluindo headers e metadados de transporte como messageId ou idempotencyKey).
 */
export function computeWagerPayloadHash(payload: WagerBusinessPayload): string {
  const normalizedBusinessSubset = {
    externalTransactionId: payload.externalTransactionId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: {
      amount: payload.money.amount,
      currency: payload.money.currency,
    },
    playerId: payload.playerId,
    providerId: payload.providerId,
    referenceExternalTransactionId:
      payload.referenceExternalTransactionId ?? undefined,
    roundId: payload.roundId,
    walletId: payload.walletId,
  };
  return computeCanonicalSha256(normalizedBusinessSubset);
}

