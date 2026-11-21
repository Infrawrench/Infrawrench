import { describe, expect, it } from "vitest";
import {
  expandInfraenvTemplate,
  infraenvReferenceKey,
  infraenvVariables,
  parseInfraenv,
  serializeInfraenv,
  type InfraenvDescribeResponse,
  type InfraenvDocument,
  type InfraenvResourceDescription,
  type InfraenvSource,
  type InfraenvValue,
} from "@infrawrench/client-core";
import {
  addEnvironment,
  describedResource,
  documentProblemCount,
  editorKind,
  environmentNameProblem,
  escapeInfraenvTemplate,
  fileNameOf,
  namedMatchFor,
  overrideEntry,
  overrideVar,
  pickResource,
  putEntry,
  putVar,
  referenceState,
  removeEntry,
  removeEnvironment,
  removeVar,
  renameEnvironment,
  rowProblem,
  rowsFor,
  scopeVars,
  toggledReference,
  uniqueKey,
  varProblem,
  varRowsFor,
  withKind,
  withResourceName,
} from "../env-files/document.js";

const SOURCE = [
  "[env]",
  "NODE_ENV = development",
  'DATABASE_URL = resource("res_db", "connectionString")',
  'STRIPE_KEY = secret("STRIPE_KEY")',
  "",
  "[env.production]",
  "NODE_ENV = production",
  "SENTRY = on",
  "",
].join("\n");

function doc(): InfraenvDocument {
  const parsed = parseInfraenv(SOURCE);
  expect(parsed.problems).toEqual([]);
  return parsed.document;
}

const neon: InfraenvSource = {
  resourceId: "res_neon",
  displayName: "main",
  pluginId: "neon",
  pluginName: "Neon",
  resourceTypeId: "neon-branch",
  resourceTypeName: "Branch",
  accountId: "acc",
  accountName: "Prod",
  outputs: [
    { key: "connectionString", label: "Connection string", sensitive: true },
    { key: "host", label: "Host", sensitive: false, suggestedKey: "PGHOST" },
  ],
};

describe("rowsFor", () => {
  it("lists the shared section's own rows", () => {
    const rows = rowsFor(doc(), null);
    expect(rows.map((r) => [r.entry.key, r.index, r.inherited])).toEqual([
      ["NODE_ENV", 0, false],
      ["DATABASE_URL", 1, false],
      ["STRIPE_KEY", 2, false],
    ]);
  });

  it("lays a named environment over the shared rows, in file order", () => {
    const rows = rowsFor(doc(), "production");
    expect(rows.map((r) => [r.entry.key, r.index, r.inherited, r.overrides])).toEqual([
      ["NODE_ENV", 0, false, true],
      ["DATABASE_URL", null, true, false],
      ["STRIPE_KEY", null, true, false],
      ["SENTRY", 1, false, false],
    ]);
  });

  it("keeps a duplicated key visible so it can be fixed", () => {
    const d = putEntry(doc(), "production", null, {
      key: "SENTRY",
      value: { kind: "literal", value: "off" },
    });
    expect(rowsFor(d, "production").filter((r) => r.entry.key === "SENTRY")).toHaveLength(2);
    expect(rowProblem(d.environments[0]!.entries, 2)).toBe("key-duplicate");
  });
});

describe("editing entries", () => {
  it("overrides a shared entry in an environment once", () => {
    const shared = doc().shared[1]!;
    const once = overrideEntry(doc(), "production", shared);
    const twice = overrideEntry(once, "production", shared);
    expect(twice.environments[0]!.entries.map((e) => e.key)).toEqual([
      "NODE_ENV",
      "SENTRY",
      "DATABASE_URL",
    ]);
    expect(twice.environments[0]!.entries[2]!.line).toBeUndefined();
  });

  it("removes an entry and replaces one in place", () => {
    const removed = removeEntry(doc(), null, 0);
    expect(removed.shared.map((e) => e.key)).toEqual(["DATABASE_URL", "STRIPE_KEY"]);
    const replaced = putEntry(doc(), null, 0, {
      key: "NODE_ENV",
      value: { kind: "literal", value: "test" },
    });
    expect(serializeInfraenv(replaced)).toContain("NODE_ENV = test");
  });

  it("drops a resource comment when the kind changes", () => {
    const entry = {
      key: "DB",
      comment: "Neon: main (connectionString)",
      value: { kind: "resource" as const, resourceId: "r", output: "o" },
    };
    expect(withKind(entry, "secret")).toEqual({ key: "DB", value: { kind: "secret", name: "" } });
    expect(withKind({ ...entry, value: { kind: "literal", value: "x" } }, "secret").comment).toBe(
      entry.comment,
    );
    const named = withKind({ key: "DB", value: { kind: "literal", value: "" } }, "resource");
    expect(named.value.kind).toBe("named-resource");
    // By name and by id are one choice in the kind picker.
    expect(editorKind(named.value)).toBe("resource");
    expect(withKind({ ...entry, value: named.value }, "resource")).toEqual({
      ...entry,
      value: named.value,
    });
  });

  it("points a row at a picked output by name, naming it when it has no key", () => {
    const entries = doc().shared;
    const fresh = pickResource(entries, null, neon, neon.outputs[0]!);
    expect(fresh).toEqual({
      key: "CONNECTION_STRING",
      value: {
        kind: "named-resource",
        match: { pluginId: "neon", resourceTypeId: "neon-branch", name: "main" },
        output: "connectionString",
      },
      comment: "Neon: main (connectionString)",
    });
    expect(serializeInfraenv(putEntry(doc(), null, null, fresh))).toContain(
      'CONNECTION_STRING = resource("neon/neon-branch", "main", "connectionString")',
    );
    const pinned = pickResource(entries, null, neon, neon.outputs[0]!, { pin: true, loaded: [] });
    expect(pinned.value).toEqual({
      kind: "resource",
      resourceId: "res_neon",
      output: "connectionString",
    });
    expect(pickResource(entries, null, neon, neon.outputs[1]!).key).toBe("PGHOST");
    // An existing key is kept.
    expect(pickResource(entries, 1, neon, neon.outputs[0]!).key).toBe("DATABASE_URL");
  });

  it("makes suggested keys unique within the scope", () => {
    const entries = doc().shared;
    expect(uniqueKey("NODE_ENV", entries)).toBe("NODE_ENV_2");
    expect(uniqueKey("NODE_ENV", entries, 0)).toBe("NODE_ENV");
    expect(uniqueKey("FRESH", entries)).toBe("FRESH");
  });
});

describe("by-name references", () => {
  const twin: InfraenvSource = { ...neon, resourceId: "res_neon_2", accountName: "Staging" };

  it("adds the account when another loaded resource has the same name", () => {
    expect(namedMatchFor(neon, [neon])).toEqual({
      pluginId: "neon",
      resourceTypeId: "neon-branch",
      name: "main",
    });
    expect(namedMatchFor(neon, [neon, twin])).toEqual({
      pluginId: "neon",
      resourceTypeId: "neon-branch",
      name: "main",
      account: "Prod",
    });
    // A different type with the same name is no twin.
    expect(namedMatchFor(neon, [{ ...twin, resourceTypeId: "neon-project" }])?.account).toBe(
      undefined,
    );
  });

  it("pins by id when not even the account tells them apart", () => {
    const sameAccount = { ...twin, accountName: "Prod" };
    expect(namedMatchFor(neon, [neon, sameAccount])).toBeNull();
    const picked = pickResource([], null, neon, neon.outputs[0]!, {
      pin: false,
      loaded: [neon, sameAccount],
    });
    expect(picked.value.kind).toBe("resource");
  });

  it("escapes a name that looks like a substitution", () => {
    const odd = { ...neon, displayName: "a ${b} $${c} ${d" };
    const escaped = escapeInfraenvTemplate(odd.displayName);
    expect(escaped).toBe("a $${b} $$${c} ${d");
    expect(expandInfraenvTemplate(escaped, new Map())).toEqual({
      ok: true,
      value: odd.displayName,
    });
    const picked = pickResource([], null, odd, neon.outputs[0]!);
    const round = parseInfraenv(serializeInfraenv(putEntry(doc(), null, null, picked)));
    expect(round.problems).toEqual([]);
    expect(round.document.shared.at(-1)!.value).toEqual(picked.value);
  });

  it("renames the match and the comment the picker wrote", () => {
    const picked = pickResource([], null, neon, neon.outputs[0]!);
    const renamed = withResourceName(picked, "storefront / ${stage}");
    expect(renamed.value).toMatchObject({ match: { name: "storefront / ${stage}" } });
    expect(renamed.comment).toBe("Neon: storefront / ${stage} (connectionString)");
    const authored = withResourceName({ ...picked, comment: "Primary database" }, "other");
    expect(authored.comment).toBe("Primary database");
  });

  it("switches between by name and by id from what describe found", () => {
    const named: InfraenvValue = {
      kind: "named-resource",
      match: { pluginId: "neon", resourceTypeId: "neon-branch", name: "main" },
      output: "connectionString",
    };
    const hit: InfraenvResourceDescription = {
      ref: infraenvReferenceKey(named),
      resourceId: "res_neon",
      output: "connectionString",
      found: true,
      displayName: "main",
      pluginId: "neon",
      resourceTypeId: "neon-branch",
      outputKnown: true,
      sensitive: true,
    };
    const byId = toggledReference(named, hit);
    expect(byId).toEqual({ kind: "resource", resourceId: "res_neon", output: "connectionString" });
    expect(toggledReference(byId!, hit)).toEqual(named);
    expect(toggledReference(named, { ...hit, found: false })).toBeNull();
    expect(toggledReference(named, null)).toBeNull();
  });
});

describe("substitutions", () => {
  const SOURCE_WITH_VARS = [
    "[vars]",
    "stage = dev",
    "region = eu",
    "",
    "[env]",
    'DB = resource("neon/neon-branch", "storefront / ${stage}", "connectionString")',
    'KEY = secret("STRIPE_${stage}")',
    "",
    "[vars.production]",
    "stage = prod",
    "",
    "[env.production]",
    "NODE_ENV = production",
    "",
  ].join("\n");
  const withVars = () => {
    const parsed = parseInfraenv(SOURCE_WITH_VARS);
    expect(parsed.problems).toEqual([]);
    return parsed.document;
  };

  it("lays a named environment's substitutions over the shared ones", () => {
    expect(varRowsFor(withVars(), null).map((r) => [r.v.key, r.index, r.inherited])).toEqual([
      ["stage", 0, false],
      ["region", 1, false],
    ]);
    expect(
      varRowsFor(withVars(), "production").map((r) => [
        r.v.key,
        r.v.value,
        r.index,
        r.inherited,
        r.overrides,
      ]),
    ).toEqual([
      ["stage", "prod", 0, false, true],
      ["region", "eu", null, true, false],
    ]);
  });

  it("adds, overrides, edits and removes", () => {
    let d = putVar(withVars(), null, null, { key: "team", value: "web" });
    expect(scopeVars(d, null).map((v) => v.key)).toEqual(["stage", "region", "team"]);
    d = overrideVar(d, "production", { key: "region", value: "eu" });
    d = overrideVar(d, "production", { key: "region", value: "eu" });
    expect(scopeVars(d, "production").map((v) => v.key)).toEqual(["stage", "region"]);
    d = putVar(d, "production", 1, { key: "region", value: "us" });
    expect(serializeInfraenv(d)).toContain("[vars.production]\nstage = prod\nregion = us");
    d = removeVar(removeVar(d, "production", 0), "production", 0);
    expect(d.environments[0]!.vars).toBeUndefined();
    expect(serializeInfraenv(d)).not.toContain("[vars.production]");
    d = removeVar(removeVar(removeVar(d, null, 0), null, 0), null, 0);
    expect(d.vars).toBeUndefined();
    expect(serializeInfraenv(d)).not.toContain("[vars]");
  });

  it("validates substitution names and counts them as document problems", () => {
    let d = putVar(withVars(), null, null, { key: "", value: "" });
    d = putVar(d, null, null, { key: "1x", value: "" });
    d = putVar(d, "production", null, { key: "stage", value: "again" });
    expect(varProblem(scopeVars(d, null), 2)).toBe("key-missing");
    expect(varProblem(scopeVars(d, null), 3)).toBe("key-invalid");
    expect(varProblem(scopeVars(d, "production"), 1)).toBe("key-duplicate");
    expect(varProblem(scopeVars(d, null), 0)).toBeNull();
    expect(documentProblemCount(d)).toBe(4);
  });

  it("matches rows to describe results per scope after expanding", () => {
    const d = withVars();
    const db = d.shared[0]!.value;
    const ref = (stage: string) =>
      infraenvReferenceKey({
        kind: "named-resource",
        match: { pluginId: "neon", resourceTypeId: "neon-branch", name: `storefront / ${stage}` },
        output: "connectionString",
      });
    const described: InfraenvDescribeResponse = {
      problems: [],
      environments: ["production"],
      resources: [
        {
          ref: ref("dev"),
          resourceId: "res_dev",
          matches: 1,
          output: "connectionString",
          found: true,
          accountName: "Dev",
          outputKnown: true,
          sensitive: true,
        },
        {
          ref: ref("prod"),
          matches: 3,
          output: "connectionString",
          found: false,
          outputKnown: true,
          sensitive: true,
        },
      ],
      secrets: [
        { name: "STRIPE_dev", found: true, hasValue: true },
        { name: "STRIPE_prod", found: false, hasValue: false },
      ],
    };
    const shared = infraenvVariables(d, null);
    const production = infraenvVariables(d, "production");
    expect(describedResource(db, described, shared)?.resourceId).toBe("res_dev");
    expect(referenceState(db, described, shared)).toEqual({ state: "ok" });
    expect(referenceState(db, described, production)).toEqual({ state: "ambiguous", matches: 3 });
    const key = d.shared[1]!.value;
    expect(referenceState(key, described, shared)).toEqual({ state: "ok" });
    expect(referenceState(key, described, production)).toEqual({
      state: "secret-not-found",
      name: "STRIPE_prod",
    });
    expect(referenceState(db, described, new Map())).toEqual({
      state: "substitution-missing",
      missing: ["stage"],
    });
    // A missing substitution shows before describe answers.
    expect(referenceState(db, null, new Map()).state).toBe("substitution-missing");
  });

  it("leaves the org setting alone: kept when loaded, never added", () => {
    expect(
      serializeInfraenv(putVar(withVars(), null, null, { key: "x", value: "y" })),
    ).not.toContain("org =");
    const pinned = parseInfraenv(`[infrawrench]\norg = org_1\n\n${SOURCE_WITH_VARS}`).document;
    expect(serializeInfraenv(removeVar(pinned, null, 0))).toContain("[infrawrench]\norg = org_1");
  });
});

describe("environments", () => {
  it("adds, renames and removes", () => {
    const added = addEnvironment(doc(), "staging");
    expect(added.environments.map((e) => e.name)).toEqual(["production", "staging"]);
    const renamed = renameEnvironment(added, "staging", "preview");
    expect(renamed.environments.map((e) => e.name)).toEqual(["production", "preview"]);
    expect(removeEnvironment(renamed, "production").environments.map((e) => e.name)).toEqual([
      "preview",
    ]);
  });

  it("refuses invalid and taken names", () => {
    expect(environmentNameProblem(doc(), "has space")).toBe("invalid");
    expect(environmentNameProblem(doc(), "production")).toBe("taken");
    expect(environmentNameProblem(doc(), "production", "production")).toBeNull();
    expect(addEnvironment(doc(), "production")).toEqual(doc());
  });
});

describe("validation", () => {
  it("counts incomplete rows across every scope", () => {
    expect(documentProblemCount(doc())).toBe(0);
    let d = putEntry(doc(), null, null, { key: "", value: { kind: "literal", value: "" } });
    d = putEntry(d, "production", null, {
      key: "DB",
      value: { kind: "resource", resourceId: "", output: "" },
    });
    d = putEntry(d, "production", null, {
      key: "NAMED",
      value: {
        kind: "named-resource",
        match: { pluginId: "neon", resourceTypeId: "neon-branch", name: "" },
        output: "host",
      },
    });
    d = putEntry(d, "production", null, { key: "1BAD", value: { kind: "literal", value: "" } });
    expect(documentProblemCount(d)).toBe(4);
    expect(rowProblem(d.shared, 3)).toBe("key-missing");
    expect(rowProblem(d.environments[0]!.entries, 2)).toBe("resource-missing");
    expect(rowProblem(d.environments[0]!.entries, 3)).toBe("resource-missing");
    expect(rowProblem(d.environments[0]!.entries, 4)).toBe("key-invalid");
  });
});

describe("referenceState", () => {
  const resource = (resourceId: string, output: string) =>
    ({ kind: "resource", resourceId, output }) as const;
  const secret = (name: string) => ({ kind: "secret", name }) as const;
  const ref = (resourceId: string, output: string) =>
    infraenvReferenceKey(resource(resourceId, output));
  const described: InfraenvDescribeResponse = {
    problems: [],
    environments: ["production"],
    resources: [
      {
        ref: ref("res_db", "connectionString"),
        resourceId: "res_db",
        output: "connectionString",
        found: true,
        outputKnown: true,
        sensitive: true,
      },
      {
        ref: ref("gone", "x"),
        resourceId: "gone",
        output: "x",
        found: false,
        outputKnown: false,
        sensitive: false,
      },
      {
        ref: ref("res_db", "nope"),
        resourceId: "res_db",
        output: "nope",
        found: true,
        outputKnown: false,
        sensitive: false,
      },
    ],
    secrets: [
      { name: "STRIPE_KEY", found: true, hasValue: true },
      { name: "EMPTY", found: true, hasValue: false },
      { name: "MISSING", found: false, hasValue: false },
    ],
  };
  const state = (value: InfraenvValue, d: InfraenvDescribeResponse | null) =>
    referenceState(value, d).state;

  it("reads each reference's state", () => {
    expect(state({ kind: "literal", value: "x" }, null)).toBe("ok");
    expect(state(resource("res_db", "connectionString"), null)).toBe("unknown");
    expect(state(resource("res_db", "connectionString"), described)).toBe("ok");
    expect(state(resource("gone", "x"), described)).toBe("resource-not-found");
    expect(state(resource("res_db", "nope"), described)).toBe("output-unknown");
    expect(state(secret("STRIPE_KEY"), described)).toBe("ok");
    expect(state(secret("EMPTY"), described)).toBe("secret-without-value");
    expect(referenceState(secret("MISSING"), described)).toEqual({
      state: "secret-not-found",
      name: "MISSING",
    });
    expect(state(secret("OTHER"), described)).toBe("unknown");
  });
});

describe("fileNameOf", () => {
  it("takes the last path segment", () => {
    expect(fileNameOf("apps/web/.infraenv")).toBe(".infraenv");
    expect(fileNameOf("")).toBe(".infraenv");
  });
});
