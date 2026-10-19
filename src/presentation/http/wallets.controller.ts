import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { CreateWalletUseCase } from "../../application/use-cases/create-wallet.use-case";
import { GetWalletQueriesUseCase } from "../../application/use-cases/get-wallet-queries.use-case";
import { ReconcileWalletUseCase } from "../../application/use-cases/reconcile-wallet.use-case";
import type { MoneyProps } from "../../domain/shared/money";
import { ProviderAuthGuard } from "./guards/provider-auth.guard";

@Controller("wallets")
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  constructor(
    private readonly createWalletUseCase: CreateWalletUseCase,
    private readonly getWalletQueriesUseCase: GetWalletQueriesUseCase,
    private readonly reconcileWalletUseCase: ReconcileWalletUseCase,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createWallet(
    @Body() body: { playerId: string; initialBalance: MoneyProps },
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    return this.createWalletUseCase.execute({
      playerId: body?.playerId,
      initialBalance: body?.initialBalance,
      correlationId,
    });
  }

  @Get(":walletId")
  async getWallet(@Param("walletId") walletId: string) {
    return this.getWalletQueriesUseCase.getWalletById(walletId);
  }

  @Get(":walletId/ledger")
  async getLedger(
    @Param("walletId") walletId: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    return this.getWalletQueriesUseCase.getWalletLedger(
      walletId,
      cursor,
      limit,
    );
  }

  @Post(":walletId/reconciliation")
  @HttpCode(HttpStatus.OK)
  async reconcileWallet(
    @Param("walletId") walletId: string,
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    return this.reconcileWalletUseCase.execute(walletId, correlationId);
  }
}
