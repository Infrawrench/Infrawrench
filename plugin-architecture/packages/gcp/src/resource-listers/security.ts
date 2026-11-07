import { reportUnreadListPart, type ResourceInstance } from "@infrawrench/plugin-base";
import { isApiDisabled, readEachParent, readEachRegion, type ListerContext } from "./shared.js";

export async function listServiceAccounts(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const items = await ctx.paginate<Record<string, unknown>>(
    `https://iam.googleapis.com/v1/projects/${p}/serviceAccounts`,
    "accounts",
  );
  return items.map((sa) => {
    const email = String(sa["email"]);
    return {
      id: ctx.id(accountId, "gcp-service-account", email),
      pluginId: "gcp",
      resourceTypeId: "gcp-service-account",
      accountId,
      displayName: String(sa["displayName"] ?? email.split("@")[0] ?? email),
      fields: {
        name: String(sa["name"]).split("/").pop() ?? "",
        email,
        displayName: String(sa["displayName"] ?? ""),
        disabled: Boolean(sa["disabled"]),
        description: String(sa["description"] ?? ""),
      },
      resolvedOutputs: { email },
      secretStates: [],
      externalId: email,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listCloudArmorPolicies(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const items = await ctx.paginate<Record<string, unknown>>(
    `https://compute.googleapis.com/compute/v1/projects/${p}/global/securityPolicies`,
    "items",
  );
  return items.map((policy) => {
    const name = String(policy["name"]);
    const rules = policy["rules"] as unknown[] | undefined;
    return {
      id: ctx.id(accountId, "cloud-armor-policy", `${p}/${name}`),
      pluginId: "gcp",
      resourceTypeId: "cloud-armor-policy",
      accountId,
      displayName: name,
      fields: {
        name,
        description: String(policy["description"] ?? ""),
        type: String(policy["type"] ?? "CLOUD_ARMOR"),
        ruleCount: rules?.length ?? 0,
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: `${p}/${name}`,
      createdAt: String(policy["creationTimestamp"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listSecretManagerSecrets(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const items = await ctx.paginate<Record<string, unknown>>(
    `https://secretmanager.googleapis.com/v1/projects/${p}/secrets`,
    "secrets",
  );
  return items.map((secret) => {
    const fullName = String(secret["name"]);
    const name = fullName.split("/").pop() ?? "";
    const replication = secret["replication"] as Record<string, unknown> | undefined;
    const replicationType = replication?.["automatic"]
      ? "automatic"
      : replication?.["userManaged"]
        ? "user-managed"
        : "unknown";
    return {
      id: ctx.id(accountId, "secret-manager-secret", fullName),
      pluginId: "gcp",
      resourceTypeId: "secret-manager-secret",
      accountId,
      displayName: name,
      fields: {
        name,
        replicationType,
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: fullName,
      createdAt: String(secret["createTime"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

/** No locations while the KMS API is off, whose stored rows `idPrefix` keeps meanwhile. */
async function listKmsLocations(
  ctx: ListerContext,
  p: string,
  idPrefix: string,
): Promise<Array<{ name: string; locationId: string }>> {
  try {
    return await ctx.paginate(
      `https://cloudkms.googleapis.com/v1/projects/${p}/locations`,
      "locations",
    );
  } catch (err) {
    if (!isApiDisabled(err) || !reportUnreadListPart({ idPrefixes: [idPrefix] })) throw err;
    return [];
  }
}

export async function listKmsKeyRings(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const locations = await listKmsLocations(ctx, p, ctx.id(accountId, "kms-key-ring", ""));
  return readEachRegion(
    locations,
    async (loc) => {
      const items = await ctx.paginate<Record<string, unknown>>(
        `https://cloudkms.googleapis.com/v1/${loc.name}/keyRings`,
        "keyRings",
      );
      return items.map((kr) => {
        const fullName = String(kr["name"]);
        const name = fullName.split("/").pop() ?? "";
        return {
          id: ctx.id(accountId, "kms-key-ring", fullName),
          pluginId: "gcp",
          resourceTypeId: "kms-key-ring",
          accountId,
          displayName: name,
          fields: {
            name,
            location: loc.locationId,
            keyCount: 0,
          },
          resolvedOutputs: {},
          secretStates: [],
          externalId: fullName,
          createdAt: String(kr["createTime"] ?? ctx.now()),
          updatedAt: ctx.now(),
        };
      });
    },
    {
      unread: (loc) => ({ idPrefixes: [ctx.id(accountId, "kms-key-ring", `${loc.name}/`)] }),
    },
  );
}

export async function listKmsKeys(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const locations = await listKmsLocations(ctx, p, ctx.id(accountId, "kms-key", ""));
  return readEachRegion(
    locations,
    async (loc) => {
      const keyRings = await ctx.paginate<Record<string, unknown>>(
        `https://cloudkms.googleapis.com/v1/${loc.name}/keyRings`,
        "keyRings",
      );
      return readEachParent(
        keyRings.map((kr) => String(kr["name"])),
        async (krName) => {
          const krShort = krName.split("/").pop() ?? "";
          const keys = await ctx.paginate<Record<string, unknown>>(
            `https://cloudkms.googleapis.com/v1/${krName}/cryptoKeys`,
            "cryptoKeys",
          );
          return keys.map((key) => {
            const fullName = String(key["name"]);
            const keyName = fullName.split("/").pop() ?? "";
            const primary = key["primary"] as Record<string, unknown> | undefined;
            return {
              id: ctx.id(accountId, "kms-key", fullName),
              pluginId: "gcp",
              resourceTypeId: "kms-key",
              accountId,
              displayName: keyName,
              fields: {
                name: keyName,
                keyRing: krShort,
                location: loc.locationId,
                purpose: String(key["purpose"] ?? ""),
                algorithm: String(primary?.["algorithm"] ?? ""),
                protectionLevel: String(primary?.["protectionLevel"] ?? ""),
                state: String(primary?.["state"] ?? ""),
                rotationPeriod: String(key["rotationPeriod"] ?? ""),
              },
              resolvedOutputs: {},
              secretStates: [],
              externalId: fullName,
              parentResourceId: ctx.id(accountId, "kms-key-ring", krName),
              createdAt: String(key["createTime"] ?? ctx.now()),
              updatedAt: ctx.now(),
            };
          });
        },
        {
          sequential: true,
          unread: (krName) => ({
            parentResourceIds: [ctx.id(accountId, "kms-key-ring", krName)],
          }),
        },
      );
    },
    {
      unread: (loc) => ({ idPrefixes: [ctx.id(accountId, "kms-key", `${loc.name}/`)] }),
    },
  );
}
