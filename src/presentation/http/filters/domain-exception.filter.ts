import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import {
  BusinessRuleViolationError,
  CurrencyMismatchError,
  DomainError,
  IdempotencyConflictError,
  InvalidDomainValidationError,
  InvalidMoneyError,
  InvalidTransactionStateError,
  ResourceNotFoundError,
  TransientInfrastructureError,
  WalletAlreadyExistsError,
} from "../../../domain/shared/domain-error";
import { StructuredLoggerService } from "../../../infrastructure/observability/logger.service";

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: StructuredLoggerService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<{
      status: (code: number) => { json: (body: unknown) => void };
    }>();
    const request = ctx.getRequest<{
      headers?: Record<string, string | undefined>;
      url?: string;
      method?: string;
    }>();

    const correlationId =
      request?.headers?.["x-correlation-id"] ?? undefined;

    if (
      exception instanceof InvalidMoneyError ||
      exception instanceof InvalidDomainValidationError ||
      exception instanceof InvalidTransactionStateError
    ) {
      response.status(HttpStatus.BAD_REQUEST).json({
        errorCode: exception.code,
        message: exception.message,
        correlationId,
      });
      return;
    }

    if (
      exception instanceof IdempotencyConflictError ||
      exception instanceof WalletAlreadyExistsError
    ) {
      response.status(HttpStatus.CONFLICT).json({
        errorCode: exception.code,
        message: exception.message,
        correlationId,
      });
      return;
    }

    if (
      exception instanceof BusinessRuleViolationError ||
      exception instanceof CurrencyMismatchError
    ) {
      response.status(HttpStatus.UNPROCESSABLE_ENTITY).json({
        errorCode: exception.code,
        failureCode: exception.code,
        message: exception.message,
        correlationId,
      });
      return;
    }

    if (exception instanceof ResourceNotFoundError) {
      response.status(HttpStatus.NOT_FOUND).json({
        errorCode: exception.code,
        message: exception.message,
        correlationId,
      });
      return;
    }

    if (exception instanceof TransientInfrastructureError) {
      response.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        errorCode: exception.code,
        message: exception.message,
        correlationId,
      });
      return;
    }

    if (exception instanceof DomainError) {
      response.status(HttpStatus.BAD_REQUEST).json({
        errorCode: exception.code,
        message: exception.message,
        correlationId,
      });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const resBody = exception.getResponse();
      if (status === HttpStatus.BAD_REQUEST) {
        response.status(status).json({
          errorCode: "INVALID_PAYLOAD",
          message:
            typeof resBody === "string"
              ? resBody
              : (resBody as { message?: string }).message ?? "Bad Request",
          correlationId,
        });
        return;
      }
      response.status(status).json(
        typeof resBody === "object"
          ? { ...resBody, correlationId }
          : { message: resBody, correlationId },
      );
      return;
    }

    this.logger.error("Unhandled exception in HTTP layer", {
      event: "http_unhandled_exception",
      correlationId,
      path: request?.url,
      method: request?.method,
      error: (exception as Error)?.message,
    });

    response.status(HttpStatus.SERVICE_UNAVAILABLE).json({
      errorCode: "TRANSIENT_INFRASTRUCTURE_ERROR",
      message: "Temporary infrastructure failure",
      correlationId,
    });
  }
}

