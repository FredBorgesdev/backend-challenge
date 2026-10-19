import { EntityManager } from "@mikro-orm/postgresql";
import { Injectable } from "@nestjs/common";
import {
  InvalidDomainValidationError,
  ResourceNotFoundError,
} from "../../domain/shared/domain-error";
import {
  WagerTransactionOrmEntity,
  WalletLedgerEntryOrmEntity,
  WalletOrmEntity,
} from "../../infrastructure/persistence/entities/orm-entities";
import {
  WagerTransactionMapper,
  WalletLedgerEntryMapper,
  WalletMapper,
} from "../../infrastructure/persistence/mappers/domain-mappers";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class GetWalletQueriesUseCase {
  constructor(private readonly em: EntityManager) {}

  async getWalletById(walletId: string) {
    if (!walletId || !UUID_REGEX.test(walletId.trim())) {
      throw new InvalidDomainValidationError("walletId must be a valid UUID");
    }

    const orm = await this.em.fork().findOne(WalletOrmEntity, {
      id: walletId.trim(),
    });
    if (!orm) {
      throw new ResourceNotFoundError("Wallet", walletId, "WALLET_NOT_FOUND");
    }

    const wallet = WalletMapper.toDomain(orm);
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
      createdAt: wallet.createdAt.toISOString(),
      updatedAt: wallet.updatedAt.toISOString(),
    };
  }

  async getWalletLedger(
    walletId: string,
    cursor?: string,
    limitParam?: number | string,
  ) {
    if (!walletId || !UUID_REGEX.test(walletId.trim())) {
      throw new InvalidDomainValidationError("walletId must be a valid UUID");
    }

    const limit = Math.min(Math.max(Number(limitParam ?? 50) || 50, 1), 200);
    const fork = this.em.fork();

    const walletExists = await fork.findOne(WalletOrmEntity, {
      id: walletId.trim(),
    });
    if (!walletExists) {
      throw new ResourceNotFoundError("Wallet", walletId, "WALLET_NOT_FOUND");
    }

    let afterSequence = "0";
    if (cursor && cursor.trim().length > 0) {
      try {
        const decoded = Buffer.from(cursor.trim(), "base64url").toString(
          "utf8",
        );
        if (!/^\d+$/.test(decoded)) {
          throw new Error("Invalid sequence cursor");
        }
        afterSequence = decoded;
      } catch {
        throw new InvalidDomainValidationError("Invalid opaque cursor");
      }
    }

    const rows = await fork
      .getConnection()
      .execute<
        Array<{
          id: string;
          wallet_id: string;
          transaction_id: string;
          direction: string;
          amount: string;
          currency: string;
          balance_before: string;
          balance_after: string;
          created_at: Date;
          sequence_number: string;
        }>
      >(
        `SELECT id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at, sequence_number
         FROM wallet_ledger_entries
         WHERE wallet_id = ? AND sequence_number > ?
         ORDER BY sequence_number ASC
         LIMIT ?`,
        [walletId.trim(), afterSequence, limit + 1],
      );

    const hasNextPage = rows.length > limit;
    const pageRows = hasNextPage ? rows.slice(0, limit) : rows;
    const lastRow = pageRows[pageRows.length - 1];
    const nextCursor =
      hasNextPage && lastRow
        ? Buffer.from(String(lastRow.sequence_number), "utf8").toString(
            "base64url",
          )
        : null;

    const items = pageRows.map((row) => {
      const orm = new WalletLedgerEntryOrmEntity();
      orm.id = row.id;
      orm.walletId = row.wallet_id;
      orm.transactionId = row.transaction_id;
      orm.direction = row.direction;
      orm.amount = row.amount;
      orm.currency = row.currency;
      orm.balanceBefore = row.balance_before;
      orm.balanceAfter = row.balance_after;
      orm.createdAt = new Date(row.created_at);
      orm.sequenceNumber = String(row.sequence_number);

      const entry = WalletLedgerEntryMapper.toDomain(orm);
      return {
        id: entry.id,
        walletId: entry.walletId,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        createdAt: entry.createdAt.toISOString(),
      };
    });

    return {
      walletId: walletId.trim(),
      items,
      nextCursor,
      hasNextPage,
    };
  }

  async getTransactionById(transactionId: string) {
    if (!transactionId || !UUID_REGEX.test(transactionId.trim())) {
      throw new InvalidDomainValidationError(
        "transactionId must be a valid UUID",
      );
    }

    const orm = await this.em.fork().findOne(WagerTransactionOrmEntity, {
      id: transactionId.trim(),
    });
    if (!orm) {
      throw new ResourceNotFoundError(
        "WagerTransaction",
        transactionId,
        "TRANSACTION_NOT_FOUND",
      );
    }

    return this.serializeTransaction(orm);
  }

  async getTransactionByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ) {
    if (!providerId?.trim() || !externalTransactionId?.trim()) {
      throw new InvalidDomainValidationError(
        "providerId and externalTransactionId are required",
      );
    }

    const orm = await this.em.fork().findOne(WagerTransactionOrmEntity, {
      providerId: providerId.trim(),
      externalTransactionId: externalTransactionId.trim(),
    });
    if (!orm) {
      throw new ResourceNotFoundError(
        "WagerTransaction",
        `${providerId}:${externalTransactionId}`,
        "TRANSACTION_NOT_FOUND",
      );
    }

    return this.serializeTransaction(orm);
  }

  private serializeTransaction(orm: WagerTransactionOrmEntity) {
    const tx = WagerTransactionMapper.toDomain(orm);
    return {
      transactionId: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      idempotencyKey: tx.idempotencyKey,
      walletId: tx.walletId,
      playerId: tx.playerId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      status: tx.status,
      money: tx.money.toJSON(),
      balance: tx.observedBalance?.toJSON(),
      referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
      referenceTransactionId: tx.referenceTransactionId ?? null,
      failureCode: tx.failureCode ?? null,
      createdAt: tx.createdAt.toISOString(),
      processedAt: tx.processedAt ? tx.processedAt.toISOString() : null,
    };
  }
}

