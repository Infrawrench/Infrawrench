import { describe, expect, expectTypeOf, it } from "vitest";
import { clientContractProblems, defineCredentials } from "../define-plugin.js";
import type { ClientFor } from "../define-plugin.js";
import type { PluginManifest } from "../manifest.js";
import { restoreDrillCopyName } from "../restore-drill.js";
import { pluginManifestSchema as manifestSchema } from "../validation/manifest.schema.js";
import { validate } from "../validation/index.js";

const baseManifest = {
  id: "demo",
  displayName: "Demo",
  logoSvg: "<svg/>",
  egressHosts: ["api.example.test"],
  credentialFields: defineCredentials([{ key: "apiToken", label: "Token", sensitive: true }]),
} satisfies PluginManifest;

const restoreDrill = {
  copyNoun: "branch",
  targets: [{ resourceTypeId: "db", restorePoints: ["point-in-time"] }],
} satisfies PluginManifest["restoreDrill"];

describe("restoreDrill", () => {
  it("makes the three drill methods required", () => {
    const manifest = { ...baseManifest, restoreDrill } satisfies PluginManifest;
    expectTypeOf<ClientFor<typeof manifest>["startRestoreDrill"]>().not.toBeNullable();
    expectTypeOf<ClientFor<typeof manifest>["checkRestoreDrill"]>().not.toBeNullable();
    expectTypeOf<ClientFor<typeof manifest>["endRestoreDrill"]>().not.toBeNullable();
    expectTypeOf<ClientFor<typeof baseManifest>["startRestoreDrill"]>().toBeNullable();
  });

  it("names each missing method", () => {
    const manifest = { ...baseManifest, restoreDrill } as never;
    const problems = clientContractProblems(
      { manifest, resourceTypes: [] },
      { startRestoreDrill() {} },
    );
    expect(problems.map((p) => p.split(" ").at(-1))).toEqual([
      "checkRestoreDrill()",
      "endRestoreDrill()",
    ]);
  });

  it("validates", () => {
    expect(validate(manifestSchema, { ...baseManifest, restoreDrill }).success).toBe(true);
    const unknownPoint = validate(manifestSchema, {
      ...baseManifest,
      restoreDrill: {
        copyNoun: "branch",
        targets: [{ resourceTypeId: "db", restorePoints: ["yesterday"] }],
      },
    });
    expect(unknownPoint.success).toBe(false);
    const noTargets = validate(manifestSchema, {
      ...baseManifest,
      restoreDrill: { copyNoun: "branch", targets: [] },
    });
    expect(noTargets.success).toBe(false);
    const noPoints = validate(manifestSchema, {
      ...baseManifest,
      restoreDrill: { copyNoun: "branch", targets: [{ resourceTypeId: "db", restorePoints: [] }] },
    });
    expect(noPoints.success).toBe(false);
  });

  it("names copies so every provider accepts them", () => {
    const name = restoreDrillCopyName("3F2A-91c0-77d4-4e1b-bb0a-0c11aa22bb33");
    expect(name).toBe("iw-drill-3f2a91c077d4");
    expect(name).toMatch(/^[a-z0-9-]+$/);
  });
});
