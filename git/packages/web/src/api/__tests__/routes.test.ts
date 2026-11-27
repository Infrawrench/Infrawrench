// @vitest-environment node
/**
 * `routes.gen.ts` is the contract's method and path per endpoint, written out
 * so the client needs no Effect at runtime. This test is both its generator
 * (`pnpm --filter @infrawrench/git-web generate:routes`) and the check that
 * it still matches the contract.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GitApi } from "@infrawrench/git-contract";
import { expect, test } from "vitest";

const target = fileURLToPath(new URL("../routes.gen.ts", import.meta.url));

function render(): string {
  const groups = new Map<string, Array<[string, string, string]>>();
  for (const [group, definition] of Object.entries(GitApi.groups)) {
    groups.set(
      group,
      Object.entries(definition.endpoints).map(([name, endpoint]) => [
        name,
        endpoint.method,
        endpoint.path,
      ]),
    );
  }
  const lines = [
    "// Generated from @infrawrench/git-contract by src/api/__tests__/routes.test.ts.",
    "// Do not edit: run `pnpm --filter @infrawrench/git-web generate:routes`.",
    "",
    "export const API_ROUTES = {",
  ];
  for (const [group, endpoints] of groups) {
    lines.push(`  ${group}: {`);
    for (const [name, method, path] of endpoints) {
      lines.push(`    ${name}: [${JSON.stringify(method)}, ${JSON.stringify(path)}],`);
    }
    lines.push("  },");
  }
  lines.push("} as const;", "");
  return lines.join("\n");
}

test("routes.gen.ts matches the contract", () => {
  const expected = render();
  if (process.env.UPDATE_API_ROUTES === "1") writeFileSync(target, expected);
  expect(readFileSync(target, "utf8")).toBe(expected);
});
