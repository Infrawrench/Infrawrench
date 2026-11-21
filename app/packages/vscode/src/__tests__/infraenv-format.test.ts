import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkInfraenvReference,
  infraenvReferenceAt,
  infraenvReferenceKey,
  parseInfraenv,
  type InfraenvDescribeResponse,
} from "@infrawrench/client-core";
import { infraenvHoverMarkdown } from "../infraenv-format";

const SOURCE = `[vars]
stage = dev

[env]
DATABASE_URL = resource("neon/neon-branch", "app / \${stage}", "connectionString")
STRIPE_KEY = secret("STRIPE_KEY")

[vars.production]
stage = prod

[env.production]
`;

const ref = (name: string) =>
  infraenvReferenceKey({
    kind: "named-resource",
    match: { pluginId: "neon", resourceTypeId: "neon-branch", name },
    output: "connectionString",
  });

const DESCRIBE: InfraenvDescribeResponse = {
  problems: [],
  environments: ["production"],
  resources: [
    {
      ref: ref("app / dev"),
      found: true,
      resourceId: "neon:a:1",
      output: "connectionString",
      displayName: "app / dev",
      pluginName: "Neon",
      resourceTypeName: "Branch",
      accountName: "acme",
      outputLabel: "Connection string",
      outputKnown: true,
      sensitive: true,
    },
    {
      ref: ref("app / prod"),
      found: false,
      matches: 2,
      output: "connectionString",
      outputKnown: false,
      sensitive: true,
    },
  ],
  secrets: [{ name: "STRIPE_KEY", found: false, hasValue: false }],
};

function hover(line: number, describe: InfraenvDescribeResponse | null, signedIn = true) {
  const at = infraenvReferenceAt(SOURCE, line, 2)!;
  const checks = checkInfraenvReference(parseInfraenv(SOURCE).document, at, describe);
  return infraenvHoverMarkdown(at, checks, { signedIn });
}

describe("infraenvHoverMarkdown", () => {
  it("shows one line per environment for a templated reference", () => {
    const md = hover(5, DESCRIBE);
    expect(md).toContain("**DATABASE\\_URL** · resource output, by name");
    expect(md).toContain(
      "$(pass) `\\[env\\]`: **app / dev** · Neon Branch · acme · Connection string · sensitive",
    );
    expect(md).toContain("$(error) `production`: **app / prod**");
    expect(md).toContain("Ambiguous: 2 resources match");
  });

  it("says why a secret does not resolve", () => {
    const md = hover(6, DESCRIBE);
    expect(md).toContain("$(error) **STRIPE\\_KEY** · Organization secret");
    expect(md).toContain("No organization secret named STRIPE\\_KEY");
  });

  it("offers sign-in when nothing could be checked", () => {
    expect(hover(6, null, false)).toContain("command:infrawrench.signIn");
    expect(hover(6, null, true)).not.toContain("command:infrawrench.signIn");
  });
});

describe("language contribution", () => {
  const root = path.resolve(__dirname, "..", "..");
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

  it("points at a grammar and configuration that exist and parse", () => {
    const language = manifest.contributes.languages.find(
      (l: { id: string }) => l.id === "infraenv",
    );
    const grammar = manifest.contributes.grammars.find(
      (g: { language: string }) => g.language === "infraenv",
    );
    for (const file of [language.configuration, grammar.path]) {
      const full = path.join(root, file);
      expect(existsSync(full)).toBe(true);
      expect(() => JSON.parse(readFileSync(full, "utf8"))).not.toThrow();
    }
  });

  it("ships the grammar in the package", () => {
    expect(readFileSync(path.join(root, "scripts", "package.mjs"), "utf8")).toContain('"syntaxes"');
  });

  it("declares every command it registers", () => {
    const declared = new Set(
      manifest.contributes.commands.map((c: { command: string }) => c.command),
    );
    const source = readFileSync(path.join(root, "src", "extension.ts"), "utf8");
    for (const [, id] of source.matchAll(/command\("(infrawrench\.[A-Za-z]+)"/g)) {
      expect(declared.has(id)).toBe(true);
    }
  });
});
