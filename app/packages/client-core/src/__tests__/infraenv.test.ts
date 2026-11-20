import { describe, expect, it } from "vitest";
import {
  GENERATED_DOTENV_MARKER,
  emptyInfraenvDocument,
  expandInfraenvValue,
  infraenvEntriesFor,
  infraenvReferenceKey,
  infraenvVariables,
  infraenvReferences,
  isGeneratedDotenv,
  parseInfraenv,
  quoteDotenvValue,
  renderDotenv,
  serializeInfraenv,
  suggestInfraenvKey,
  type InfraenvDocument,
} from "../infraenv";

const SAMPLE = `# Infrawrench environment map.
# Safe to commit.

[infrawrench]
org = org_123
output = .env.local

[env]
NODE_ENV = development
# Neon: main branch
DATABASE_URL = resource("res_abc", "connectionString")
STRIPE_SECRET_KEY = secret("STRIPE_SECRET_KEY")
GREETING = "hello world"
RAW = 'no $expansion here'
EMPTY =
WITH_COMMENT = abc # trailing

[env.production]
NODE_ENV = production
DATABASE_URL = resource("arn:aws:rds:us-east-1:1:db/prod", "connectionString")
EXTRA = "line one\\nline two"
`;

describe("parseInfraenv", () => {
  it("reads settings, shared entries, environments, comments and the header", () => {
    const { document, problems } = parseInfraenv(SAMPLE);
    expect(problems).toEqual([]);
    expect(document.header).toBe(" Infrawrench environment map.\n Safe to commit.");
    expect(document.settings).toEqual({ org: "org_123", output: ".env.local" });
    expect(document.shared.map((e) => [e.key, e.value])).toEqual([
      ["NODE_ENV", { kind: "literal", value: "development" }],
      ["DATABASE_URL", { kind: "resource", resourceId: "res_abc", output: "connectionString" }],
      ["STRIPE_SECRET_KEY", { kind: "secret", name: "STRIPE_SECRET_KEY" }],
      ["GREETING", { kind: "literal", value: "hello world" }],
      ["RAW", { kind: "literal", value: "no $expansion here" }],
      ["EMPTY", { kind: "literal", value: "" }],
      ["WITH_COMMENT", { kind: "literal", value: "abc" }],
    ]);
    expect(document.shared[1]!.comment).toBe(" Neon: main branch");
    expect(document.environments.map((e) => e.name)).toEqual(["production"]);
    expect(document.environments[0]!.entries[1]!.value).toEqual({
      kind: "resource",
      resourceId: "arn:aws:rds:us-east-1:1:db/prod",
      output: "connectionString",
    });
    expect(document.environments[0]!.entries[2]!.value).toEqual({
      kind: "literal",
      value: "line one\nline two",
    });
  });

  it("treats lines before any section as [env], so a plain dotenv parses", () => {
    const { document, problems } = parseInfraenv("export A=1\nB='two'\n");
    expect(problems).toEqual([]);
    expect(document.shared.map((e) => e.key)).toEqual(["A", "B"]);
  });

  it("keeps a quoted reference a literal", () => {
    const { document } = parseInfraenv(`A = "secret(\\"x\\")"\n`);
    expect(document.shared[0]!.value).toEqual({ kind: "literal", value: 'secret("x")' });
  });

  it("reads a double-quoted value across lines", () => {
    const { document, problems } = parseInfraenv('KEY = "-----BEGIN\nabc\n-----END"\nNEXT = 1\n');
    expect(problems).toEqual([]);
    expect(document.shared.map((e) => [e.key, e.value])).toEqual([
      ["KEY", { kind: "literal", value: "-----BEGIN\nabc\n-----END" }],
      ["NEXT", { kind: "literal", value: "1" }],
    ]);
  });

  it.each([
    ["1BAD = x", "Invalid variable name"],
    ['A = resource("only-one")', 'resource() takes resource("<id>", "<output>")'],
    ["A = secret()", "secret() takes one argument"],
    ["A = resource(res, out)", "Malformed reference"],
    ['A = "unterminated', "Unterminated quoted value"],
    ["just text", "Expected KEY = value"],
    ["[nope]", "Unknown section"],
    ["[env.bad name]", "Invalid environment name"],
    ["[infrawrench]\ncolour = red", "Unknown setting"],
    ["A = 1\nA = 2", "A is set twice"],
  ])("reports %j", (source, message) => {
    const { problems } = parseInfraenv(source);
    expect(problems.map((p) => p.message).join("\n")).toContain(message);
  });

  it("reports the line of each problem", () => {
    const { problems } = parseInfraenv("A = 1\n\nB = secret()\n");
    expect(problems).toEqual([
      { line: 3, key: "B", message: 'secret() takes one argument: secret("<name>")' },
    ]);
  });
});

describe("serializeInfraenv", () => {
  it("round-trips the sample", () => {
    const first = parseInfraenv(SAMPLE).document;
    const text = serializeInfraenv(first);
    const second = parseInfraenv(text);
    expect(second.problems).toEqual([]);
    const strip = (d: InfraenvDocument) =>
      JSON.parse(JSON.stringify(d, (k, v) => (k === "line" ? undefined : v)));
    expect(strip(second.document)).toEqual(strip(first));
    expect(serializeInfraenv(second.document)).toBe(text);
  });

  it("quotes literals that would read back differently", () => {
    const doc: InfraenvDocument = {
      settings: {},
      shared: [
        { key: "A", value: { kind: "literal", value: 'resource("x", "y")' } },
        { key: "B", value: { kind: "literal", value: "has # hash" } },
        { key: "C", value: { kind: "literal", value: "postgres://u:p@h/db?ssl=true" } },
      ],
      environments: [],
    };
    const text = serializeInfraenv(doc);
    expect(text).toContain('A = "resource(\\"x\\", \\"y\\")"');
    expect(text).toContain('B = "has # hash"');
    expect(parseInfraenv(text).document.shared.map((e) => e.value)).toEqual(
      doc.shared.map((e) => e.value),
    );
  });

  it("writes a new file with the default header and an [env] section", () => {
    const text = serializeInfraenv(emptyInfraenvDocument());
    expect(text).toMatch(/^# Infrawrench environment map/);
    expect(text).toContain("[env]\n");
  });
});

describe("infraenvEntriesFor", () => {
  it("lays the environment over [env], keeping shared order", () => {
    const { document } = parseInfraenv(SAMPLE);
    const prod = infraenvEntriesFor(document, "production");
    expect(prod.map((e) => e.key)).toEqual([
      "NODE_ENV",
      "DATABASE_URL",
      "STRIPE_SECRET_KEY",
      "GREETING",
      "RAW",
      "EMPTY",
      "WITH_COMMENT",
      "EXTRA",
    ]);
    expect(prod[0]!.value).toEqual({ kind: "literal", value: "production" });
    expect(infraenvEntriesFor(document, null)[0]!.value).toEqual({
      kind: "literal",
      value: "development",
    });
  });

  it("lists each reference once", () => {
    const { document } = parseInfraenv(SAMPLE);
    const refs = infraenvReferences(document);
    expect(refs.resources).toHaveLength(2);
    expect(refs.problems).toEqual([]);
    expect(refs.secrets).toEqual(["STRIPE_SECRET_KEY"]);
  });
});

describe("renderDotenv", () => {
  it("writes the generated header and quoted values", () => {
    const text = renderDotenv(
      [
        { key: "A", value: "plain" },
        { key: "B", value: "has space" },
        { key: "C", value: "it's" },
        { key: "D", value: "multi\nline" },
        { key: "E", value: "" },
      ],
      { environment: "production" },
    );
    expect(text.split("\n")[0]).toBe(GENERATED_DOTENV_MARKER);
    expect(isGeneratedDotenv(text)).toBe(true);
    expect(text).toContain("(environment: production)");
    expect(text).toContain('A=plain\nB=\'has space\'\nC="it\'s"\nD="multi\\nline"\nE=\n');
  });

  it("is stable across runs", () => {
    const values = [{ key: "A", value: "1" }];
    expect(renderDotenv(values)).toBe(renderDotenv(values));
  });

  it("quotes values the way dotenv reads them back", () => {
    expect(quoteDotenvValue("a$b")).toBe("'a$b'");
    expect(quoteDotenvValue("")).toBe("");
  });
});

describe("suggestInfraenvKey", () => {
  it("upper-snakes the parts", () => {
    expect(suggestInfraenvKey("connectionString")).toBe("CONNECTION_STRING");
    expect(suggestInfraenvKey("prod db", "url")).toBe("PROD_DB_URL");
    expect(suggestInfraenvKey("3scale")).toBe("_3SCALE");
  });
});

describe("by-name references and substitutions", () => {
  const PORTABLE = `[vars]
stage = dev
team = storefront

[env]
DATABASE_URL = resource("neon/neon-branch", "\${team} / \${stage}", "connectionString")
CACHE = resource("upstash/upstash-redis@Upstash \${stage}", "sessions", "restUrl")
STRIPE = secret("STRIPE_\${stage}_KEY")
LITERAL = "\${HOME} stays"
ESCAPED = resource("neon/neon-branch", "a $\${b}", "connectionString")

[vars.production]
stage = prod

[env.production]
NODE_ENV = production
`;

  it("parses by-name references, [vars] and [vars.<env>]", () => {
    const { document, problems } = parseInfraenv(PORTABLE);
    expect(problems).toEqual([]);
    expect(document.vars?.map((v) => [v.key, v.value])).toEqual([
      ["stage", "dev"],
      ["team", "storefront"],
    ]);
    expect(document.environments[0]!.vars?.map((v) => [v.key, v.value])).toEqual([
      ["stage", "prod"],
    ]);
    expect(document.shared[1]!.value).toEqual({
      kind: "named-resource",
      match: {
        pluginId: "upstash",
        resourceTypeId: "upstash-redis",
        name: "sessions",
        account: "Upstash ${stage}",
      },
      output: "restUrl",
    });
  });

  it("round-trips", () => {
    const text = serializeInfraenv(parseInfraenv(PORTABLE).document);
    expect(serializeInfraenv(parseInfraenv(text).document)).toBe(text);
    expect(text).toContain("[vars.production]\nstage = prod\n\n[env.production]");
  });

  it("expands per environment, never touching literals", () => {
    const { document } = parseInfraenv(PORTABLE);
    const dev = infraenvVariables(document, null);
    const prod = infraenvVariables(document, "production", { team: "web" });
    expect(prod.get("environment")).toBe("production");
    const db = document.shared[0]!.value;
    expect(expandInfraenvValue(db, dev)).toMatchObject({
      ok: true,
      value: { match: { name: "storefront / dev" } },
    });
    expect(expandInfraenvValue(db, prod)).toMatchObject({
      ok: true,
      value: { match: { name: "web / prod" } },
    });
    expect(expandInfraenvValue(document.shared[2]!.value, prod)).toMatchObject({
      value: { name: "STRIPE_prod_KEY" },
    });
    expect(document.shared[3]!.value).toEqual({ kind: "literal", value: "${HOME} stays" });
    expect(expandInfraenvValue(document.shared[4]!.value, dev)).toMatchObject({
      value: { match: { name: "a ${b}" } },
    });
  });

  it("reports a substitution with no value, per scope", () => {
    const { document } = parseInfraenv(
      '[env]\nA = secret("K_${environment}")\n\n[env.staging]\nB = x\n',
    );
    const refs = infraenvReferences(document);
    expect(refs.secrets).toEqual(["K_staging"]);
    expect(refs.problems).toEqual([
      {
        line: 2,
        key: "A",
        message: "No value for ${environment}: set it in [vars] or pick an environment",
      },
    ]);
  });

  it.each([
    ['A = resource("neon", "x", "y")', "resource() by name takes"],
    ['A = resource("neon/branch@", "x", "y")', "resource() by name takes"],
    ['[vars]\nA = secret("x")', "a substitution takes a plain value"],
    ["[vars.prod]\nA = 1\n[vars.prod]\nB = 2", "[vars.prod] is declared twice"],
  ])("reports %j", (source, message) => {
    expect(
      parseInfraenv(source)
        .problems.map((p) => p.message)
        .join("\n"),
    ).toContain(message);
  });

  it("keys expanded references the same way everywhere", () => {
    expect(
      infraenvReferenceKey({
        kind: "named-resource",
        match: { pluginId: "neon", resourceTypeId: "neon-branch", name: "main" },
        output: "connectionString",
      }),
    ).toBe("name:neon/neon-branch\u0000main\u0000connectionString");
  });
});
