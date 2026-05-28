/**
 * Azure OAuth2 client credentials flow — fetches an access token from Azure AD
 * using a service principal (client_id + client_secret + tenant_id).
 */
import { z } from "zod";

export interface AzureCredentials {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  subscriptionId: string;
}

const tokenResponseSchema = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  token_type: z.string(),
});

async function exchangeAadToken(
  creds: AzureCredentials,
  scope: string,
  label: string,
): Promise<string> {
  const url = `https://login.microsoftonline.com/${creds.tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    scope,
  });
  const res = await fetch(url, {
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

export function fetchAccessToken(creds: AzureCredentials): Promise<string> {
  return exchangeAadToken(creds, "https://management.azure.com/.default", "Azure auth");
}

export function fetchStorageAccessToken(creds: AzureCredentials): Promise<string> {
  return exchangeAadToken(creds, "https://storage.azure.com/.default", "Azure storage auth");
}

/**
 * AAD access token scoped to Microsoft Graph — used for app registration, service principal,
 * and group/user management via https://graph.microsoft.com/v1.0.
 */
export function fetchGraphAccessToken(creds: AzureCredentials): Promise<string> {
  return exchangeAadToken(creds, "https://graph.microsoft.com/.default", "Azure Graph auth");
}

/**
 * AAD access token scoped to Azure Container Registry — used as the input to
 * the ACR refresh-token exchange on {loginServer}/oauth2/exchange.
 */
export function fetchAcrAccessToken(creds: AzureCredentials): Promise<string> {
  return exchangeAadToken(creds, "https://containerregistry.azure.net/.default", "Azure ACR auth");
}

/**
 * AAD access token scoped to Service Bus / Event Hubs data plane (both use
 * the same audience). Used to POST messages into queues/topics/hubs via the
 * REST API.
 */
export function fetchServiceBusAccessToken(creds: AzureCredentials): Promise<string> {
  return exchangeAadToken(creds, "https://servicebus.azure.net/.default", "Azure Service Bus auth");
}
