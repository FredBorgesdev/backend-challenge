import {
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Param,
  Post,
  Res,
  UseGuards,
} from "@nestjs/common";
import { GetWalletQueriesUseCase } from "../../application/use-cases/get-wallet-queries.use-case";
import { SubmitWagerTransactionUseCase } from "../../application/use-cases/submit-wager-transaction.use-case";
import { InvalidDomainValidationError } from "../../domain/shared/domain-error";
import type { MoneyProps } from "../../domain/shared/money";
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/wagering/enums";
import { ProviderAuthGuard } from "./guards/provider-auth.guard";

interface SubmitWagerBody {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

@Controller()
@UseGuards(ProviderAuthGuard)
export class WageringController {
  constructor(
    private readonly submitWagerUseCase: SubmitWagerTransactionUseCase,
    private readonly getWalletQueriesUseCase: GetWalletQueriesUseCase,
  ) {}

  @Post("wagering/transactions")
  async submitTransaction(
    @Headers("idempotency-key") idempotencyKeyHeader: string | undefined,
    @Headers("x-correlation-id") correlationId: string | undefined,
    @Body() body: SubmitWagerBody,
    @Res({ passthrough: true })
    res: { status: (code: number) => void },
  ) {
    if (!idempotencyKeyHeader || idempotencyKeyHeader.trim().length === 0) {
      throw new InvalidDomainValidationError(
        "Idempotency-Key header is required",
        "MISSING_IDEMPOTENCY_KEY",
      );
    }

    const result = await this.submitWagerUseCase.execute({
      idempotencyKey: idempotencyKeyHeader.trim(),
      providerId: body?.providerId,
      externalTransactionId: body?.externalTransactionId,
      playerId: body?.playerId,
      walletId: body?.walletId,
      roundId: body?.roundId,
      gameId: body?.gameId,
      kind: body?.kind,
      money: body?.money,
      referenceExternalTransactionId: body?.referenceExternalTransactionId,
      correlationId,
    });

    if (result.status === WagerTransactionStatus.Processed) {
      res.status(HttpStatus.OK);
    } else if (result.status === WagerTransactionStatus.PendingReference) {
      res.status(HttpStatus.ACCEPTED);
    } else if (result.status === WagerTransactionStatus.Rejected) {
      res.status(HttpStatus.UNPROCESSABLE_ENTITY);
    } else {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
    }

    const responsePayload: Record<string, unknown> = {
      transactionId: result.transactionId,
      status: result.status,
      balance: result.balance,
      idempotentReplay: result.idempotentReplay,
    };

    if (result.failureCode) {
      responsePayload.failureCode = result.failureCode;
    }

    return responsePayload;
  }

  @Get("wagering/transactions/:transactionId")
  async getTransactionById(@Param("transactionId") transactionId: string) {
    return this.getWalletQueriesUseCase.getTransactionById(transactionId);
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  async getTransactionByProviderAndExternalId(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ) {
    return this.getWalletQueriesUseCase.getTransactionByProviderAndExternalId(
      providerId,
      externalTransactionId,
    );
  }
}
