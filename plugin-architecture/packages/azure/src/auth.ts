/**
 * Azure OAuth2 client credentials flow — fetches an access token from Azure AD
 * using a service principal (client_id + client_secret + tenant_id).
 *
 * The token exchange goes through the host's HTTP service whenever one is
 * supplied, exactly like the API calls the token is minted for. That is not
 * symmetry for its own sake: an account bound to a bastion expects *all* of
 * its egress — including the one request that carries the client secret — to
 * leave from its own network, and a tenant whose Entra sign-in is restricted
 * by IP would reject a token request egressing from ours while every
 * subsequent ARM call succeeded, which is a confusing failure to debug.
 */
import type { HttpHostServices } from "@infrawrench/plugin-base";
import { z } from "zod";
import { azureRequest } from "./http.js";

export interface AzureCredentials {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  subscriptionId: string;
}

/** Host HTTP service, when the host supplied one. Omitted → direct `fetch`. */
export type AzureAuthHttp = HttpHostServices | undefined;

const tokenResponseSchema = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  token_type: z.string(),
});

async function exchangeAadToken(
  creds: AzureCredentials,
  scope: string,
  label: string,
  http?: AzureAuthHttp,
): Promise<string> {
  const url = `https://login.microsoftonline.com/${creds.tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    scope,
  });
  const res = await azureRequest(http, url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`${label} failed: ${res.status} ${await res.text()}`);
  }
  const data = tokenResponseSchema.parse(await res.json());
  return data.access_token;
}

export function fetchAccessToken(creds: AzureCredentials, http?: AzureAuthHttp): Promise<string> {
  return exchangeAadToken(creds, "https://management.azure.com/.default", "Azure auth", http);
}

export function fetchStorageAccessToken(
  creds: AzureCredentials,
  http?: AzureAuthHttp,
): Promise<string> {
  return exchangeAadToken(creds, "https://storage.azure.com/.default", "Azure storage auth", http);
}

/**
 * AAD access token scoped to Microsoft Graph — used for app registration, service principal,
 * and group/user management via https://graph.microsoft.com/v1.0.
 */
export function fetchGraphAccessToken(
  creds: AzureCredentials,
  http?: AzureAuthHttp,
): Promise<string> {
  return exchangeAadToken(creds, "https://graph.microsoft.com/.default", "Azure Graph auth", http);
}

/**
 * AAD access token scoped to Azure Container Registry — used as the input to
 * the ACR refresh-token exchange on {loginServer}/oauth2/exchange.
 */
export function fetchAcrAccessToken(
  creds: AzureCredentials,
  http?: AzureAuthHttp,
): Promise<string> {
  return exchangeAadToken(
    creds,
    "https://containerregistry.azure.net/.default",
    "Azure ACR auth",
    http,
  );
}

/**
 * AAD access token scoped to Service Bus / Event Hubs data plane (both use
 * the same audience). Used to POST messages into queues/topics/hubs via the
 * REST API.
 */
export function fetchServiceBusAccessToken(
  creds: AzureCredentials,
  http?: AzureAuthHttp,
): Promise<string> {
  return exchangeAadToken(
    creds,
    "https://servicebus.azure.net/.default",
    "Azure Service Bus auth",
    http,
  );
}
