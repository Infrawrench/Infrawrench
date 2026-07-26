import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildSdkIr } from "../ir";
import { SDK_TARGETS } from "../targets/index";
import { typescriptTarget } from "../targets/typescript/index";

/**
 * A miniature spec shaped like the real one — org-scoped paths, a collection
 * that is also a namespace, a path that ends in a parameter, a multipart
 * upload, a binary download, and one internal operation that must not survive.
 */
function miniSpec() {
  const orgParam = {
    name: "orgId",
    in: "path",
    required: true,
    schema: { type: "string", description: "Organization id" },
  };
  const idParam = { name: "id", in: "path", required: true, schema: { type: "string" } };
  const json = (schema: unknown) => ({ content: { "application/json": { schema } } });

  return {
    openapi: "3.1.0",
    info: { title: "Test API", version: "1.2.3" },
    servers: [{ url: "https://api.test" }, { url: "http://localhost:3000" }],
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
      schemas: {
        Thing: {
          type: "object",
          properties: { id: { type: "string" }, note: { type: ["string", "null"] } },
          required: ["id"],
          additionalProperties: false,
        },
        // Collides with the global `Error` the runtime extends.
        Error: {
          type: "object",
          properties: { error: { type: "string" } },
          required: ["error"],
          additionalProperties: false,
        },
      },
    },
    paths: {
      "/api/org/{orgId}/things": {
        get: {
          operationId: "getOrgThings",
          parameters: [orgParam],
          responses: {
            "200": json({ type: "array", items: { $ref: "#/components/schemas/Thing" } }),
          },
        },
        post: {
          operationId: "postOrgThings",
          parameters: [orgParam],
          requestBody: { required: true, content: { "application/json": { schema: {} } } },
          responses: { "200": json({ $ref: "#/components/schemas/Thing" }) },
        },
      },
      "/api/org/{orgId}/things/{id}": {
        delete: {
          operationId: "deleteOrgThingsId",
          parameters: [orgParam, idParam],
          responses: {
            "204": { description: "Gone" },
            // Referenced so `Error` survives the unreachable-component prune.
            "404": { description: "Not found", ...json({ $ref: "#/components/schemas/Error" }) },
          },
        },
      },
      "/api/org/{orgId}/things/{id}/sync": {
        post: {
          operationId: "postOrgThingsIdSync",
          parameters: [orgParam, idParam],
          responses: { "200": json({ $ref: "#/components/schemas/Thing" }) },
        },
      },
      // Both methods want the name `creds`, so both get pushed into it.
      "/api/org/{orgId}/things/{id}/creds": {
        get: {
          operationId: "getOrgThingsIdCreds",
          parameters: [orgParam, idParam],
          responses: { "200": json({ type: "object", additionalProperties: { type: "string" } }) },
        },
        put: {
          operationId: "putOrgThingsIdCreds",
          parameters: [orgParam, idParam],
          requestBody: { required: true, content: { "application/json": { schema: {} } } },
          responses: { "200": json({ $ref: "#/components/schemas/Thing" }) },
        },
      },
      // `widgets` is a namespace because of the `{id}` route below it, so the
      // collection GET has to move inside it rather than shadow it.
      "/api/org/{orgId}/deep/widgets": {
        get: {
          operationId: "getOrgDeepWidgets",
          parameters: [orgParam],
          responses: {
            "200": json({ type: "array", items: { $ref: "#/components/schemas/Thing" } }),
          },
        },
      },
      "/api/org/{orgId}/deep/widgets/{id}": {
        patch: {
          operationId: "patchOrgDeepWidgetsId",
          parameters: [orgParam, idParam],
          requestBody: { required: true, content: { "application/json": { schema: {} } } },
          responses: { "200": json({ $ref: "#/components/schemas/Thing" }) },
        },
      },
      "/api/org/{orgId}/v1/files/upload": {
        post: {
          operationId: "postOrgFilesUpload",
          parameters: [orgParam],
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  properties: { file: { type: "string", format: "binary" } },
                  required: ["file"],
                  additionalProperties: false,
                },
              },
            },
          },
          responses: { "200": json({ $ref: "#/components/schemas/Thing" }) },
        },
      },
      "/api/org/{orgId}/v1/files/download": {
        get: {
          operationId: "getOrgFilesDownload",
          parameters: [
            orgParam,
            { name: "key", in: "query", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": {
              content: {
                "application/octet-stream": { schema: { type: "string", format: "binary" } },
              },
            },
          },
        },
      },
      "/api/admin/secrets": {
        get: {
          operationId: "getAdminSecrets",
          "x-internal": true,
          responses: { "200": json({ type: "array", items: { type: "string" } }) },
        },
      },
    },
  };
}

function names(ir: ReturnType<typeof buildSdkIr>): string[] {
  return ir.operations.map((op) => [...op.namespace, op.name].join(".")).sort();
}

describe("buildSdkIr", () => {
  const ir = buildSdkIr(miniSpec());

  it("drops internal operations", () => {
    expect(names(ir)).not.toContain("admin.secrets");
    expect(ir.operations.some((op) => op.path.startsWith("/api/admin"))).toBe(false);
  });

  it("derives dotted names from the URL path", () => {
    expect(names(ir)).toEqual([
      // A collection: verb-named because there is no trailing segment to use.
      "deep.widgets.list",
      "deep.widgets.update",
      "files.download",
      "files.upload",
      "things.create",
      // Two operations wanted `creds`, so both moved inside it.
      "things.creds.get",
      "things.creds.update",
      "things.delete",
      "things.list",
      // A trailing static segment names the call directly.
      "things.sync",
    ]);
  });

  it("strips the /api mount, the org scope, and the version segment", () => {
    const upload = ir.operations.find((op) => op.name === "upload");
    expect(upload?.path).toBe("/api/org/{orgId}/v1/files/upload");
    expect(upload?.namespace).toEqual(["files"]);
  });

  it("marks the org parameter defaultable and keeps its description", () => {
    const list = ir.operations.find((op) => op.name === "list" && op.namespace[0] === "things");
    const orgId = list?.parameters.find((p) => p.name === "orgId");
    expect(orgId).toMatchObject({ in: "path", required: true, defaultable: true });
    expect(orgId?.description).toBe("Organization id");
    expect(ir.defaultablePathParam).toBe("orgId");
  });

  it("classifies request and response encodings", () => {
    expect(ir.operations.find((op) => op.name === "upload")?.body?.encoding).toBe("multipart");
    expect(ir.operations.find((op) => op.name === "download")?.response.encoding).toBe("binary");
    expect(ir.operations.find((op) => op.name === "delete")?.response.encoding).toBe("empty");
    expect(ir.operations.find((op) => op.name === "create")?.body?.encoding).toBe("json");
  });

  it("normalizes `type: [x, null]` into a union", () => {
    const thing = ir.schemas.find((s) => s.name === "Thing");
    expect(thing?.type).toMatchObject({
      kind: "object",
      properties: [
        { name: "id", required: true, type: { kind: "string" } },
        {
          name: "note",
          required: false,
          type: { kind: "union", members: [{ kind: "string" }, { kind: "null" }] },
        },
      ],
    });
  });

  it("takes metadata from the spec", () => {
    expect(ir.apiVersion).toBe("1.2.3");
    expect(ir.baseUrl).toBe("https://api.test");
    expect(ir.bearerScheme).toBe("bearerAuth");
  });
});

describe("typescript target", () => {
  it("emits a module that compiles, with the four published artifacts", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "infrawrench-sdk-"));
    try {
      // `generate` throws if the emitted TypeScript does not typecheck, so this
      // is the guard against the emitter producing plausible-looking garbage.
      await typescriptTarget.generate(buildSdkIr(miniSpec()), {
        outDir,
        log: () => {},
        write: async (relPath, contents) =>
          (await import("node:fs/promises")).writeFile(join(outDir, relPath), contents),
      });

      for (const artifact of typescriptTarget.artifacts) {
        await expect(readFile(join(outDir, artifact), "utf8")).resolves.toBeTruthy();
      }

      const declarations = await readFile(join(outDir, "index.d.ts"), "utf8");
      expect(declarations).toContain("declare class APIV1Client");
      expect(declarations).toContain("readonly things: ThingsNamespace");
      // `Error` cannot keep its spec name next to `class ApiError extends Error`.
      expect(declarations).toContain("interface ErrorModel");
      expect(declarations).not.toMatch(/interface Error\b/);
      // Internal operations must not reach the emitted client either.
      expect(declarations).not.toContain("secrets");

      const runtime = await readFile(join(outDir, "index.js"), "utf8");
      expect(runtime).toContain('"https://api.test"');
      // Zero dependencies means zero module specifiers.
      expect(runtime).not.toMatch(/^\s*(import|export)\s.*\sfrom\s/m);

      // The TypeScript source is scaffolding and must not survive the run…
      await expect(readFile(join(outDir, "index.ts"), "utf8")).rejects.toThrow();
      // …which is only safe because the map carries it inline.
      const map = JSON.parse(await readFile(join(outDir, "index.js.map"), "utf8")) as {
        sourcesContent?: string[];
      };
      expect(map.sourcesContent?.[0]).toContain("class ApiTransport");

      const manifest = JSON.parse(await readFile(join(outDir, "package.json"), "utf8")) as {
        name: string;
        version: string;
        dependencies: Record<string, string>;
        files: string[];
      };
      expect(manifest).toMatchObject({
        name: "@infrawrench/sdk",
        version: "1.2.3",
        // Deliberately permissive, unlike the BUSL-1.1 repository it comes from.
        license: "MIT",
        author: { name: "Infrawrench LLC", email: "astrid@infrawrench.com" },
        contributors: [{ name: "Astrid Gealer", email: "astrid@infrawrench.com" }],
        repository: { type: "git", url: "git+https://github.com/Infrawrench/Infrawrench.git" },
      });
      expect(Object.keys(manifest.dependencies)).toHaveLength(0);
      // Everything the manifest promises to publish must actually be there.
      for (const file of manifest.files) {
        await expect(readFile(join(outDir, file), "utf8")).resolves.toBeTruthy();
      }

      // MIT only holds if the text and the notice actually ship.
      expect(manifest.files).toContain("LICENSE");
      const license = await readFile(join(outDir, "LICENSE"), "utf8");
      expect(license).toContain("MIT License");
      expect(license).toContain("Copyright (c) 2026 Infrawrench LLC");
      expect(license).toContain("WITHOUT WARRANTY OF ANY KIND");
      // …and a `/*!` banner keeps the notice alive through minification.
      expect(runtime.startsWith("/*!")).toBe(true);
      expect(runtime).toContain("MIT | Copyright (c) 2026 Infrawrench LLC");
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  }, 60_000);
});

/**
 * What every target owes regardless of language. Per-language correctness is
 * proved by compiling the real output (see the SDK docs page for what each
 * toolchain verifies); this only guards the contract the orchestrator relies
 * on, which is exactly the part that breaks silently when a target is added.
 */
describe.each(SDK_TARGETS.map((target) => [target.id, target] as const))(
  "%s target contract",
  (id, target) => {
    it("emits its declared artifacts, MIT, and no internal routes", async () => {
      const outDir = await mkdtemp(join(tmpdir(), `infrawrench-sdk-${id}-`));
      try {
        await target.generate(buildSdkIr(miniSpec()), {
          outDir,
          log: () => {},
          write: async (relPath, contents) => {
            const absolute = join(outDir, relPath);
            await mkdir(dirname(absolute), { recursive: true });
            await writeFile(absolute, contents);
          },
        });

        expect(target.artifacts.length).toBeGreaterThan(0);
        for (const artifact of target.artifacts) {
          // Existence, not content: `py.typed` is a PEP 561 marker whose whole
          // job is to be an empty file.
          await expect(readFile(join(outDir, artifact), "utf8")).resolves.toBeTypeOf("string");
        }

        // MIT is only a claim until the text travels with the package.
        const license = await readFile(join(outDir, "LICENSE"), "utf8");
        expect(license).toContain("MIT License");
        expect(license).toContain("Copyright (c) 2026 Infrawrench LLC");

        // The client class name is the one product-level promise shared by all
        // nine SDKs, and `admin.secrets` is the internal operation miniSpec
        // marks `x-internal` — neither may drift.
        const sources = await readAllFiles(outDir);
        expect(sources).toContain("APIV1Client");
        expect(sources).not.toContain("getAdminSecrets");
        expect(sources.toLowerCase()).not.toContain("/api/admin");
      } finally {
        await rm(outDir, { recursive: true, force: true });
      }
    }, 120_000);
  },
);

/** Every emitted file concatenated, for coarse whole-package assertions. */
async function readAllFiles(dir: string): Promise<string> {
  const parts: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    parts.push(await readFile(join(entry.parentPath, entry.name), "utf8"));
  }
  return parts.join("\n");
}
