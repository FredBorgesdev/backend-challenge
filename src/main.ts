import "reflect-metadata";
import { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { StructuredLoggerService } from "./infrastructure/observability/logger.service";

export async function createConfiguredApp(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, {
    logger: false,
  });
  app.enableShutdownHooks();
  return app;
}

async function bootstrap() {
  const app = await createConfiguredApp();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, "0.0.0.0");

  const logger = app.get(StructuredLoggerService);
  logger.info(`Distributed Wagering Processor listening on port ${port}`, {
    event: "application_started",
    port,
  });
}

if (import.meta.main) {
  bootstrap().catch((err) => {
    console.error(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "ERROR",
        event: "bootstrap_failed",
        message: (err as Error)?.message,
      }),
    );
    process.exit(1);
  });
}

