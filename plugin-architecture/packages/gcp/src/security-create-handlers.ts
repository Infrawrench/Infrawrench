import type {
  CreateResourceConfig,
  PolicyOption,
  ResourceInstance,
} from "@infrawrench/plugin-base";
import { formatGcpError } from "./utils.js";
import { regionOption } from "./regions.js";
import type { GcpCreateContext } from "./create-context.js";

export const securityCreateConfigHandlers: Record<
  string,
  (ctx: GcpCreateContext, parentResourceId?: string) => Promise<CreateResourceConfig>
> = {
  "secret-manager-secret": async (ctx, parentResourceId) => {
    return {
      fields: [
        {
          key: "name",
          label: "Secret Name",
          kind: "text",
          required: true,
          description: "Secret ID (letters, numbers, hyphens, underscores)",
        },
        {
          key: "initialValue",
          label: "Initial Value",
          kind: "text",
          required: false,
          description: "If set, a first enabled version is added with this value.",
        },
      ],
    };
  },
  "kms-key-ring": async (ctx, parentResourceId) => {
    return {
      fields: [
        {
          key: "name",
          label: "Key Ring Name",
          kind: "text",
          required: true,
        },
        {
          key: "location",
          label: "Location",
          kind: "region-picker",
          required: true,
          regions: [
            { id: "global", label: "Global" },
            regionOption("us-central1"),
            regionOption("us-east1"),
            regionOption("us-west1"),
            regionOption("europe-west1"),
            regionOption("europe-west4"),
            regionOption("asia-east1"),
          ],
          defaultValue: "global",
        },
      ],
    };
  },
  "kms-key": async (ctx, parentResourceId) => {
    const hasParent = !!parentResourceId;
    const fields: CreateResourceConfig["fields"] = [
      {
        key: "name",
        label: "Key Name",
        kind: "text",
        required: true,
      },
    ];
    if (!hasParent) {
      fields.push(
        {
          key: "keyRingLocation",
          label: "Key Ring Location",
          kind: "select",
          required: true,
          options: [
            { id: "global", label: "Global" },
            { id: "us-central1", label: "Iowa (us-central1)" },
            { id: "us-east1", label: "South Carolina (us-east1)" },
            { id: "us-west1", label: "Oregon (us-west1)" },
            { id: "europe-west1", label: "Belgium (europe-west1)" },
            { id: "europe-west4", label: "Netherlands (europe-west4)" },
            { id: "asia-east1", label: "Taiwan (asia-east1)" },
          ],
          defaultValue: "global",
        },
        {
          key: "keyRing",
          label: "Key Ring Name",
          kind: "text",
          required: true,
          description: "The name of the key ring to create this key in",
        },
      );
    }
    fields.push(
      {
        key: "purpose",
        label: "Purpose",
        kind: "select",
        required: true,
        options: [
          { id: "ENCRYPT_DECRYPT", label: "Symmetric encrypt/decrypt" },
          { id: "ASYMMETRIC_SIGN", label: "Asymmetric sign" },
          { id: "ASYMMETRIC_DECRYPT", label: "Asymmetric decrypt" },
        ],
        defaultValue: "ENCRYPT_DECRYPT",
      },
      {
        key: "protectionLevel",
        label: "Protection Level",
        kind: "select",
        required: true,
        options: [
          { id: "SOFTWARE", label: "Software" },
          { id: "HSM", label: "HSM" },
        ],
        defaultValue: "SOFTWARE",
      },
    );
    return { fields };
  },
  "gcp-service-account": async (ctx, parentResourceId) => {
    const p = ctx.project;
    const [predefined, custom] = await Promise.all([
      ctx
        .paginate<Record<string, unknown>>("https://iam.googleapis.com/v1/roles", "roles", {
          view: "BASIC",
          pageSize: "1000",
        })
        .catch(() => []),
      ctx
        .paginate<
          Record<string, unknown>
        >(`https://iam.googleapis.com/v1/projects/${p}/roles`, "roles", { view: "BASIC", pageSize: "1000" })
        .catch(() => []),
    ]);
    const toOption = (r: Record<string, unknown>, category: string): PolicyOption => {
      const name = String(r["name"] ?? "");
      const title = r["title"] ? String(r["title"]) : name;
      const desc = r["description"] ? String(r["description"]) : undefined;
      const stage = r["stage"] ? String(r["stage"]) : undefined;
      const option: PolicyOption = { id: name, label: title, category };
      if (desc) option.description = desc;
      if (stage && stage !== "GA") option.badge = stage;
      return option;
    };
    const policies: PolicyOption[] = [
      ...predefined
        .filter((r) => String(r["stage"] ?? "GA") !== "DEPRECATED")
        .map((r) => toOption(r, "Predefined")),
      ...custom.map((r) => toOption(r, "Custom")),
    ];
    policies.sort((a, b) => a.label.localeCompare(b.label));
    return {
      fields: [
        {
          key: "accountId",
          label: "Account ID",
          kind: "text",
          required: true,
          description:
            "Unique ID for the service account (6-30 characters, lowercase letters, digits, hyphens)",
        },
        {
          key: "displayName",
          label: "Display Name",
          kind: "text",
          required: false,
          description: "A user-friendly name for this service account",
        },
        {
          key: "grantedRoles",
          label: "Granted Roles",
          kind: "policy-picker",
          required: false,
          description: "Project-level IAM roles to grant this service account",
          policies,
        },
      ],
    };
  },
};

export const securityCreateResourceHandlers: Record<
  string,
  (
    ctx: GcpCreateContext,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ) => Promise<ResourceInstance>
> = {
  "secret-manager-secret": async (ctx, accountId, fields, parentResourceId) => {
    const p = ctx.project;
    const tok = await ctx.token();
    const name = fields["name"] ?? "";
    const initialValue = fields["initialValue"] ?? "";

    const res = await fetch(
      `https://secretmanager.googleapis.com/v1/projects/${p}/secrets?secretId=${name}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({ replication: { automatic: {} } }),
      },
    );
    if (!res.ok) throw new Error(`Secret Manager API ${res.status}: ${await res.text()}`);
    const secretName = `projects/${p}/secrets/${name}`;
    let versionCount = 0;
    if (initialValue) {
      const addRes = await fetch(
        `https://secretmanager.googleapis.com/v1/${secretName}:addVersion`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            payload: { data: btoa(unescape(encodeURIComponent(initialValue))) },
          }),
        },
      );
      if (!addRes.ok)
        throw new Error(`Secret Manager API ${addRes.status}: ${await addRes.text()}`);
      versionCount = 1;
    }
    const now = ctx.now();
    return {
      id: ctx.id(accountId, "secret-manager-secret", secretName),
      pluginId: "gcp",
      resourceTypeId: "secret-manager-secret",
      accountId,
      displayName: name,
      fields: { name, replicationType: "AUTOMATIC", versionCount },
      resolvedOutputs: {},
      secretStates: [],
      externalId: secretName,
      createdAt: now,
      updatedAt: now,
    };
  },
  "kms-key-ring": async (ctx, accountId, fields, parentResourceId) => {
    const p = ctx.project;
    const tok = await ctx.token();
    const name = fields["name"] ?? "";
    const location = fields["location"] ?? "";

    const res = await fetch(
      `https://cloudkms.googleapis.com/v1/projects/${p}/locations/${location}/keyRings?keyRingId=${name}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    if (!res.ok) throw new Error(`KMS API ${res.status}: ${await res.text()}`);
    const now = ctx.now();
    const fullName = `projects/${p}/locations/${location}/keyRings/${name}`;
    return {
      id: ctx.id(accountId, "kms-key-ring", fullName),
      pluginId: "gcp",
      resourceTypeId: "kms-key-ring",
      accountId,
      displayName: name,
      fields: {
        name,
        location,
        keyCount: 0,
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: fullName,
      createdAt: now,
      updatedAt: now,
    };
  },
  "kms-key": async (ctx, accountId, fields, parentResourceId) => {
    const p = ctx.project;
    const tok = await ctx.token();
    const name = fields["name"] ?? "";
    // When created from a key ring's detail page, keyRing and keyRingLocation
    // fields are hidden — recover them from the parent key ring's externalId
    // (format: `projects/{p}/locations/{location}/keyRings/{name}`).
    const parentExternalId = parentResourceId ? parentResourceId.split(":").slice(2).join(":") : "";
    const parentMatch = parentExternalId.match(
      /^projects\/[^/]+\/locations\/([^/]+)\/keyRings\/([^/]+)$/,
    );
    const keyRing = fields["keyRing"] || (parentMatch?.[2] ?? "");
    const keyRingLocation = fields["keyRingLocation"] || (parentMatch?.[1] ?? "global");
    const purpose = fields["purpose"] ?? "ENCRYPT_DECRYPT";
    const protectionLevel = fields["protectionLevel"] ?? "SOFTWARE";
    if (!keyRing) throw new Error("KMS key creation requires a key ring");

    const algorithm =
      purpose === "ASYMMETRIC_SIGN"
        ? "RSA_SIGN_PSS_2048_SHA256"
        : purpose === "ASYMMETRIC_DECRYPT"
          ? "RSA_DECRYPT_OAEP_2048_SHA256"
          : "GOOGLE_SYMMETRIC_ENCRYPTION";

    const res = await fetch(
      `https://cloudkms.googleapis.com/v1/projects/${p}/locations/${keyRingLocation}/keyRings/${keyRing}/cryptoKeys?cryptoKeyId=${name}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          purpose,
          versionTemplate: { protectionLevel, algorithm },
        }),
      },
    );
    if (!res.ok) throw new Error(`KMS API ${res.status}: ${await res.text()}`);
    const now = ctx.now();
    const fullName = `projects/${p}/locations/${keyRingLocation}/keyRings/${keyRing}/cryptoKeys/${name}`;
    return {
      id: ctx.id(accountId, "kms-key", fullName),
      pluginId: "gcp",
      resourceTypeId: "kms-key",
      accountId,
      displayName: name,
      fields: {
        name,
        keyRing,
        location: keyRingLocation,
        purpose,
        algorithm,
        protectionLevel,
        state: "ENABLED",
        rotationPeriod: "",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: fullName,
      parentResourceId: ctx.id(
        accountId,
        "kms-key-ring",
        `projects/${p}/locations/${keyRingLocation}/keyRings/${keyRing}`,
      ),
      createdAt: now,
      updatedAt: now,
    };
  },
  "gcp-service-account": async (ctx, accountId, fields, parentResourceId) => {
    const p = ctx.project;
    const tok = await ctx.token();
    const accountIdField = fields["accountId"] ?? "";
    const displayName = fields["displayName"] ?? "";

    const res = await fetch(`https://iam.googleapis.com/v1/projects/${p}/serviceAccounts`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        accountId: accountIdField,
        serviceAccount: { displayName },
      }),
    });
    if (!res.ok) throw new Error(await formatGcpError("Create service account", res));
    const data = (await res.json()) as Record<string, unknown>;
    const email = String(data["email"] ?? `${accountIdField}@${p}.iam.gserviceaccount.com`);

    const grantedRoles = ((): string[] => {
      const raw = fields["grantedRoles"];
      if (!raw) return [];
      try {
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
      } catch {
        return [];
      }
    })();

    if (grantedRoles.length > 0) {
      const crmBase = `https://cloudresourcemanager.googleapis.com/v1/projects/${p}`;
      const getRes = await fetch(`${crmBase}:getIamPolicy`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({ options: { requestedPolicyVersion: 3 } }),
      });
      if (!getRes.ok) {
        throw new Error(await formatGcpError("Read project IAM policy", getRes));
      }
      const policy = (await getRes.json()) as {
        bindings?: Array<{ role: string; members: string[]; condition?: unknown }>;
        etag?: string;
        version?: number;
      };
      const member = `serviceAccount:${email}`;
      const bindings = policy.bindings ?? [];
      for (const role of grantedRoles) {
        const existing = bindings.find((b) => b.role === role && !b.condition);
        if (existing) {
          if (!existing.members.includes(member)) existing.members.push(member);
        } else {
          bindings.push({ role, members: [member] });
        }
      }
      const setRes = await fetch(`${crmBase}:setIamPolicy`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          policy: { ...policy, bindings },
        }),
      });
      if (!setRes.ok) {
        throw new Error(await formatGcpError("Grant IAM roles", setRes));
      }
    }

    const now = ctx.now();
    return {
      id: ctx.id(accountId, "gcp-service-account", email),
      pluginId: "gcp",
      resourceTypeId: "gcp-service-account",
      accountId,
      displayName: displayName || accountIdField,
      fields: {
        name: accountIdField,
        email,
        displayName,
        disabled: false,
        description: "",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: email,
      createdAt: now,
      updatedAt: now,
    };
  },
};
