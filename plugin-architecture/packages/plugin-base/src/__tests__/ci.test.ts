import { describe, expect, expectTypeOf, it } from "vitest";
import { ciAlias, ciComputeKey, ciContainerCommand, parseCiContainerSize } from "../ci.js";
import { clientContractProblems, defineCredentials } from "../define-plugin.js";
import type { ClientFor } from "../define-plugin.js";
import type { PluginManifest } from "../manifest.js";
import { pluginManifestSchema as manifestSchema } from "../validation/manifest.schema.js";
import { validate } from "../validation/index.js";

const baseManifest = {
  id: "demo",
  displayName: "Demo",
  logoSvg: "<svg/>",
  egressHosts: ["api.example.test"],
  credentialFields: defineCredentials([{ key: "apiToken", label: "Token", sensitive: true }]),
} satisfies PluginManifest;

const executor = {
  kinds: [{ kind: "vm", label: "Server", defaults: { machine: "small" } }],
} as const;

describe("ciExecutor", () => {
  it("makes every executor method required", () => {
    const manifest = { ...baseManifest, ciExecutor: executor } satisfies PluginManifest;
    expectTypeOf<ClientFor<typeof manifest>["ciStart"]>().not.toBeNullable();
    expectTypeOf<ClientFor<typeof manifest>["ciListTagged"]>().not.toBeNullable();
    expectTypeOf<ClientFor<typeof baseManifest>["ciStart"]>().toBeNullable();
  });

  it("names each missing method", () => {
    const manifest = { ...baseManifest, ciExecutor: executor } as never;
    const problems = clientContractProblems({ manifest, resourceTypes: [] }, { ciStart() {} });
    expect(problems.map((p) => p.split(" ").at(-1))).toEqual([
      "ciPreflight()",
      "ciStatus()",
      "ciTeardown()",
      "ciListTagged()",
    ]);
  });

  it("validates", () => {
    const ok = validate(manifestSchema, { ...baseManifest, ciExecutor: executor });
    expect(ok.success).toBe(true);
    const unknownKind = validate(manifestSchema, {
      ...baseManifest,
      ciExecutor: { kinds: [{ kind: "mainframe", label: "x", defaults: {} }] },
    });
    expect(unknownKind.success).toBe(false);
    const none = validate(manifestSchema, { ...baseManifest, ciExecutor: { kinds: [] } });
    expect(none.success).toBe(false);
  });
});

describe("ciCredential", () => {
  it("requires lendCiCredential", () => {
    const manifest = {
      ...baseManifest,
      ciCredential: { description: "A token", shortLived: true },
    } as never;
    expect(clientContractProblems({ manifest, resourceTypes: [] }, {})).toEqual([
      expect.stringContaining("lendCiCredential"),
    ]);
    expect(
      clientContractProblems({ manifest, resourceTypes: [] }, { lendCiCredential() {} }),
    ).toEqual([]);
  });
});

describe("ciAlias", () => {
  it("keeps names file-safe and never empty", () => {
    expect(ciAlias("Production cluster")).toBe("production-cluster");
    expect(ciAlias("web-1")).toBe("web-1");
    expect(ciAlias("../../etc")).toBe("etc");
    expect(ciAlias("日本")).toBe("connection");
  });
});

describe("ciComputeKey", () => {
  it("is the job's uuid as hex, or a stable hash of something else", () => {
    const tags = { "infrawrench-ci-job": "0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0" };
    expect(ciComputeKey({ tags, name: "x" })).toBe("0f1e2d3c4b5a69788796a5b4c3d2e1f0");
    const other = ciComputeKey({ tags: { "infrawrench-ci-job": "job-1" }, name: "x" });
    expect(other).toMatch(/^[0-9a-f]{32}$/);
    expect(ciComputeKey({ tags: { "infrawrench-ci-job": "job-1" }, name: "y" })).toBe(other);
    expect(ciComputeKey({ tags: { "infrawrench-ci-job": "job-2" }, name: "x" })).not.toBe(other);
    expect(ciComputeKey({ tags: {}, name: "x" })).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("parseCiContainerSize", () => {
  it("reads vCPUs and memory", () => {
    expect(parseCiContainerSize("2vcpu-4gb")).toEqual({ vcpus: 2, memoryGb: 4 });
    expect(parseCiContainerSize("0.5 vCPU / 1 GiB")).toEqual({ vcpus: 0.5, memoryGb: 1 });
    expect(parseCiContainerSize("t3.large")).toBeNull();
    expect(parseCiContainerSize("0vcpu-1gb")).toBeNull();
  });
});

describe("ciContainerCommand", () => {
  it("runs the bootstrap under a watchdog as the container's main process", () => {
    const argv = ciContainerCommand("#!/bin/sh\necho hi\n", 3599.2);
    expect(argv.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
    expect(argv[2]).toContain("sleep 3600;");
    expect(argv[2]).toContain('wait "$job"');
    expect(argv.slice(3)).toEqual(["iwci", "#!/bin/sh\necho hi\n"]);
    expect(argv[2]).toContain('exit "$status"');
    expect(ciContainerCommand("true", 60, { exitZero: true })[2]?.endsWith("exit 0")).toBe(true);
  });
});
