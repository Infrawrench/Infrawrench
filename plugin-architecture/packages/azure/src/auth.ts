/**
 * Azure OAuth2 client credentials flow — fetches an access token from Azure AD
 * using a service principal (client_id + client_secret + tenant_id).
 */

export interface AzureCredentials {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  subscriptionId: string;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

export async function fetchAccessToken(creds: AzureCredentials): Promise<string> {
  const url = `https://login.microsoftonline.com/${creds.tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    scope: "https://management.azure.com/.default",
  });
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`Azure auth failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as TokenResponse;
  return data.access_token;
}

export async function fetchStorageAccessToken(creds: AzureCredentials): Promise<string> {
  const url = `https://login.microsoftonline.com/${creds.tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    scope: "https://storage.azure.com/.default",
  });
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`Azure storage auth failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as TokenResponse;
  return data.access_token;
}
