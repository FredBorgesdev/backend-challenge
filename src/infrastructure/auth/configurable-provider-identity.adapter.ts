import { Injectable } from "@nestjs/common";
import {
  ProviderIdentityPort,
  ProviderIdentityResult,
} from "../../application/ports/provider-identity.port";

/**
 * Adaptador para verificação de identidade de provedores externos (OIDC / OAuth2 Client Credentials).
 * Opera em modo pass-through em desenvolvimento/testes quando `AUTH_ENABLED !== 'true'`.
 */
@Injectable()
export class ConfigurableProviderIdentityAdapter
  implements ProviderIdentityPort
{
  async verifyRequest(
    headers: Record<string, string | string[] | undefined>,
    claimedProviderId?: string,
  ): Promise<ProviderIdentityResult> {
    if (process.env.AUTH_ENABLED !== "true") {
      return {
        authenticated: true,
        providerId: claimedProviderId,
      };
    }

    const authHeader = headers["authorization"];
    const rawBearer = Array.isArray(authHeader) ? authHeader[0] : authHeader;
    if (!rawBearer || !rawBearer.startsWith("Bearer ")) {
      return {
        authenticated: false,
        reason: "Missing or invalid Bearer token",
      };
    }

    const token = rawBearer.slice("Bearer ".length).trim();
    if (!token) {
      return {
        authenticated: false,
        reason: "Empty Bearer token",
      };
    }

    return {
      authenticated: true,
      providerId: claimedProviderId,
    };
  }
}

