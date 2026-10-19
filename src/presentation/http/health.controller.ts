import { EntityManager } from "@mikro-orm/postgresql";
import { Controller, Get, HttpStatus, Res } from "@nestjs/common";
import { SqsClientService } from "../../infrastructure/messaging/sqs-client.service";
import { MetricsService } from "../../infrastructure/observability/metrics.service";

/**
 * Endpoints públicos de liveness, readiness e métricas operacionais.
 */
@Controller()
export class HealthController {
  constructor(
    private readonly em: EntityManager,
    private readonly sqsService: SqsClientService,
    private readonly metricsService: MetricsService,
  ) {}

  @Get("health/live")
  live() {
    return {
      status: "UP",
      timestamp: new Date().toISOString(),
    };
  }

  @Get("health/ready")
  async ready(
    @Res({ passthrough: true })
    res: { status: (code: number) => void },
  ) {
    let postgresUp = false;
    try {
      await this.em.fork().getConnection().execute("SELECT 1");
      postgresUp = true;
    } catch {
      postgresUp = false;
    }

    const sqsUp = await this.sqsService.isHealthy();
    const allReady = postgresUp && sqsUp;

    res.status(allReady ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);

    return {
      status: allReady ? "READY" : "NOT_READY",
      dependencies: {
        postgres: postgresUp ? "UP" : "DOWN",
        sqs: sqsUp ? "UP" : "DOWN",
      },
      timestamp: new Date().toISOString(),
    };
  }

  @Get("metrics")
  metrics() {
    return this.metricsService.getSnapshot();
  }
}

