import { Injectable } from "@nestjs/common";

export interface StructuredLogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
  event?: string;
  status?: string;
  failureCode?: string;
  durationMs?: number;
  [key: string]: unknown;
}

const SENSITIVE_KEYS = new Set([
  "password",
  "secret",
  "token",
  "authorization",
  "apiKey",
  "creditCard",
  "cvv",
  "rawPayload",
]);

@Injectable()
export class StructuredLoggerService {
  private readonly minLevel: number;

  private static readonly LEVELS: Record<string, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
    silent: 100,
  };

  constructor() {
    const envLevel = (process.env.LOG_LEVEL ?? "info").toLowerCase();
    this.minLevel =
      StructuredLoggerService.LEVELS[envLevel] ??
      StructuredLoggerService.LEVELS.info!;
  }

  info(message: string, context: StructuredLogContext = {}): void {
    this.write("INFO", 20, message, context);
  }

  warn(message: string, context: StructuredLogContext = {}): void {
    this.write("WARN", 30, message, context);
  }

  error(message: string, context: StructuredLogContext = {}): void {
    this.write("ERROR", 40, message, context);
  }

  debug(message: string, context: StructuredLogContext = {}): void {
    this.write("DEBUG", 10, message, context);
  }

  private write(
    level: string,
    numericLevel: number,
    message: string,
    context: StructuredLogContext,
  ): void {
    if (numericLevel < this.minLevel) {
      return;
    }

    const sanitizedContext = this.sanitize(context);
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...sanitizedContext,
    };

    const serialized = JSON.stringify(entry);
    if (numericLevel >= 40) {
      process.stderr.write(serialized + "\n");
    } else {
      process.stdout.write(serialized + "\n");
    }
  }

  private sanitize(
    obj: Record<string, unknown>,
  ): Record<string, unknown> {
    const clean: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (value === undefined) continue;
      if (SENSITIVE_KEYS.has(key)) {
        clean[key] = "[REDACTED]";
        continue;
      }
      // Nunca logar payloads financeiros completos (money objeto bruto)
      if (key === "money" || key === "payload") {
        continue;
      }
      clean[key] = value;
    }
    return clean;
  }
}

