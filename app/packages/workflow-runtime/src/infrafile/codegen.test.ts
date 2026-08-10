import { describe, expect, it } from "vitest";
import ts from "@typescript/typescript6";

import { generateInfrafileDts } from "./codegen.js";
import { infrafileImageRef } from "./types.js";

/**
 * `Infrafile.d.ts` is assembled from template literals, so a stray backtick or
 * a mis-escaped one silently produces a file that no longer parses — the editor
 * then loses every type at once, with no build step to catch it. These parse
 * the real output.
 */
function syntaxErrors(dts: string): string[] {
  const file = ts.createSourceFile("Infrafile.d.ts", dts, ts.ScriptTarget.ESNext, true);
  // `parseDiagnostics` is internal but is the only way to see syntax errors
  // without building a whole Program over a virtual filesystem.
  const diags = (file as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
  return diags.map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "));
}

describe("generateInfrafileDts", () => {
  it("emits a file that parses", () => {
    const dts = generateInfrafileDts({ plugins: [] });
    expect(syntaxErrors(dts)).toEqual([]);
  });

  it("declares defineInfra and the three stages", () => {
    const dts = generateInfrafileDts({ plugins: [] });
    expect(dts).toContain("declare function defineInfra");
    expect(dts).toContain("plan(ctx: InfraPlanContext)");
    expect(dts).toContain("dockerfile(ctx: InfraDockerfileContext<P>)");
    expect(dts).toContain("deploy(ctx: InfraDeployContext<P>)");
  });

  it("types run() on the deploy context, including the allowFailure overload", () => {
    const dts = generateInfrafileDts({ plugins: [] });
    expect(dts).toContain("run(command: string, opts?: InfraRunOptions");
    expect(dts).toContain("allowFailure: true");
    expect(syntaxErrors(dts)).toEqual([]);
  });

  it("narrows the env union to the declared environments, staying open", () => {
    const dts = generateInfrafileDts({ plugins: [], envs: ["staging", "production"] });
    expect(dts).toContain('type InfraEnv = "staging" | "production" | (string & {});');
    expect(syntaxErrors(dts)).toEqual([]);
  });

  it("falls back to string when no environments are known yet", () => {
    expect(generateInfrafileDts({ plugins: [] })).toContain("type InfraEnv = string;");
  });

  it("still carries the infra surface, so a deploy can reach accounts", () => {
    const dts = generateInfrafileDts({ plugins: [] });
    expect(dts).toContain("declare const infra: InfraApi;");
    expect(dts).toContain("declare function fetch(");
  });
});

describe("infrafileImageRef", () => {
  it("gives every driver the same reference for the same inputs", () => {
    const args = { project: "astrid/my-app", env: "production", gitSha: "a1b2c3d4e5f6" };
    expect(infrafileImageRef(args)).toBe("my-app:production-a1b2c3d");
  });

  it("prefers the plan's tag", () => {
    expect(
      infrafileImageRef({ project: "my-app", env: "production", tag: "v1.2.3", gitSha: "abc1234" }),
    ).toBe("my-app:v1.2.3");
  });

  it("prefixes a registry host so the image can be pushed without re-tagging", () => {
    expect(
      infrafileImageRef({
        project: "astrid/my-app",
        env: "staging",
        gitSha: "abc1234",
        registryHost: "registry.example.com",
      }),
    ).toBe("registry.example.com/my-app:staging-abc1234");
  });

  it("sanitises a name Docker would reject", () => {
    expect(infrafileImageRef({ project: "My App (v2)!", env: "prod" })).toBe("my-app--v2:prod");
  });

  it("falls back rather than producing an empty name", () => {
    expect(infrafileImageRef({ project: "///", env: "prod" })).toBe("app:prod");
  });

  it("omits the sha suffix when there is no commit", () => {
    expect(infrafileImageRef({ project: "my-app", env: "prod" })).toBe("my-app:prod");
  });
});
