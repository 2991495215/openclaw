import {
  getModelProviderRequestRouteFacts,
  prepareModelProviderRequestRouteFacts,
  resolveProviderRequestHeaders,
  type ProviderRequestCapability,
  type ProviderRequestTransport,
} from "openclaw/plugin-sdk/provider-http";
import { DEFAULT_GOOGLE_API_BASE_URL } from "./provider-policy.js";

export function resolveGoogleApiClientHeaders(params?: {
  api?: string;
  baseUrl?: string;
  capability?: ProviderRequestCapability;
  transport?: ProviderRequestTransport;
  providerMetadataOwners?: Parameters<
    typeof resolveProviderRequestHeaders
  >[0]["providerMetadataOwners"];
}): Record<string, string> {
  return (
    resolveProviderRequestHeaders({
      provider: "google",
      api: params?.api ?? "google-generative-ai",
      baseUrl: params?.baseUrl ?? DEFAULT_GOOGLE_API_BASE_URL,
      capability: params?.capability ?? "other",
      transport: params?.transport ?? "http",
      providerMetadataOwners: params?.providerMetadataOwners,
    }) ?? {}
  );
}

export async function prepareGoogleApiClientMetadata(
  params: Parameters<typeof resolveGoogleApiClientHeaders>[0] = {},
) {
  const model = await prepareModelProviderRequestRouteFacts({
    provider: "google",
    api: params.api ?? "google-generative-ai",
    baseUrl: params.baseUrl ?? DEFAULT_GOOGLE_API_BASE_URL,
  });
  return getModelProviderRequestRouteFacts(model)?.providerMetadataOwners;
}

export async function resolveGoogleApiClientHeadersAsync(
  params?: Parameters<typeof resolveGoogleApiClientHeaders>[0],
): Promise<Record<string, string>> {
  return resolveGoogleApiClientHeaders({
    ...params,
    providerMetadataOwners: await prepareGoogleApiClientMetadata(params),
  });
}
