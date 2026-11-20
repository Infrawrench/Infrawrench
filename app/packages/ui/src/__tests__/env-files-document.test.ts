import { describe, expect, it } from "vitest";
import {
  parseInfraenv,
  serializeInfraenv,
  type InfraenvDescribeResponse,
  type InfraenvDocument,
  type InfraenvSource,
} from "@infrawrench/client-core";
import {
  addEnvironment,
  documentProblemCount,
  environmentNameProblem,
  fileNameOf,
  overrideEntry,
  pickResource,
  putEntry,
  referenceState,
  removeEntry,
  removeEnvironment,
  renameEnvironment,
  rowProblem,
  rowsFor,
  uniqueKey,
  withKind,
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
  });

  it("points a row at a picked output, naming it when it has no key", () => {
    const entries = doc().shared;
    const fresh = pickResource(entries, null, neon, neon.outputs[0]!);
    expect(fresh).toEqual({
      key: "CONNECTION_STRING",
      value: { kind: "resource", resourceId: "res_neon", output: "connectionString" },
      comment: "Neon: main (connectionString)",
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
    d = putEntry(d, "production", null, { key: "1BAD", value: { kind: "literal", value: "" } });
    expect(documentProblemCount(d)).toBe(3);
    expect(rowProblem(d.shared, 3)).toBe("key-missing");
    expect(rowProblem(d.environments[0]!.entries, 2)).toBe("resource-missing");
    expect(rowProblem(d.environments[0]!.entries, 3)).toBe("key-invalid");
  });
});

describe("referenceState", () => {
  const described: InfraenvDescribeResponse = {
    problems: [],
    environments: ["production"],
    resources: [
      {
        resourceId: "res_db",
        output: "connectionString",
        found: true,
        outputKnown: true,
        sensitive: true,
      },
      { resourceId: "gone", output: "x", found: false, outputKnown: false, sensitive: false },
      { resourceId: "res_db", output: "nope", found: true, outputKnown: false, sensitive: false },
    ],
    secrets: [
      { name: "STRIPE_KEY", found: true, hasValue: true },
      { name: "EMPTY", found: true, hasValue: false },
      { name: "MISSING", found: false, hasValue: false },
    ],
  };
  const resource = (resourceId: string, output: string) =>
    ({ kind: "resource", resourceId, output }) as const;
  const secret = (name: string) => ({ kind: "secret", name }) as const;

  it("reads each reference's state", () => {
    expect(referenceState({ kind: "literal", value: "x" }, null)).toBe("ok");
    expect(referenceState(resource("res_db", "connectionString"), null)).toBe("unknown");
    expect(referenceState(resource("res_db", "connectionString"), described)).toBe("ok");
    expect(referenceState(resource("gone", "x"), described)).toBe("resource-not-found");
    expect(referenceState(resource("res_db", "nope"), described)).toBe("output-unknown");
    expect(referenceState(secret("STRIPE_KEY"), described)).toBe("ok");
    expect(referenceState(secret("EMPTY"), described)).toBe("secret-without-value");
    expect(referenceState(secret("MISSING"), described)).toBe("secret-not-found");
    expect(referenceState(secret("OTHER"), described)).toBe("unknown");
  });
});

describe("fileNameOf", () => {
  it("takes the last path segment", () => {
    expect(fileNameOf("apps/web/.infraenv")).toBe(".infraenv");
    expect(fileNameOf("")).toBe(".infraenv");
  });
});
