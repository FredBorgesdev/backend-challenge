import { MikroOrmModule } from "@mikro-orm/nestjs";
import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { buildMikroOrmOptions } from "../mikro-orm.config";
import { EVENT_PUBLISHER_PORT } from "./application/ports/event-publisher.port";
import { PROVIDER_IDENTITY_PORT } from "./application/ports/provider-identity.port";
import { CreateWalletUseCase } from "./application/use-cases/create-wallet.use-case";
import { GetWalletQueriesUseCase } from "./application/use-cases/get-wallet-queries.use-case";
import { ProcessPendingReferencesUseCase } from "./application/use-cases/process-pending-references.use-case";
import { PublishOutboxUseCase } from "./application/use-cases/publish-outbox.use-case";
import { ReconcileWalletUseCase } from "./application/use-cases/reconcile-wallet.use-case";
import { SubmitWagerTransactionUseCase } from "./application/use-cases/submit-wager-transaction.use-case";
import { ConfigurableProviderIdentityAdapter } from "./infrastructure/auth/configurable-provider-identity.adapter";
import { SqsClientService } from "./infrastructure/messaging/sqs-client.service";
import { SqsEventPublisher } from "./infrastructure/messaging/sqs-event.publisher";
import { SqsWagerConsumer } from "./infrastructure/messaging/sqs-wager.consumer";
import { BackgroundWorkersService } from "./infrastructure/messaging/workers/background-workers.service";
import { StructuredLoggerService } from "./infrastructure/observability/logger.service";
import { MetricsService } from "./infrastructure/observability/metrics.service";
import { DomainExceptionFilter } from "./presentation/http/filters/domain-exception.filter";
import { ProviderAuthGuard } from "./presentation/http/guards/provider-auth.guard";
import { HealthController } from "./presentation/http/health.controller";
import { WageringController } from "./presentation/http/wagering.controller";
import { WalletsController } from "./presentation/http/wallets.controller";

@Module({
  imports: [MikroOrmModule.forRoot(buildMikroOrmOptions())],
  controllers: [WalletsController, WageringController, HealthController],
  providers: [
    StructuredLoggerService,
    MetricsService,
    SqsClientService,
    {
      provide: EVENT_PUBLISHER_PORT,
      useClass: SqsEventPublisher,
    },
    {
      provide: PROVIDER_IDENTITY_PORT,
      useClass: ConfigurableProviderIdentityAdapter,
    },
    ProviderAuthGuard,
    CreateWalletUseCase,
    SubmitWagerTransactionUseCase,
    ReconcileWalletUseCase,
    GetWalletQueriesUseCase,
    ProcessPendingReferencesUseCase,
    PublishOutboxUseCase,
    SqsWagerConsumer,
    BackgroundWorkersService,
    {
      provide: APP_FILTER,
      useClass: DomainExceptionFilter,
    },
  ],
  exports: [
    StructuredLoggerService,
    MetricsService,
    SqsClientService,
    CreateWalletUseCase,
    SubmitWagerTransactionUseCase,
    ReconcileWalletUseCase,
    GetWalletQueriesUseCase,
    ProcessPendingReferencesUseCase,
    PublishOutboxUseCase,
    SqsWagerConsumer,
  ],
})
export class AppModule {}

