import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { PROVIDER_IDENTITY_PORT } from "../../../application/ports/provider-identity.port";
import type { ProviderIdentityPort } from "../../../application/ports/provider-identity.port";

@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(
    @Inject(PROVIDER_IDENTITY_PORT)
    private readonly identityPort: ProviderIdentityPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      body?: { providerId?: string };
      params?: { providerId?: string };
    }>();

    const claimedProviderId =
      req.body?.providerId ?? req.params?.providerId;
    const verification = await this.identityPort.verifyRequest(
      req.headers ?? {},
      claimedProviderId,
    );

    if (!verification.authenticated) {
      throw new UnauthorizedException({
        errorCode: "UNAUTHORIZED_PROVIDER",
        message: verification.reason ?? "Provider authentication failed",
      });
    }

    return true;
  }
}
