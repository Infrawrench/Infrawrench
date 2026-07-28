import { describe, expect, it } from "vitest";
import ts from "typescript";

import { generateInfrafileDts } from "./codegen.js";

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
