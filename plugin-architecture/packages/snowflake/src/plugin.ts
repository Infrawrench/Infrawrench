import type {
  CredentialField,
  CredentialFieldOption,
  HostServices,
  Plugin,
  PluginManifest,
} from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { parseAccount } from "./account.js";
import type { SnowflakeContext } from "./api.js";
import { isNotAuthorized, runSql, str } from "./api.js";
import { SnowflakeAuth, parseCredential } from "./auth.js";
import { DEFAULT_RATES, RATE_KEYS } from "./catalog.js";
import { SnowflakeClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { snowflakeTerraformExport } from "./terraform.js";

const PRICING_LINK = {
  label: "Snowflake pricing",
  url: "https://www.snowflake.com/en/pricing-options/",
};

function rateField(
  key: string,
  label: string,
  description: string,
  defaultValue?: string,
): CredentialField {
  return {
    key,
    label,
    description,
    sensitive: false,
    optional: true,
    ...(defaultValue !== undefined ? { defaultValue } : { placeholder: "Not estimated" }),
    helpLink: PRICING_LINK,
  };
}

const CREDENTIAL_DEPS = ["account", "user", "credential"];

const manifest: PluginManifest = {
  id: "snowflake",
  version: "0.1.0",
  displayName: "Snowflake",
  description:
    "Data cloud. Track Snowflake spend by service and warehouse (billed when the role can read organization usage, estimated from credits otherwise), the remaining capacity balance, and query cost by tag, user and role; manage warehouses, databases, schemas, resource monitors, users, roles, tasks, pipes and dynamic tables, and run SQL.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "account",
      label: "Account",
      description:
        "Your account identifier (orgname-accountname) or any Snowflake URL for the account: the Snowsight address (app.snowflake.com/<org>/<account>) or the account URL (<org>-<account>.snowflakecomputing.com). Find it under your name, Account, View account details.",
      sensitive: false,
      placeholder: "myorg-myaccount",
    },
    {
      key: "user",
      label: "User",
      description:
        "The Snowflake user to connect as. A dedicated service user (TYPE = SERVICE) is best.",
      sensitive: false,
      placeholder: "INFRAWRENCH",
    },
    {
      key: "credential",
      label: "Private Key or Access Token",
      description:
        "Either the user's unencrypted RSA private key in PEM form (key-pair authentication: register the public key with ALTER USER ... SET RSA_PUBLIC_KEY), or a programmatic access token. Access tokens need the user to be covered by a network policy unless an authentication policy relaxes that.",
      sensitive: true,
      multiline: true,
      placeholder: "-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----",
      helpLink: {
        label: "Key-pair authentication",
        url: "https://docs.snowflake.com/en/user-guide/key-pair-auth",
      },
    },
    {
      key: "role",
      label: "Role",
      description:
        "The role queries run as. Cost and usage need the SNOWFLAKE database role USAGE_VIEWER (or IMPORTED PRIVILEGES on SNOWFLAKE); billed cost and the capacity balance need the organization usage views (ORGADMIN or GLOBALORGADMIN).",
      sensitive: false,
      optional: true,
      providerOptions: { dependsOn: CREDENTIAL_DEPS, emptyLabel: "The user's default role" },
    },
    {
      key: "warehouse",
      label: "Warehouse",
      description:
        "Where usage and cost queries run. An X-Small warehouse with a 60 second auto-suspend is plenty; listing resources never resumes it.",
      sensitive: false,
      optional: true,
      providerOptions: { dependsOn: CREDENTIAL_DEPS, emptyLabel: "The user's default warehouse" },
    },
    rateField(
      RATE_KEYS.creditPrice,
      "Price per Credit",
      "Used only when the role cannot read organization usage. List price on AWS US East is 2.00 (Standard), 3.00 (Enterprise) or 4.00 (Business Critical) USD; enter your contract rate.",
      DEFAULT_RATES.creditPrice,
    ),
    rateField(
      RATE_KEYS.storagePerTb,
      "Storage Price per TB-Month",
      "Used only for estimated cost. 23.00 USD on a capacity contract in AWS US East; on-demand is higher.",
      DEFAULT_RATES.storagePerTb,
    ),
    rateField(
      RATE_KEYS.transferPerTb,
      "Data Transfer Price per TB",
      "Used only for estimated cost. Snowflake prices egress per cloud and region pair, so transfer is left out of estimates until you enter a rate.",
    ),
    rateField(
      RATE_KEYS.currency,
      "Price Currency",
      "Currency of the prices above (ISO code). Billed cost uses your contract currency regardless.",
      DEFAULT_RATES.currency,
    ),
    caCertCredentialField,
  ],
  costs: {
    // Billed from ORGANIZATION_USAGE when visible, else credits × the price
    // above (see cost-data.ts); service group, region, warehouse as
    // resource, and serviceType / balanceSource / costBasis tags.
    dimensions: ["service", "region", "resource", "tag"],
    maxHistoryDays: 365,
    // Organization usage lags up to 72 hours and restates until month end.
    restatementDays: 35,
    chargeTypes: true,
    // Decided per account at collection time; every row carries costBasis.
    estimated: true,
  },
  credits: {
    label: "Capacity balance",
    requiresElevatedCredential: true,
  },
  quotas: {
    label: "Resource monitors",
    partial: true,
    requiresElevatedCredential: true,
  },
  statusFeed,
  rateLimit: { capacity: 10, refillPerSecond: 2 },
};

/**
 * Role and warehouse pickers, filled from the half-entered form. Roles are
 * the ones granted to the user (CURRENT_AVAILABLE_ROLES); warehouses are the
 * ones visible to the role picked so far. Both are metadata reads that never
 * resume a warehouse.
 */
async function listCredentialOptions(
  fieldKey: string,
  credentials: Record<string, string>,
  services?: HostServices,
): Promise<CredentialFieldOption[]> {
  if (fieldKey !== "role" && fieldKey !== "warehouse") return [];
  const account = parseAccount(credentials["account"] ?? "");
  const user = (credentials["user"] ?? "").trim();
  if (!user) throw new Error("Enter the user first.");
  const credential = parseCredential(credentials["credential"] ?? "");
  const caCert = credentials["caCert"] ?? "";
  const role = (credentials["role"] ?? "").trim();
  const ctx: SnowflakeContext = {
    account,
    auth: new SnowflakeAuth(credential, account.jwtAccount, user),
    ...(fieldKey === "warehouse" && role ? { role } : {}),
    ...(caCert ? { caCert } : {}),
    ...(services?.http ? { http: services.http } : {}),
  };
  try {
    if (fieldKey === "role") {
      const res = await runSql(ctx, "SELECT CURRENT_AVAILABLE_ROLES() AS ROLES");
      const roles = JSON.parse(str(res.rows[0]?.["roles"]) || "[]") as string[];
      return roles.sort().map((r) => ({ id: r, label: r }));
    }
    const res = await runSql(ctx, "SHOW WAREHOUSES");
    return res.rows.map((w) => ({
      id: str(w["name"]),
      label: str(w["name"]),
      description: `${str(w["size"])}, ${str(w["state"]).toLowerCase()}`,
    }));
  } catch (err) {
    if (isNotAuthorized(err)) {
      throw new Error(
        `Snowflake rejected the connection to ${account.display}. Check the account identifier, that the user is spelled as in Snowflake, and that the public key is registered (or the token is valid).`,
      );
    }
    throw err;
  }
}

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new SnowflakeClient(credentials, services),
  parseStatusFeed,
  terraformExport: snowflakeTerraformExport,
  listCredentialOptions,
};
