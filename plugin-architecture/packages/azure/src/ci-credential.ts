/**
 * Lending an Azure connection to a CI job (`manifest.ciCredential`): the
 * connection's service principal, as the variables Azure's own tools read.
 *
 * - `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` and `AZURE_CLIENT_SECRET` are what
 *   the Azure SDKs' `EnvironmentCredential` (and so `DefaultAzureCredential`)
 *   read, `ARM_*` what Terraform's azurerm provider reads, and
 *   `AZURE_SUBSCRIPTION_ID` names the subscription. The Azure CLI takes the
 *   same three with `az login --service-principal --username
 *   "$AZURE_CLIENT_ID" --password="$AZURE_CLIENT_SECRET" --tenant
 *   "$AZURE_TENANT_ID"`.
 * - Not short-lived. The CLI takes no bearer token from outside, and a
 *   secret of its own per run would need the principal to be able to add
 *   passwords to its own application, which few are, and would leave one
 *   expired secret on the application per run. So the job gets the stored
 *   secret, which the declaration says, and the admin lending it sees.
 *   Verified 2026-11 against Microsoft's "Sign in with Azure CLI using a
 *   service principal".
 */
import type { CiCredentialDeclaration, CiLentMaterial } from "@infrawrench/plugin-base";

import type { AzureCredentials } from "./auth.js";

export const AZURE_CI_CREDENTIAL: CiCredentialDeclaration = {
  description:
    "The connection's service principal: AZURE_CLIENT_ID, AZURE_TENANT_ID, AZURE_CLIENT_SECRET and AZURE_SUBSCRIPTION_ID, which the Azure SDKs read, and the same as ARM_* for Terraform. This is the stored client secret, not a short-lived one.",
  shortLived: false,
};

/** What one lend of an Azure connection sets. */
export function lendServicePrincipal(creds: AzureCredentials): CiLentMaterial {
  const shown = (value: string) => [{ text: value }];
  return {
    env: {
      AZURE_CLIENT_ID: shown(creds.clientId),
      AZURE_TENANT_ID: shown(creds.tenantId),
      AZURE_CLIENT_SECRET: creds.clientSecret,
      AZURE_SUBSCRIPTION_ID: shown(creds.subscriptionId),
      ARM_CLIENT_ID: shown(creds.clientId),
      ARM_TENANT_ID: shown(creds.tenantId),
      ARM_CLIENT_SECRET: creds.clientSecret,
      ARM_SUBSCRIPTION_ID: shown(creds.subscriptionId),
    },
    files: [],
    summary: "the service principal's client secret",
  };
}
