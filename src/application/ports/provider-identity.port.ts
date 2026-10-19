export const PROVIDER_IDENTITY_PORT = Symbol("PROVIDER_IDENTITY_PORT");

export interface ProviderIdentityResult {
  authenticated: boolean;
  providerId?: string;
  reason?: string;
}

export interface ProviderIdentityPort {
  verifyRequest(
    headers: Record<string, string | string[] | undefined>,
    claimedProviderId?: string,
  ): Promise<ProviderIdentityResult>;
}

