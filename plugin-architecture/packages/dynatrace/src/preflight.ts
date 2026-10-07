/**
 * Credential preflight for Dynatrace.
 *
 * An access token carries a fixed list of scopes, and
 * `POST /api/v2/apiTokens/lookup` (callable with a token of *any* scope)
 * returns that list for the token itself. So the check is exact: every
 * capability is `ok` when the token holds each of its scopes and `missing`
 * otherwise, with no probing of individual endpoints. Scope names are the
 * ones the Environment API reference lists per endpoint (2026-10).
 */

import type {
  PolicyTemplate,
  PreflightCapability,
  PreflightCapabilityCheck,
  PreflightDeclaration,
  PreflightResult,
} from "@infrawrench/plugin-base";
import type { DynatraceContext } from "./api.js";
import { envFetch, statusOf } from "./api.js";

const perm = (id: string) => ({ id, label: id });

export const CAPABILITIES: PreflightCapability[] = [
  {
    id: "entities",
    label: "Monitored entities",
    description: "List hosts, process groups, services, applications and Kubernetes clusters.",
    requiredPermissions: [perm("entities.read")],
    essential: true,
  },
  {
    id: "problems",
    label: "Problems",
    description: "List problems; comment on and close them.",
    requiredPermissions: [perm("problems.read"), perm("problems.write")],
  },
  {
    id: "metrics",
    label: "Metrics",
    description: "Chart host, service, application and synthetic metrics.",
    requiredPermissions: [perm("metrics.read")],
  },
  {
    id: "slo",
    label: "Service-level objectives",
    description: "List, create, edit and delete SLOs.",
    requiredPermissions: [perm("slo.read"), perm("slo.write")],
  },
  {
    id: "synthetic",
    label: "Synthetic monitors",
    description: "List, create, turn off and on, and delete synthetic monitors.",
    requiredPermissions: [perm("ExternalSyntheticIntegration")],
  },
  {
    id: "settings",
    label: "Alerting profiles and maintenance windows",
    description: "Read and change Settings 2.0 objects.",
    requiredPermissions: [perm("settings.read"), perm("settings.write")],
  },
  {
    id: "tokens",
    label: "Access tokens",
    description: "List, rename, turn off and revoke access tokens.",
    requiredPermissions: [perm("apiTokens.read"), perm("apiTokens.write")],
  },
  {
    id: "logs",
    label: "Logs",
    description: "Read a host's or service's logs (without a platform token).",
    requiredPermissions: [perm("logs.read")],
  },
];

export const DYNATRACE_PREFLIGHT: PreflightDeclaration = {
  capabilities: CAPABILITIES,
  templateFormat: { label: "Access token scopes", language: "text" },
};

export function dynatracePolicyTemplate(capabilityIds: string[]): PolicyTemplate {
  const wanted = CAPABILITIES.filter(
    (c) => capabilityIds.length === 0 || capabilityIds.includes(c.id) || c.essential,
  );
  const scopes = Array.from(new Set(wanted.flatMap((c) => c.requiredPermissions.map((p) => p.id))));
  return {
    formatLabel: "Access token scopes",
    language: "text",
    document: scopes.join("\n"),
    instructions:
      "In Dynatrace, open Access Tokens, select Generate new token, and tick each of these scopes. Copy the dt0c01 token into Infrawrench.",
    helpLink: {
      label: "Dynatrace access tokens",
      url: "https://docs.dynatrace.com/docs/manage/identity-access-management/access-tokens-and-oauth-clients/access-tokens",
    },
  };
}

interface TokenLookup {
  name?: string;
  owner?: string;
  scopes?: string[];
  enabled?: boolean;
  expirationDate?: string;
}

/** The token's own metadata. Any scope may call it. */
export function lookupToken(ctx: DynatraceContext): Promise<TokenLookup> {
  return envFetch<TokenLookup>(ctx, "/api/v2/apiTokens/lookup", {
    method: "POST",
    body: JSON.stringify({ token: ctx.apiToken }),
  });
}

export async function verifyDynatraceCredentials(ctx: DynatraceContext): Promise<PreflightResult> {
  let token: TokenLookup;
  try {
    token = await lookupToken(ctx);
  } catch (err) {
    const status = statusOf(err);
    const message =
      status === 401
        ? "Dynatrace rejected the access token: it is mistyped, revoked, expired or for another environment."
        : `Could not reach Dynatrace: ${err instanceof Error ? err.message : String(err)}`;
    return {
      checks: CAPABILITIES.map<PreflightCapabilityCheck>((c) => ({
        capabilityId: c.id,
        status: "unknown",
        message,
      })),
    };
  }
  const held = new Set(token.scopes ?? []);
  const identity = [token.name, token.owner].filter(Boolean).join(" · ");
  return {
    ...(identity ? { identity } : {}),
    checks: CAPABILITIES.map<PreflightCapabilityCheck>((c) => {
      const missing = c.requiredPermissions.filter((p) => !held.has(p.id));
      if (missing.length === 0) return { capabilityId: c.id, status: "ok" };
      return {
        capabilityId: c.id,
        status: "missing",
        missingPermissions: missing,
        message: `Add ${missing.map((m) => m.id).join(", ")} to the access token.`,
      };
    }),
  };
}
