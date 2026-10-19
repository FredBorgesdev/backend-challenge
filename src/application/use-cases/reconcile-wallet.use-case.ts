import { EntityManager } from "@mikro-orm/postgresql";
import { Injectable } from "@nestjs/common";
import {
  InvalidDomainValidationError,
  ResourceNotFoundError,
} from "../../domain/shared/domain-error";
import { Money, MoneyProps } from "../../domain/shared/money";
import { LedgerDirection } from "../../domain/wagering/enums";
import { StructuredLoggerService } from "../../infrastructure/observability/logger.service";
import { MetricsService } from "../../infrastructure/observability/metrics.service";
import {
  WalletLedgerEntryOrmEntity,
  WalletOrmEntity,
} from "../../infrastructure/persistence/entities/orm-entities";
import {
  WalletLedgerEntryMapper,
  WalletMapper,
} from "../../infrastructure/persistence/mappers/domain-mappers";

export interface ReconciliationResult {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class ReconcileWalletUseCase {
  constructor(
    private readonly em: EntityManager,
    private readonly logger: StructuredLoggerService,
    private readonly metrics: MetricsService,
  ) {}

  async execute(
    walletId: string,
    correlationId?: string,
  ): Promise<ReconciliationResult> {
    if (!walletId || !UUID_REGEX.test(walletId.trim())) {
      throw new InvalidDomainValidationError("walletId must be a valid UUID");
    }

    const fork = this.em.fork();

    return fork.transactional(async (txEm) => {
      const walletOrm = await txEm.findOne(WalletOrmEntity, {
        id: walletId.trim(),
      });
      if (!walletOrm) {
        throw new ResourceNotFoundError(
          "Wallet",
          walletId,
          "WALLET_NOT_FOUND",
        );
      }

      const wallet = WalletMapper.toDomain(walletOrm);
      const ledgerOrms = await txEm.find(
        WalletLedgerEntryOrmEntity,
        { walletId: wallet.id },
        { orderBy: { sequenceNumber: "ASC", createdAt: "ASC" } },
      );

      let calculated = Money.zero(wallet.currency);
      let chainConsistent = true;

      for (const ormEntry of ledgerOrms) {
        const entry = WalletLedgerEntryMapper.toDomain(ormEntry);
        if (!entry.isBalanced() || !entry.balanceBefore.equals(calculated)) {
          chainConsistent = false;
        }
        if (entry.direction === LedgerDirection.Credit) {
          calculated = calculated.add(entry.money);
        } else {
          calculated = calculated.subtract(entry.money);
        }
      }

      const difference = wallet.balance.subtract(calculated);
      const consistent = difference.isZero() && chainConsistent;

      if (!consistent) {
        this.metrics.incrementReconciliationDiscrepancy();
        this.logger.error("Wallet reconciliation discrepancy detected", {
          event: "wallet_reconciliation_discrepancy",
          correlationId,
          walletId: wallet.id,
          storedBalance: wallet.balance.amount,
          calculatedBalance: calculated.amount,
          difference: difference.amount,
          checkedEntries: ledgerOrms.length,
        });
      } else {
        this.logger.info("Wallet reconciliation verified", {
          event: "wallet_reconciliation_ok",
          correlationId,
          walletId: wallet.id,
          checkedEntries: ledgerOrms.length,
        });
      }

      return {
        walletId: wallet.id,
        storedBalance: wallet.balance.toJSON(),
        calculatedBalance: calculated.toJSON(),
        difference: difference.toJSON(),
        consistent,
        checkedEntries: ledgerOrms.length,
      };
    });
  }
}

