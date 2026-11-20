import { describe, expect, it } from "vitest";
import type { CloudFetch } from "../fetch";
import {
  GENERATED_DOTENV_MARKER,
  infraenvReferenceKey,
  parseInfraenv,
  type InfraenvDescribeResponse,
  type InfraenvSource,
} from "../infraenv";
import {
  checkInfraenvReference,
  escapeInfraenvSubstitutions,
  fetchInfraenvDescribe,
  fetchInfraenvResolve,
  fetchInfraenvSources,
  infraenvDiagnostics,
  infraenvKeyForOutput,
  infraenvKeysIn,
  infraenvMatchForSource,
  infraenvOutputPath,
  infraenvPullDecision,
  infraenvReferenceAt,
  infraenvReferenceEntries,
  infraenvReferenceLines,
  infraenvSectionAt,
  infraenvSourcesQueryString,
  uniqueInfraenvKey,
  worstInfraenvCheckState,
} from "../infraenv-client";

function recorder(response: unknown) {
  const calls: { orgId: string; path: string; init?: RequestInit | undefined }[] = [];
  const api: CloudFetch = {
    baseUrl: "https://app.example",
    org: async <T>(orgId: string, path: string, init?: RequestInit) => {
      calls.push({ orgId, path, init });
      return response as T;
    },
    api: async () => null,
    raw: async () => new Response(null),
  };
  return { api, calls };
}

const SOURCE = `[vars]
stage = dev

[env]
NODE_ENV = development
DATABASE_URL = resource("neon/neon-branch", "storefront / \${stage}", "connectionString")
CACHE_URL = resource("upstash:a:redis-1", "restUrl")
STRIPE_KEY = secret("STRIPE_KEY")

[vars.production]
stage = prod

[env.production]
NODE_ENV = production

[env.staging]
CACHE_URL = resource("upstash:a:redis-2", "restUrl")
`;

const devRef = infraenvReferenceKey({
  kind: "named-resource",
  match: { pluginId: "neon", resourceTypeId: "neon-branch", name: "storefront / dev" },
  output: "connectionString",
});
const prodRef = infraenvReferenceKey({
  kind: "named-resource",
  match: { pluginId: "neon", resourceTypeId: "neon-branch", name: "storefront / prod" },
  output: "connectionString",
});

const DESCRIBE: InfraenvDescribeResponse = {
  problems: [
    { line: 6, key: "DATABASE_URL", message: "No resource by that name (environment production)" },
  ],
  environments: ["production", "staging"],
  resources: [
    {
      ref: devRef,
      resourceId: "neon:a:br-1",
      found: true,
      output: "connectionString",
      displayName: "storefront / dev",
      pluginId: "neon",
      pluginName: "Neon",
      resourceTypeId: "neon-branch",
      resourceTypeName: "Neon Branch",
      accountId: "a",
      accountName: "acme-neon",
      outputLabel: "Connection string",
      outputKnown: true,
      sensitive: true,
    },
    {
      ref: prodRef,
      matches: 0,
      found: false,
      output: "connectionString",
      outputKnown: false,
      sensitive: true,
    },
  ],
  secrets: [{ name: "STRIPE_KEY", found: true, hasValue: false }],
};

describe("requests", () => {
  it("describes with the source and only non-empty vars", async () => {
    const { api, calls } = recorder(DESCRIBE);
    await fetchInfraenvDescribe(api, "org_1", { source: "A = 1", vars: {} });
    expect(calls[0]!.path).toBe("/env-files/describe");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ source: "A = 1" });
    await fetchInfraenvDescribe(api, "org_1", { source: "A = 1", vars: { stage: "x" } });
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({
      source: "A = 1",
      vars: { stage: "x" },
    });
  });

  it("answers an empty describe for an empty body", async () => {
    const { api } = recorder(null);
    expect(await fetchInfraenvDescribe(api, "o", { source: "" })).toEqual({
      problems: [],
      environments: [],
      resources: [],
      secrets: [],
    });
  });

  it("resolves one environment and names the source", async () => {
    const { api, calls } = recorder({ environment: null, values: [], problems: [], dotenv: "" });
    await fetchInfraenvResolve(api, "o", { source: "S", environment: null });
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ source: "S" });
    await fetchInfraenvResolve(api, "o", {
      source: "S",
      environment: "production",
      sourceName: "../.infraenv",
    });
    expect(calls[1]!.path).toBe("/env-files/resolve");
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({
      source: "S",
      environment: "production",
      sourceName: "../.infraenv",
    });
  });

  it("lists sources with a clamped query", async () => {
    expect(infraenvSourcesQueryString()).toBe("");
    expect(infraenvSourcesQueryString({ q: "  db ", limit: 500 })).toBe("?q=db&limit=100");
    const { api, calls } = recorder({ sources: [{ resourceId: "r" }] });
    expect(await fetchInfraenvSources(api, "o", { q: "db" })).toEqual([{ resourceId: "r" }]);
    expect(calls[0]!.path).toBe("/env-files/sources?q=db");
  });
});

describe("infraenvDiagnostics", () => {
  it("reports syntax problems offline as errors", () => {
    const d = infraenvDiagnostics("[env]\n1BAD = x\nOK = resource(\n", null);
    expect(d.map((x) => [x.line, x.severity])).toEqual([
      [2, "error"],
      [3, "error"],
    ]);
  });

  it("reports a substitution with no value offline as a warning", () => {
    const d = infraenvDiagnostics('[env]\nA = secret("${missing}")\n', null);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ line: 2, key: "A", severity: "warning" });
  });

  it("adds dangling references from describe, without repeating offline problems", () => {
    const source = '[env]\n1BAD = x\nA = secret("NOPE")\n';
    const describe: InfraenvDescribeResponse = {
      problems: [
        ...parseInfraenv(source).problems,
        { line: 3, key: "A", message: "No organization secret named NOPE" },
      ],
      environments: [],
      resources: [],
      secrets: [],
    };
    const d = infraenvDiagnostics(source, describe);
    expect(d.map((x) => [x.line, x.severity])).toEqual([
      [2, "error"],
      [3, "warning"],
    ]);
  });
});

describe("infraenvReferenceAt", () => {
  it("finds the reference under the cursor, from the key to the closing paren", () => {
    const line = 6;
    const text = SOURCE.split("\n")[line - 1]!;
    const at = infraenvReferenceAt(SOURCE, line, text.indexOf("storefront"));
    expect(at).toMatchObject({ line, start: 0, end: text.length, environment: null });
    expect(at?.entry.key).toBe("DATABASE_URL");
    expect(at?.value.kind).toBe("named-resource");
    expect(infraenvReferenceAt(SOURCE, line, 0)?.entry.key).toBe("DATABASE_URL");
  });

  it("ignores literals, vars, comments and text past the reference", () => {
    expect(infraenvReferenceAt(SOURCE, 5, 3)).toBeNull();
    expect(infraenvReferenceAt(SOURCE, 2, 1)).toBeNull();
    expect(infraenvReferenceAt('A = secret("X") # note', 1, 18)).toBeNull();
    expect(infraenvReferenceAt('A = secret("X") # note', 1, 6)?.value).toEqual({
      kind: "secret",
      name: "X",
    });
  });

  it("knows a closing paren inside quotes is not the end", () => {
    const src = '  B = secret("a)b")';
    expect(infraenvReferenceAt(src, 1, 1)).toBeNull();
    expect(infraenvReferenceAt(src, 1, 2)).toMatchObject({ start: 2, end: src.length });
  });

  it("names the environment section", () => {
    expect(infraenvReferenceAt(SOURCE, 17, 0)?.environment).toBe("staging");
  });
});

describe("checkInfraenvReference", () => {
  const { document } = parseInfraenv(SOURCE);
  const entries = infraenvReferenceEntries(document);

  it("lists reference entries in file order with their section", () => {
    expect(entries.map((e) => [e.entry.key, e.environment])).toEqual([
      ["DATABASE_URL", null],
      ["CACHE_URL", null],
      ["STRIPE_KEY", null],
      ["CACHE_URL", "staging"],
    ]);
  });

  it("shows one row per distinct expansion of a templated reference", () => {
    const rows = checkInfraenvReference(document, entries[0]!, DESCRIBE);
    expect(rows.map((r) => [r.environments, r.state])).toEqual([
      [[null, "staging"], "ok"],
      [["production"], "error"],
    ]);
    expect(rows[0]).toMatchObject({
      title: "storefront / dev",
      detail: "Neon Neon Branch · acme-neon · Connection string",
    });
    expect(rows[1]!.message).toBe("No resource by that name");
  });

  it("leaves out the environments that override a shared entry", () => {
    const rows = checkInfraenvReference(document, entries[1]!, DESCRIBE);
    expect(rows.map((r) => r.environments)).toEqual([[null, "production"]]);
    expect(rows[0]!.state).toBe("unchecked");
  });

  it("checks secrets", () => {
    const rows = checkInfraenvReference(document, entries[2]!, DESCRIBE);
    expect(rows[0]).toMatchObject({ state: "warning", title: "STRIPE_KEY" });
    expect(checkInfraenvReference(document, entries[2]!, null)[0]!.state).toBe("unchecked");
  });

  it("reports an ambiguous name with its count", () => {
    const describe: InfraenvDescribeResponse = {
      ...DESCRIBE,
      resources: [{ ...DESCRIBE.resources[1]!, ref: devRef, matches: 3 }],
    };
    const rows = checkInfraenvReference(document, entries[0]!, describe);
    expect(rows[0]!.message).toBe("Ambiguous: 3 resources match");
  });

  it("reports a missing substitution as an error row", () => {
    const doc = parseInfraenv('[env]\nA = secret("${nope}")\n').document;
    const rows = checkInfraenvReference(doc, { entry: doc.shared[0]!, environment: null }, null);
    expect(rows[0]).toMatchObject({ state: "error", value: null });
    expect(rows[0]!.message).toContain("${nope}");
  });

  it("ranks states", () => {
    expect(worstInfraenvCheckState(["ok", "unchecked", "warning"])).toBe("warning");
    expect(worstInfraenvCheckState([])).toBe("ok");
  });
});

describe("pulling", () => {
  it("writes to the output setting or .env", () => {
    expect(infraenvOutputPath(parseInfraenv("").document)).toBe(".env");
    expect(infraenvOutputPath(parseInfraenv("[infrawrench]\noutput = .env.local").document)).toBe(
      ".env.local",
    );
  });

  it("never replaces a hand-written file without asking", () => {
    expect(infraenvPullDecision(null)).toBe("create");
    expect(infraenvPullDecision(`${GENERATED_DOTENV_MARKER}\nA=1\n`)).toBe("replace");
    expect(infraenvPullDecision("A=1\n")).toBe("confirm");
  });
});

describe("inserting a reference", () => {
  const source: InfraenvSource = {
    resourceId: "neon:a:br-1",
    displayName: "main",
    pluginId: "neon",
    pluginName: "Neon",
    resourceTypeId: "neon-branch",
    resourceTypeName: "Neon Branch",
    accountId: "a",
    accountName: "acme",
    outputs: [],
  };
  const output = { key: "connectionString", label: "Connection string", sensitive: true };

  it("writes a by-name reference with a comment", () => {
    expect(infraenvReferenceLines("DATABASE_URL", source, output)).toEqual([
      "# Neon: main (Connection string)",
      'DATABASE_URL = resource("neon/neon-branch", "main", "connectionString")',
    ]);
  });

  it("adds the account for a twin, and pins by id when even that is ambiguous", () => {
    const twin = { ...source, resourceId: "neon:b:br-1", accountId: "b", accountName: "other" };
    expect(infraenvMatchForSource(source, [twin])).toEqual({
      pluginId: "neon",
      resourceTypeId: "neon-branch",
      name: "main",
      account: "acme",
    });
    const sameAccount = { ...twin, accountName: "acme" };
    expect(infraenvReferenceLines("X", source, output, [sameAccount])[1]).toBe(
      'X = resource("neon:a:br-1", "connectionString")',
    );
  });

  it("escapes substitutions in a resource's own name", () => {
    expect(escapeInfraenvSubstitutions("a ${b}")).toBe("a $${b}");
    const named = { ...source, displayName: "a ${b}" };
    const line = infraenvReferenceLines("X", named, output)[1];
    const parsed = parseInfraenv(`[env]\n${line}\n`).document.shared[0]!.value;
    expect(parsed).toMatchObject({ match: { name: "a $${b}" } });
  });

  it("suggests a unique key", () => {
    expect(infraenvKeyForOutput({ ...output, suggestedKey: "DATABASE_URL" })).toBe("DATABASE_URL");
    expect(infraenvKeyForOutput({ ...output, suggestedKey: "bad key" })).toBe("CONNECTION_STRING");
    expect(uniqueInfraenvKey("A", ["A", "A_2"])).toBe("A_3");
    const { document } = parseInfraenv(SOURCE);
    expect(infraenvKeysIn(document, "staging")).toEqual(["CACHE_URL"]);
    expect(infraenvKeysIn(document, null)).toContain("STRIPE_KEY");
  });

  it("finds the section a line is in", () => {
    expect(infraenvSectionAt(SOURCE, 1)).toEqual({ kind: "vars", environment: null });
    expect(infraenvSectionAt(SOURCE, 6)).toEqual({ kind: "env", environment: null });
    expect(infraenvSectionAt(SOURCE, 17)).toEqual({ kind: "env", environment: "staging" });
    expect(infraenvSectionAt("A = 1\n", 1)).toEqual({ kind: "env", environment: null });
    expect(infraenvSectionAt("[infrawrench]\noutput = x", 2)).toEqual({ kind: "settings" });
  });
});
