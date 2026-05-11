import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import { regionOption } from "./regions.js";
import type { GcpCreateContext } from "./create-context.js";

export const firestoreCreateConfigHandlers: Record<
  string,
  (ctx: GcpCreateContext, parentResourceId?: string) => Promise<CreateResourceConfig>
> = {
  "firestore-database": async (ctx, parentResourceId) => {
    return {
      fields: [
        {
          key: "name",
          label: "Database ID",
          kind: "text",
          required: true,
          description: "Database ID (use '(default)' for the default database)",
        },
        {
          key: "databaseEdition",
          label: "Edition",
          kind: "select",
          required: true,
          options: [
            {
              id: "STANDARD",
              label: "Standard — Firestore's simple query engine with automatic indexing",
            },
            {
              id: "ENTERPRISE",
              label: "Enterprise — Firestore Native + MongoDB-compatible data access",
            },
          ],
          defaultValue: "STANDARD",
        },
        {
          key: "locationId",
          label: "Location",
          kind: "region-picker",
          required: true,
          regions: [
            { id: "nam5", label: "United States (nam5)" },
            { id: "eur3", label: "Europe (eur3)" },
            regionOption("us-central1"),
            regionOption("us-east1"),
            regionOption("europe-west1"),
            regionOption("asia-east1"),
          ],
          defaultValue: "nam5",
        },
        {
          key: "type",
          label: "Mode",
          kind: "select",
          required: true,
          description: "Presets that determine how you structure and interact with your data.",
          options: [
            { id: "FIRESTORE_NATIVE", label: "Firestore in Native mode (Firestore SDKs)" },
            {
              id: "DATASTORE_MODE",
              label: "Datastore mode (legacy Datastore compatibility)",
            },
          ],
          defaultValue: "FIRESTORE_NATIVE",
          showWhen: { fieldKey: "databaseEdition", fieldValue: "STANDARD" },
        },
        {
          key: "enterpriseMode",
          label: "Mode",
          kind: "select",
          required: true,
          description: "Presets that determine how you structure and interact with your data.",
          options: [
            {
              id: "mongodb",
              label: "Firestore with MongoDB compatibility",
            },
            {
              id: "native",
              label: "Firestore in Native mode (Firestore SDKs + Pipeline queries)",
            },
          ],
          defaultValue: "mongodb",
          showWhen: { fieldKey: "databaseEdition", fieldValue: "ENTERPRISE" },
        },
      ],
    };
  },
};

export const firestoreCreateResourceHandlers: Record<
  string,
  (
    ctx: GcpCreateContext,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ) => Promise<ResourceInstance>
> = {
  "firestore-database": async (ctx, accountId, fields, parentResourceId) => {
    const p = ctx.project;
    const tok = await ctx.token();
    const name = fields["name"] ?? "";
    const locationId = fields["locationId"] ?? "";
    const databaseEdition = fields["databaseEdition"] ?? "STANDARD";
    // Enterprise is only supported with FIRESTORE_NATIVE; Datastore Mode
    // is a Standard-only option.
    const type =
      databaseEdition === "ENTERPRISE"
        ? "FIRESTORE_NATIVE"
        : (fields["type"] ?? "FIRESTORE_NATIVE");

    const body: Record<string, unknown> = { locationId, type };
    if (databaseEdition === "ENTERPRISE") {
      body["databaseEdition"] = "ENTERPRISE";
      // Enterprise defaults to MongoDB-compatible access mode. If the
      // caller picked Native mode, flip the two access-mode fields.
      if (fields["enterpriseMode"] === "native") {
        body["firestoreDataAccessMode"] = "DATA_ACCESS_MODE_ENABLED";
        body["mongodbCompatibleDataAccessMode"] = "DATA_ACCESS_MODE_DISABLED";
      }
    }

    const res = await fetch(
      `https://firestore.googleapis.com/v1/projects/${p}/databases?databaseId=${name}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) throw new Error(`Firestore API ${res.status}: ${await res.text()}`);
    const now = ctx.now();
    return {
      id: ctx.id(accountId, "firestore-database", `${p}/${name}`),
      pluginId: "gcp",
      resourceTypeId: "firestore-database",
      accountId,
      displayName: name === "(default)" ? `${p} (default)` : name,
      fields: {
        name,
        locationId,
        type,
        databaseEdition,
        concurrencyMode: "",
        state: "CREATING",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: name,
      createdAt: now,
      updatedAt: now,
    };
  },
};
