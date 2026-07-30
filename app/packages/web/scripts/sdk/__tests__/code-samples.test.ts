import { describe, it, expect } from "vitest";
import { buildSdkIr } from "../ir";
import { injectSdkCodeSamples, renderCodeSamples } from "../code-samples";
import type { SdkIr } from "../types";

/**
 * A miniature spec exercising every call shape the renderer distinguishes:
 * a path-parameter call, a nested namespace with enum-typed parameters and a
 * body, an all-optional list, an unscoped no-parameter call, and one internal
 * operation that must not get samples.
 */
function miniSpec() {
  const orgParam = {
    name: "orgId",
    in: "path",
    required: true,
    schema: { type: "string", description: "Organization id" },
  };
  const json = (schema: unknown) => ({ content: { "application/json": { schema } } });

  return {
    openapi: "3.1.0",
    info: { title: "Test API", version: "1.2.3" },
    servers: [{ url: "https://api.test" }],
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
      schemas: {
        Thing: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          additionalProperties: false,
        },
        PluginId: { type: "string", enum: ["aws", "gcp"] },
      },
    },
    paths: {
      "/api/org/{orgId}/accounts": {
        get: {
          operationId: "getOrgAccounts",
          parameters: [orgParam],
          responses: {
            "200": json({ type: "array", items: { $ref: "#/components/schemas/Thing" } }),
          },
        },
      },
      "/api/org/{orgId}/accounts/{id}/sync": {
        post: {
          operationId: "postOrgAccountsIdSync",
          parameters: [
            orgParam,
            { name: "id", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: { "200": json({ $ref: "#/components/schemas/Thing" }) },
        },
      },
      "/api/org/{orgId}/resources/{pluginId}/secret-versions/add": {
        post: {
          operationId: "postOrgResourcesPluginIdSecretVersionsAdd",
          parameters: [
            orgParam,
            {
              name: "pluginId",
              in: "path",
              required: true,
              schema: { $ref: "#/components/schemas/PluginId" },
            },
          ],
          requestBody: { required: true, content: { "application/json": { schema: {} } } },
          responses: { "200": json({ $ref: "#/components/schemas/Thing" }) },
        },
      },
      "/api/profile": {
        get: {
          operationId: "getProfile",
          responses: { "200": json({ $ref: "#/components/schemas/Thing" }) },
        },
      },
      "/api/admin/orgs": {
        get: {
          operationId: "getAdminOrgs",
          "x-internal": true,
          responses: {
            "200": json({ type: "array", items: { $ref: "#/components/schemas/Thing" } }),
          },
        },
      },
    },
  };
}

function opByName(ir: SdkIr, dotted: string) {
  const op = ir.operations.find((o) => [...o.namespace, o.name].join(".") === dotted);
  if (!op) throw new Error(`no operation ${dotted}`);
  return op;
}

function sample(ir: SdkIr, dotted: string, lang: string): string {
  const samples = renderCodeSamples(opByName(ir, dotted), ir);
  const found = samples.find((s) => s.lang === lang);
  if (!found) throw new Error(`no ${lang} sample`);
  return found.source;
}

describe("renderCodeSamples", () => {
  const ir = buildSdkIr(miniSpec());

  it("renders every language exactly once", () => {
    const samples = renderCodeSamples(opByName(ir, "accounts.sync"), ir);
    expect(samples.map((s) => s.lang)).toEqual([
      "typescript",
      "python",
      "ruby",
      "go",
      "java",
      "csharp",
      "php",
      "swift",
      "rust",
    ]);
    for (const s of samples) expect(s.source).toContain("<api-key>");
  });

  it("renders a path-parameter call per language convention", () => {
    expect(sample(ir, "accounts.sync", "typescript")).toContain(
      'await client.accounts.sync({ id: "<id>" })',
    );
    expect(sample(ir, "accounts.sync", "python")).toContain('client.accounts.sync(id="<id>")');
    expect(sample(ir, "accounts.sync", "ruby")).toContain('client.accounts.sync(id: "<id>")');
    expect(sample(ir, "accounts.sync", "go")).toContain(
      'client.Accounts.Sync(ctx, infrawrench.AccountsSyncParams{ID: "<id>"})',
    );
    expect(sample(ir, "accounts.sync", "java")).toContain('client.accounts().sync("<id>")');
    expect(sample(ir, "accounts.sync", "csharp")).toContain('client.Accounts.SyncAsync("<id>")');
    expect(sample(ir, "accounts.sync", "php")).toContain("$client->accounts->sync(id: '<id>')");
    expect(sample(ir, "accounts.sync", "swift")).toContain(
      'try await client.accounts.sync(id: "<id>")',
    );
    expect(sample(ir, "accounts.sync", "rust")).toContain(
      'client.accounts().sync(AccountsSyncParams::new("<id>")).await?',
    );
  });

  it("spells enum parameters in each language's enum idiom and elides bodies", () => {
    const dotted = "resources.secretVersions.add";
    expect(sample(ir, dotted, "typescript")).toContain(
      'client.resources.secretVersions.add({ pluginId: "aws", body: { /* … */ } })',
    );
    expect(sample(ir, dotted, "python")).toContain(
      'client.resources.secret_versions.add(plugin_id="aws", body={...})',
    );
    expect(sample(ir, dotted, "go")).toContain(
      'client.Resources.SecretVersions.Add(ctx, infrawrench.ResourcesSecretVersionsAddParams{PluginID: "aws", Body: …})',
    );
    expect(sample(ir, dotted, "java")).toContain(
      'client.resources().secretVersions().add("aws", …)',
    );
    expect(sample(ir, dotted, "swift")).toContain(
      "client.resources.secretVersions.add(pluginId: .aws, body: …)",
    );
    expect(sample(ir, dotted, "rust")).toContain(
      "client.resources().secret_versions().add(ResourcesSecretVersionsAddParams::new(PluginId::Aws, …)).await?",
    );
  });

  it("renders all-optional and no-parameter calls the way each SDK signs them", () => {
    // Org-scoped, everything optional: Go takes nil, Rust an empty Params.
    expect(sample(ir, "accounts.list", "typescript")).toContain("client.accounts.list()");
    expect(sample(ir, "accounts.list", "go")).toContain("client.Accounts.List(ctx, nil)");
    expect(sample(ir, "accounts.list", "rust")).toContain(
      "client.accounts().list(AccountsListParams::new()).await?",
    );
    expect(sample(ir, "accounts.list", "ruby")).toContain("result = client.accounts.list");

    // Unscoped and parameterless: no params argument anywhere, no orgId in the init.
    const goProfile = sample(ir, "profile.get", "go");
    expect(goProfile).toContain("client.Profile.Get(ctx)");
    expect(goProfile).not.toContain("WithOrgID");
    expect(sample(ir, "profile.get", "rust")).toContain("client.profile().get().await?");
    expect(sample(ir, "profile.get", "python")).not.toContain("org_id");
  });
});

describe("injectSdkCodeSamples", () => {
  it("attaches samples to published operations and skips internal ones", () => {
    const doc = miniSpec() as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    injectSdkCodeSamples(doc);

    const sync = doc.paths["/api/org/{orgId}/accounts/{id}/sync"]!["post"]!;
    const samples = sync["x-codeSamples"] as Array<{ lang: string; label: string; source: string }>;
    expect(samples).toHaveLength(9);
    expect(samples[0]).toMatchObject({ lang: "typescript", label: "TypeScript" });

    const admin = doc.paths["/api/admin/orgs"]!["get"]!;
    expect(admin["x-codeSamples"]).toBeUndefined();
  });
});
