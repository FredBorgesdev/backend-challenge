import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  Message,
  ReceiveMessageCommand,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
import {
  Injectable,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from "@nestjs/common";
import { SubmitWagerTransactionUseCase } from "../../application/use-cases/submit-wager-transaction.use-case";
import { computeCanonicalSha256 } from "../../domain/shared/canonical-hash";
import {
  IdempotencyConflictError,
  InvalidDomainValidationError,
  InvalidMoneyError,
  ResourceNotFoundError,
} from "../../domain/shared/domain-error";
import { MoneyProps } from "../../domain/shared/money";
import { WagerTransactionKind } from "../../domain/wagering/enums";
import { StructuredLoggerService } from "../observability/logger.service";
import { MetricsService } from "../observability/metrics.service";
import { SqsClientService } from "./sqs-client.service";

export interface SqsWagerMessageEnvelope {
  messageId: string;
  type: string;
  occurredAt: string;
  correlationId?: string;
  data: {
    providerId: string;
    externalTransactionId: string;
    idempotencyKey?: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: WagerTransactionKind;
    money: MoneyProps;
    referenceExternalTransactionId?: string;
  };
}

export interface SingleMessageProcessOutcome {
  action: "ACK" | "RETRY" | "DLQ";
  reason?: string;
}

@Injectable()
export class SqsWagerConsumer
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  public static readonly CONSUMER_NAME = "sqs-wager-transactions-consumer";

  private running = false;
  private shuttingDown = false;
  private pollLoopPromise: Promise<void> | null = null;
  private readonly inFlightMessages = new Map<
    string,
    { queueUrl: string; receiptHandle: string }
  >();

  constructor(
    private readonly sqsService: SqsClientService,
    private readonly submitWagerUseCase: SubmitWagerTransactionUseCase,
    private readonly logger: StructuredLoggerService,
    private readonly metrics: MetricsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.SQS_CONSUMER_ENABLED === "false") {
      return;
    }
    try {
      await this.sqsService.ensureQueuesTopology();
    } catch (err) {
      this.logger.warn("Could not initialize SQS topology on bootstrap", {
        event: "sqs_bootstrap_warning",
        error: (err as Error)?.message,
      });
    }
    this.startPolling();
  }

  startPolling(): void {
    if (this.running) return;
    this.running = true;
    this.shuttingDown = false;
    this.pollLoopPromise = this.pollLoop();
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    await this.stopGracefully(signal);
  }

  /**
   * Em SIGTERM / shutdown, interrompe a leitura de novas mensagens, aguarda mensagens em andamento
   * por até `gracePeriodMs`, e devolve a visibilidade (VisibilityTimeout = 0) das que ainda restarem.
   */
  async stopGracefully(
    signal = "SIGTERM",
    gracePeriodMs = 3000,
  ): Promise<void> {
    if (!this.running && this.inFlightMessages.size === 0) {
      return;
    }
    this.shuttingDown = true;
    this.running = false;

    this.logger.info("SQS consumer initiating graceful shutdown", {
      event: "sqs_consumer_shutdown_start",
      signal,
      inFlightCount: this.inFlightMessages.size,
    });

    const deadline = Date.now() + gracePeriodMs;
    while (this.inFlightMessages.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }

    // Se ainda houver mensagens em andamento após o gracePeriod, devolver visibilidade imediatamente
    for (const [msgId, info] of this.inFlightMessages.entries()) {
      try {
        await this.sqsService.client.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: info.queueUrl,
            ReceiptHandle: info.receiptHandle,
            VisibilityTimeout: 0,
          }),
        );
        this.logger.info("Released SQS message visibility on shutdown", {
          event: "sqs_message_visibility_released",
          messageId: msgId,
        });
      } catch {
        // Ignore if already deleted
      }
    }
    this.inFlightMessages.clear();

    if (this.pollLoopPromise) {
      await this.pollLoopPromise.catch(() => undefined);
      this.pollLoopPromise = null;
    }
  }

  /**
   * Faz o poll de um lote da fila `wager-transactions.fifo` e processa cada mensagem.
   * Exposto publicamente para permitir invocação determinística em testes de integração e concorrência.
   */
  async pollOnce(maxMessages = 10, waitTimeSeconds = 0): Promise<number> {
    const queueUrl = await this.sqsService.getQueueUrl(
      this.sqsService.wagerQueueName,
    );

    const response = await this.sqsService.client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: maxMessages,
        WaitTimeSeconds: waitTimeSeconds,
        AttributeNames: ["All"],
        MessageAttributeNames: ["All"],
      }),
    );

    const messages = response.Messages ?? [];
    for (const msg of messages) {
      if (this.shuttingDown) {
        if (msg.ReceiptHandle) {
          await this.sqsService.client.send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: queueUrl,
              ReceiptHandle: msg.ReceiptHandle,
              VisibilityTimeout: 0,
            }),
          );
        }
        continue;
      }
      await this.handleRawSqsMessage(queueUrl, msg);
    }

    return messages.length;
  }

  async handleRawSqsMessage(
    queueUrl: string,
    msg: Message,
    options?: { simulateCrashBeforeAck?: boolean },
  ): Promise<SingleMessageProcessOutcome> {
    const receiptHandle = msg.ReceiptHandle!;
    const sqsMessageId = msg.MessageId ?? "unknown-sqs-id";
    const receiveCount = Number(
      msg.Attributes?.ApproximateReceiveCount ?? "1",
    );

    this.inFlightMessages.set(sqsMessageId, { queueUrl, receiptHandle });

    try {
      let parsed: SqsWagerMessageEnvelope;
      try {
        parsed = JSON.parse(msg.Body ?? "") as SqsWagerMessageEnvelope;
        if (
          !parsed ||
          typeof parsed !== "object" ||
          !parsed.messageId ||
          !parsed.data
        ) {
          throw new InvalidDomainValidationError(
            "Malformed SQS message envelope",
          );
        }
      } catch (parseErr) {
        await this.moveToDlqAndAck(
          queueUrl,
          receiptHandle,
          msg.Body ?? "",
          sqsMessageId,
          (parseErr as Error).message,
        );
        return { action: "DLQ", reason: "MALFORMED_ENVELOPE" };
      }

      const envelopeMessageId = parsed.messageId;
      const correlationId = parsed.correlationId ?? envelopeMessageId;
      const payloadHash = computeCanonicalSha256(parsed.data);
      const idempotencyKey =
        parsed.data.idempotencyKey ??
        `${parsed.data.providerId}:${parsed.data.externalTransactionId}`;

      try {
        await this.submitWagerUseCase.execute({
          idempotencyKey,
          providerId: parsed.data.providerId,
          externalTransactionId: parsed.data.externalTransactionId,
          playerId: parsed.data.playerId,
          walletId: parsed.data.walletId,
          roundId: parsed.data.roundId,
          gameId: parsed.data.gameId,
          kind: parsed.data.kind,
          money: parsed.data.money,
          referenceExternalTransactionId:
            parsed.data.referenceExternalTransactionId,
          correlationId,
          inboxContext: {
            consumerName: SqsWagerConsumer.CONSUMER_NAME,
            messageId: envelopeMessageId,
            payloadHash,
          },
        });

        // Hook para testes de resiliência (falha de processo entre o commit SQL e o ACK do SQS)
        if (options?.simulateCrashBeforeAck) {
          throw new Error("SIMULATED_CRASH_AFTER_COMMIT_BEFORE_ACK");
        }

        // ACK somente após o commit da transação SQL!
        await this.sqsService.client.send(
          new DeleteMessageCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: receiptHandle,
          }),
        );

        return { action: "ACK" };
      } catch (err: unknown) {
        if (
          (err as Error)?.message === "SIMULATED_CRASH_AFTER_COMMIT_BEFORE_ACK"
        ) {
          // Liberar visibilidade para simular redelivery imediato para outra instância
          await this.sqsService.client.send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: queueUrl,
              ReceiptHandle: receiptHandle,
              VisibilityTimeout: 0,
            }),
          );
          throw err;
        }

        // Erros permanentes de contrato / payload inválido / conflito de idempotência -> DLQ imediata
        if (this.isPermanentUnrecoverableError(err)) {
          await this.moveToDlqAndAck(
            queueUrl,
            receiptHandle,
            msg.Body ?? "",
            envelopeMessageId,
            (err as Error).message,
          );
          return { action: "DLQ", reason: (err as Error).message };
        }

        // Erro transitório -> verificar limite de tentativas antes da DLQ
        if (receiveCount >= this.sqsService.maxReceiveCount) {
          await this.moveToDlqAndAck(
            queueUrl,
            receiptHandle,
            msg.Body ?? "",
            envelopeMessageId,
            `Exhausted maxReceiveCount (${this.sqsService.maxReceiveCount}): ${(err as Error).message}`,
          );
          return { action: "DLQ", reason: "MAX_RETRIES_EXHAUSTED" };
        }

        // Agendar retry com backoff exponencial na visibilidade da fila
        this.metrics.incrementRetry("sqs");
        const backoffSeconds = Math.min(Math.pow(2, receiveCount), 30);
        await this.sqsService.client.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: receiptHandle,
            VisibilityTimeout: backoffSeconds,
          }),
        );

        this.logger.warn("Transient error processing SQS message; scheduled retry", {
          event: "sqs_message_retry",
          messageId: envelopeMessageId,
          receiveCount,
          backoffSeconds,
          error: (err as Error)?.message,
        });

        return { action: "RETRY", reason: (err as Error)?.message };
      }
    } finally {
      this.inFlightMessages.delete(sqsMessageId);
    }
  }

  private isPermanentUnrecoverableError(err: unknown): boolean {
    return (
      err instanceof InvalidMoneyError ||
      err instanceof InvalidDomainValidationError ||
      err instanceof IdempotencyConflictError ||
      err instanceof ResourceNotFoundError
    );
  }

  private async moveToDlqAndAck(
    mainQueueUrl: string,
    receiptHandle: string,
    rawBody: string,
    messageId: string,
    reason: string,
  ): Promise<void> {
    const dlqUrl = await this.sqsService.getQueueUrl(
      this.sqsService.wagerDlqName,
    );

    await this.sqsService.client.send(
      new SendMessageCommand({
        QueueUrl: dlqUrl,
        MessageBody: rawBody,
        MessageGroupId: "dlq-group",
        MessageDeduplicationId: `${messageId}-${Date.now()}`,
        MessageAttributes: {
          FailureReason: {
            DataType: "String",
            StringValue: reason.slice(0, 256),
          },
        },
      }),
    );

    await this.sqsService.client.send(
      new DeleteMessageCommand({
        QueueUrl: mainQueueUrl,
        ReceiptHandle: receiptHandle,
      }),
    );

    this.metrics.incrementDlqMessages();
    this.logger.error("Moved message to SQS DLQ", {
      event: "sqs_message_moved_to_dlq",
      messageId,
      reason,
    });
  }

  private async pollLoop(): Promise<void> {
    while (this.running && !this.shuttingDown) {
      try {
        const count = await this.pollOnce(10, 1);
        if (count === 0) {
          await new Promise((r) => setTimeout(r, 150));
        }
      } catch (err) {
        if (!this.shuttingDown) {
          this.logger.warn("Error in SQS poll loop", {
            event: "sqs_poll_error",
            error: (err as Error)?.message,
          });
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    }
  }
}

