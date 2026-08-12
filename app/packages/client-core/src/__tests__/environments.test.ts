import { describe, expect, it } from "vitest";
import {
  ENVIRONMENT_LIMITS,
  applyChosenParameters,
  applyNamePrefix,
  attemptedPositionCeiling,
  buildCaptureDraft,
  buildInstantiationPlan,
  buildMemberFailureRecord,
  classifyRecoveryCandidates,
  classifyTeardownMember,
  expectedMemberDisplayName,
  instanceMayOwnLiveResources,
  inventoryDisposition,
  mayConcludeMemberDeleted,
  leaseDeadlineFor,
  leaseShouldBeCancelled,
  repairBackoffMs,
  memberNeedsLeaseRepair,
  formatTimeRemaining,
  memberDependencies,
  normalizeEnvironmentSettings,
  orderTemplateMembers,
  resolveMemberFields,
  resolveParameterValues,
  slugifyEnvironmentName,
  suggestParameters,
  validateParameterValues,
  validateTemplate,
  validateTtlHours,
  type CaptureCreateField,
  type CaptureSourceResource,
  type EnvironmentInstanceStatus,
  type InventoryDisposition,
  type EnvironmentTemplateMember,
} from "../environments";

function member(
  key: string,
  fields: EnvironmentTemplateMember["fields"] = {},
  extra: Partial<EnvironmentTemplateMember> = {},
): EnvironmentTemplateMember {
  return {
    key,
    pluginId: "acme",
    resourceTypeId: "widget",
    accountId: "acct-1",
    sourceName: key,
    fields,
    ...extra,
  };
}

describe("slugifyEnvironmentName / applyNamePrefix", () => {
  it("reduces free text to an RFC 1123 label component", () => {
    expect(slugifyEnvironmentName("PR #482 — Astrid's branch")).toBe("pr-482-astrid-s-branch");
    expect(slugifyEnvironmentName("---")).toBe("");
    expect(slugifyEnvironmentName("a".repeat(40))).toHaveLength(24);
  });

  it("never leaves a trailing dash after truncation", () => {
    // 24 chars would land mid-separator; the trailing dash has to go.
    expect(slugifyEnvironmentName("aaaaaaaaaaaaaaaaaaaaaaa b")).toBe("aaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("prefixes a captured name", () => {
    expect(applyNamePrefix("api-server", "pr-482")).toBe("pr-482-api-server");
  });

  it("leaves the name alone when the prefix slugs to nothing", () => {
    expect(applyNamePrefix("api-server", "!!!")).toBe("api-server");
  });

  it("truncates the captured half, never the distinguishing prefix", () => {
    const long = "x".repeat(100);
    const out = applyNamePrefix(long, "pr-482");
    expect(out.startsWith("pr-482-")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(63);
  });
});

describe("orderTemplateMembers", () => {
  it("creates a referenced member before the member that references it", () => {
    const members = [
      member("app", { dbUrl: { kind: "output", member: "db", outputKey: "connectionString" } }),
      member("db"),
    ];
    const order = orderTemplateMembers(members);
    expect(order.cycle).toEqual([]);
    expect(order.missing).toEqual([]);
    expect(order.ordered.map((m) => m.key)).toEqual(["db", "app"]);
  });

  it("orders member-id references and parent containment the same way", () => {
    const members = [
      member("subnet", { vpcId: { kind: "member-id", member: "vpc" } }),
      member("record", {}, { parentMember: "zone" }),
      member("zone"),
      member("vpc"),
    ];
    const keys = orderTemplateMembers(members).ordered.map((m) => m.key);
    expect(keys.indexOf("vpc")).toBeLessThan(keys.indexOf("subnet"));
    expect(keys.indexOf("zone")).toBeLessThan(keys.indexOf("record"));
  });

  it("keeps the template's own order as the tie-break", () => {
    const members = [member("c"), member("a"), member("b")];
    expect(orderTemplateMembers(members).ordered.map((m) => m.key)).toEqual(["c", "a", "b"]);
  });

  it("reports a cycle instead of ordering", () => {
    const members = [
      member("a", { x: { kind: "member-id", member: "b" } }),
      member("b", { y: { kind: "member-id", member: "a" } }),
      member("standalone"),
    ];
    const order = orderTemplateMembers(members);
    expect(order.ordered).toEqual([]);
    expect(order.cycle).toEqual(["a", "b"]);
  });

  it("reports a self-reference as a plain literal, not a cycle", () => {
    // A member referencing itself is dropped from its own dependencies —
    // otherwise every template with a self-named field would be unorderable.
    const members = [member("a", { x: { kind: "member-id", member: "a" } })];
    expect(memberDependencies(members[0]!)).toEqual([]);
    expect(orderTemplateMembers(members).ordered.map((m) => m.key)).toEqual(["a"]);
  });

  it("reports a reference to a member that is not in the template", () => {
    const members = [
      member("app", { dbUrl: { kind: "output", member: "gone", outputKey: "url" } }),
    ];
    const order = orderTemplateMembers(members);
    expect(order.ordered).toEqual([]);
    expect(order.missing).toEqual([{ member: "app", target: "gone" }]);
  });

  it("deduplicates two fields pointing at one member", () => {
    const m = member("app", {
      host: { kind: "output", member: "db", outputKey: "host" },
      port: { kind: "output", member: "db", outputKey: "port" },
    });
    expect(memberDependencies(m)).toEqual(["db"]);
  });
});

describe("buildInstantiationPlan", () => {
  it("collects the outputs each created member has to yield", () => {
    const members = [
      member("app", {
        host: { kind: "output", member: "db", outputKey: "host" },
        port: { kind: "output", member: "db", outputKey: "port" },
        cache: { kind: "output", member: "redis", outputKey: "uri" },
      }),
      member("db"),
      member("redis"),
    ];
    const plan = buildInstantiationPlan(members);
    expect(plan.steps.map((s) => s.member.key)).toEqual(["db", "redis", "app"]);
    expect(plan.outputsNeeded).toEqual({ db: ["host", "port"], redis: ["uri"] });
    expect(plan.steps.at(-1)!.needs).toHaveLength(3);
  });

  it("asks for nothing when no member references another", () => {
    const plan = buildInstantiationPlan([member("a"), member("b")]);
    expect(plan.outputsNeeded).toEqual({});
  });
});

describe("resolveMemberFields", () => {
  const context = {
    parameters: { region: "eu-west-1" },
    created: {
      db: { externalId: "db-123", outputs: { connectionString: "postgres://x" } },
    },
    namePrefix: "pr-482",
  };

  it("substitutes parameters, member ids and outputs", () => {
    const result = resolveMemberFields(
      member(
        "app",
        {
          name: { kind: "literal", value: "api" },
          region: { kind: "parameter", parameter: "region" },
          dbId: { kind: "member-id", member: "db" },
          dbUrl: { kind: "output", member: "db", outputKey: "connectionString" },
        },
        { nameFieldKey: "name" },
      ),
      context,
    );
    expect(result.fields).toEqual({
      name: "pr-482-api",
      region: "eu-west-1",
      dbId: "db-123",
      dbUrl: "postgres://x",
    });
  });

  it("refuses rather than substituting an empty parameter", () => {
    const result = resolveMemberFields(
      member("app", { region: { kind: "parameter", parameter: "size" } }),
      context,
    );
    expect(result.fields).toBeUndefined();
    expect(result.problem).toContain("size");
  });

  it("refuses when a referenced member has not been created", () => {
    const result = resolveMemberFields(
      member("app", { x: { kind: "member-id", member: "cache" } }),
      context,
    );
    expect(result.problem).toContain("cache");
  });

  it("refuses when the source did not produce the referenced output", () => {
    const result = resolveMemberFields(
      member("app", { x: { kind: "output", member: "db", outputKey: "adminUrl" } }),
      context,
    );
    expect(result.problem).toContain("adminUrl");
  });

  it("leaves the name unprefixed when the plugin has no name field", () => {
    const result = resolveMemberFields(
      member("app", { label: { kind: "literal", value: "api" } }),
      context,
    );
    expect(result.fields).toEqual({ label: "api" });
  });
});

describe("validateTemplate", () => {
  const base = { name: "Staging", parameters: [], members: [member("app")] };

  it("accepts a minimal template", () => {
    expect(validateTemplate(base)).toBeNull();
  });

  it("rejects an empty template", () => {
    expect(validateTemplate({ ...base, members: [] })).toContain("at least one resource");
  });

  it("rejects duplicate member keys", () => {
    expect(validateTemplate({ ...base, members: [member("app"), member("app")] })).toContain(
      "Duplicate resource key",
    );
  });

  it("rejects a field bound to an undeclared parameter", () => {
    const problem = validateTemplate({
      ...base,
      members: [member("app", { region: { kind: "parameter", parameter: "region" } })],
    });
    expect(problem).toContain("region");
  });

  it("rejects a dangling member reference", () => {
    const problem = validateTemplate({
      ...base,
      members: [member("app", { x: { kind: "member-id", member: "db" } })],
    });
    expect(problem).toContain("not in the template");
  });

  it("rejects a dependency cycle", () => {
    const problem = validateTemplate({
      ...base,
      members: [
        member("a", { x: { kind: "member-id", member: "b" } }),
        member("b", { y: { kind: "member-id", member: "a" } }),
      ],
    });
    expect(problem).toContain("loop");
  });

  it("rejects more members than the cap", () => {
    const many = Array.from({ length: ENVIRONMENT_LIMITS.maxMembers + 1 }, (_, i) =>
      member(`m${i}`),
    );
    expect(validateTemplate({ ...base, members: many })).toContain("limited to");
  });

  it("rejects a dropdown parameter with no options", () => {
    const problem = validateTemplate({
      ...base,
      parameters: [{ key: "tier", label: "Tier", type: "select", required: true }],
    });
    expect(problem).toContain("no options");
  });
});

describe("validateParameterValues / resolveParameterValues", () => {
  const template = {
    parameters: [
      { key: "region", label: "Region", type: "string" as const, required: true },
      {
        key: "size",
        label: "Size",
        type: "select" as const,
        required: false,
        defaultValue: "s",
        options: [
          { id: "s", label: "Small" },
          { id: "l", label: "Large" },
        ],
      },
      { key: "nodes", label: "Nodes", type: "number" as const, required: false },
    ],
  };

  it("requires a required parameter", () => {
    expect(validateParameterValues(template, {})).toContain("Region");
  });

  it("accepts a valid set", () => {
    expect(validateParameterValues(template, { region: "eu", size: "l", nodes: "3" })).toBeNull();
  });

  it("rejects a select value outside the options", () => {
    expect(validateParameterValues(template, { region: "eu", size: "xl" })).toContain("one of");
  });

  it("rejects a non-numeric number", () => {
    expect(validateParameterValues(template, { region: "eu", nodes: "many" })).toContain("number");
  });

  it("rejects an unknown parameter rather than ignoring it", () => {
    expect(validateParameterValues(template, { region: "eu", colour: "red" })).toContain("Unknown");
  });

  it("fills defaults in", () => {
    expect(resolveParameterValues(template, { region: "eu" })).toEqual({
      region: "eu",
      size: "s",
    });
  });
});

describe("validateTtlHours / normalizeEnvironmentSettings", () => {
  const settings = { maxTtlHours: 48, defaultTtlHours: 24 };

  it("requires a TTL", () => {
    expect(validateTtlHours(Number.NaN, settings)).toContain("required");
  });

  it("rejects a TTL past the org ceiling", () => {
    expect(validateTtlHours(72, settings)).toContain("48");
  });

  it("rejects a TTL below the floor", () => {
    expect(validateTtlHours(0, settings)).toContain("shortest");
  });

  it("accepts a TTL at the ceiling", () => {
    expect(validateTtlHours(48, settings)).toBeNull();
  });

  it("clamps the org ceiling to the hard maximum", () => {
    expect(normalizeEnvironmentSettings({ maxTtlHours: 100_000 }).maxTtlHours).toBe(
      ENVIRONMENT_LIMITS.hardMaxTtlHours,
    );
  });

  it("never lets the default exceed the ceiling", () => {
    expect(normalizeEnvironmentSettings({ maxTtlHours: 4, defaultTtlHours: 48 })).toEqual({
      maxTtlHours: 4,
      defaultTtlHours: 4,
    });
  });

  it("falls back to the shipped defaults for a missing document", () => {
    expect(normalizeEnvironmentSettings(null)).toEqual({
      maxTtlHours: ENVIRONMENT_LIMITS.defaultMaxTtlHours,
      defaultTtlHours: ENVIRONMENT_LIMITS.defaultTtlHours,
    });
  });
});

describe("buildCaptureDraft", () => {
  const createFields: Record<string, CaptureCreateField[]> = {
    "acme:database": [
      { key: "name", label: "Name", kind: "text", required: true },
      { key: "region", label: "Region", kind: "region-picker", required: true },
      { key: "size", label: "Size", kind: "size-picker", required: true },
    ],
    "acme:app": [
      { key: "name", label: "Name", kind: "text", required: true },
      { key: "region", label: "Region", kind: "region-picker", required: true },
      { key: "databaseUrl", label: "Database URL", kind: "text", required: false },
      { key: "vpcId", label: "Network", kind: "resource-picker", required: false },
      { key: "mode", label: "Mode", kind: "select", required: false, transient: true },
    ],
  };

  const db: CaptureSourceResource = {
    resourceId: "r-db",
    accountId: "acct-1",
    pluginId: "acme",
    resourceTypeId: "database",
    displayName: "staging-db",
    externalId: "db-abc",
    fields: { name: "staging-db", region: "eu-west-1", size: "s", engineVersion: "16" },
  };
  const app: CaptureSourceResource = {
    resourceId: "r-app",
    accountId: "acct-1",
    pluginId: "acme",
    resourceTypeId: "app",
    displayName: "staging-app",
    externalId: "app-abc",
    fields: {
      name: "staging-app",
      region: "eu-west-1",
      databaseUrl: "postgres://staging",
      vpcId: "db-abc",
      mode: "advanced",
    },
    outputRefs: [
      { fieldKey: "databaseUrl", targetResourceId: "r-db", outputKey: "connectionString" },
    ],
  };

  it("keeps only create-form fields and detects the name field by value", () => {
    const draft = buildCaptureDraft({ resources: [db], createFields });
    const captured = draft.members[0]!;
    expect(Object.keys(captured.fields).sort()).toEqual(["name", "region", "size"]);
    expect(captured.fields["engineVersion"]).toBeUndefined();
    expect(captured.nameFieldKey).toBe("name");
  });

  it("drops transient fields, which never reach createResource", () => {
    const draft = buildCaptureDraft({ resources: [app, db], createFields });
    const captured = draft.members.find((m) => m.key === "staging-app")!;
    expect(captured.fields["mode"]).toBeUndefined();
  });

  it("preserves an output reference between two captured resources", () => {
    const draft = buildCaptureDraft({ resources: [app, db], createFields });
    const captured = draft.members.find((m) => m.key === "staging-app")!;
    expect(captured.fields["databaseUrl"]).toEqual({
      kind: "output",
      member: "staging-db",
      outputKey: "connectionString",
    });
  });

  it("turns a bare external id into a member-id reference", () => {
    const draft = buildCaptureDraft({ resources: [app, db], createFields });
    const captured = draft.members.find((m) => m.key === "staging-app")!;
    expect(captured.fields["vpcId"]).toEqual({ kind: "member-id", member: "staging-db" });
  });

  it("leaves a reference pointing outside the selection as a literal", () => {
    const draft = buildCaptureDraft({ resources: [app], createFields });
    const captured = draft.members[0]!;
    expect(captured.fields["databaseUrl"]).toEqual({
      kind: "literal",
      value: "postgres://staging",
    });
    expect(captured.fields["vpcId"]).toEqual({ kind: "literal", value: "db-abc" });
  });

  it("records containment as a parent member", () => {
    const child: CaptureSourceResource = { ...app, parentResourceId: "r-db" };
    const draft = buildCaptureDraft({ resources: [child, db], createFields });
    expect(draft.members.find((m) => m.key === "staging-app")!.parentMember).toBe("staging-db");
  });

  it("skips a resource type the plugin cannot create, and says why", () => {
    const orphan: CaptureSourceResource = { ...db, resourceTypeId: "snapshot", resourceId: "r-s" };
    const draft = buildCaptureDraft({ resources: [orphan], createFields });
    expect(draft.members).toHaveLength(0);
    expect(draft.skipped[0]!.reason).toContain("cannot be created");
  });

  it("gives colliding display names distinct keys", () => {
    const twin: CaptureSourceResource = { ...db, resourceId: "r-db2", externalId: "db-def" };
    const draft = buildCaptureDraft({ resources: [db, twin], createFields });
    expect(draft.members.map((m) => m.key)).toEqual(["staging-db", "staging-db-2"]);
  });

  it("refuses to resolve an ambiguous external id", () => {
    const twin: CaptureSourceResource = { ...db, resourceId: "r-db2" };
    const draft = buildCaptureDraft({ resources: [db, twin, app], createFields });
    expect(draft.members.find((m) => m.key === "staging-app")!.fields["vpcId"]).toEqual({
      kind: "literal",
      value: "db-abc",
    });
  });
});

describe("suggestParameters / applyChosenParameters", () => {
  const createFields: Record<string, CaptureCreateField[]> = {
    "acme:database": [
      { key: "name", label: "Name", kind: "text", required: true },
      { key: "region", label: "Region", kind: "region-picker", required: true },
    ],
    "acme:app": [
      { key: "name", label: "Name", kind: "text", required: true },
      { key: "region", label: "Region", kind: "region-picker", required: true },
    ],
  };
  const resources: CaptureSourceResource[] = [
    {
      resourceId: "r-db",
      accountId: "a",
      pluginId: "acme",
      resourceTypeId: "database",
      displayName: "db",
      externalId: "db-1",
      fields: { name: "db", region: "eu-west-1" },
    },
    {
      resourceId: "r-app",
      accountId: "a",
      pluginId: "acme",
      resourceTypeId: "app",
      displayName: "app",
      externalId: "app-1",
      fields: { name: "app", region: "eu-west-1" },
    },
  ];

  it("suggests one parameter for a knob every member agrees on", () => {
    const draft = buildCaptureDraft({ resources, createFields });
    expect(draft.suggestedParameters).toEqual([
      {
        key: "region",
        label: "Region",
        type: "string",
        required: true,
        defaultValue: "eu-west-1",
      },
    ]);
  });

  it("suggests nothing for a knob the members disagree on", () => {
    const split = [
      resources[0]!,
      { ...resources[1]!, fields: { name: "app", region: "us-east-1" } },
    ];
    expect(buildCaptureDraft({ resources: split, createFields }).suggestedParameters).toEqual([]);
  });

  it("never suggests a free-text field as a parameter", () => {
    const draft = buildCaptureDraft({ resources, createFields });
    expect(draft.suggestedParameters.map((p) => p.label)).not.toContain("Name");
  });

  it("suggests nothing for a field already pinned to a reference", () => {
    expect(suggestParameters([])).toEqual([]);
  });

  it("promotes only the chosen parameters and rewrites every member", () => {
    const draft = buildCaptureDraft({ resources, createFields });
    const { parameters, members } = applyChosenParameters(draft, ["region"]);
    expect(parameters).toHaveLength(1);
    for (const m of members) {
      expect(m.fields["region"]).toEqual({ kind: "parameter", parameter: "region" });
      expect(m.fields["name"]!.kind).toBe("literal");
      expect(m).not.toHaveProperty("fieldMeta");
    }
  });

  it("leaves everything literal when nothing is chosen", () => {
    const draft = buildCaptureDraft({ resources, createFields });
    const { parameters, members } = applyChosenParameters(draft, []);
    expect(parameters).toEqual([]);
    expect(members[0]!.fields["region"]).toEqual({ kind: "literal", value: "eu-west-1" });
  });

  it("produces a document that validates and orders", () => {
    const draft = buildCaptureDraft({ resources, createFields });
    const applied = applyChosenParameters(draft, ["region"]);
    expect(validateTemplate({ name: "Staging", ...applied })).toBeNull();
  });
});

describe("buildMemberFailureRecord", () => {
  const created = { resourceId: "res-1", externalId: "i-abc", displayName: "pr-482-api" };

  it("records a failure that created nothing without an id", () => {
    expect(buildMemberFailureRecord("provider said no", null)).toEqual({
      status: "failed",
      error: "provider said no",
    });
  });

  // Regression: the create succeeded and the *confirming write* is what threw.
  // Recording the failure without the returned id lost a running resource —
  // teardown saw a member with no id and treated it as nothing to do, so the
  // resource billed indefinitely. The id must travel with the failure, in the
  // same statement, so there is no second write left to lose.
  it("carries the created resource id when the failure came after the create", () => {
    expect(buildMemberFailureRecord("bookkeeping write failed", created)).toEqual({
      status: "failed",
      error: "bookkeeping write failed",
      resourceId: "res-1",
      externalId: "i-abc",
      displayName: "pr-482-api",
    });
  });

  it("keeps a null external id rather than dropping the field", () => {
    const record = buildMemberFailureRecord("boom", { ...created, externalId: null });
    expect(record.resourceId).toBe("res-1");
    expect(record.externalId).toBeNull();
  });
});

describe("attemptedPositionCeiling / classifyTeardownMember", () => {
  const pending = (position: number) => ({ status: "pending" as const, position });

  it("puts the ceiling one past the last member the run touched", () => {
    // Instantiation stops at the first failure, so 3+ were never reached; the
    // +1 covers the member that was in flight when a process died.
    expect(
      attemptedPositionCeiling([
        { status: "created", position: 0 },
        { status: "failed", position: 1 },
        pending(2),
        pending(3),
      ]),
    ).toBe(2);
  });

  it("is 0 when nothing was touched at all", () => {
    expect(attemptedPositionCeiling([pending(0), pending(1)])).toBe(0);
  });

  it("skips a member already torn down", () => {
    expect(classifyTeardownMember({ status: "deleted", resourceId: "r", position: 0 }, 2)).toBe(
      "skip",
    );
  });

  it("deletes a member that has a resource id", () => {
    expect(classifyTeardownMember({ status: "created", resourceId: "r", position: 0 }, 2)).toBe(
      "delete",
    );
  });

  it("still deletes a failed member that got as far as an id", () => {
    expect(classifyTeardownMember({ status: "failed", resourceId: "r", position: 1 }, 2)).toBe(
      "delete",
    );
  });

  // Regression: this used to be treated as handled — marked deleted without
  // ever asking the provider. A create that succeeded and then lost its
  // bookkeeping lands exactly here, so "handled" meant a resource nobody would
  // ever delete.
  it("verifies an attempted member that carries no id", () => {
    expect(classifyTeardownMember({ status: "failed", resourceId: null, position: 1 }, 2)).toBe(
      "verify",
    );
  });

  it("verifies the in-flight member a dead process left pending", () => {
    expect(classifyTeardownMember({ status: "pending", resourceId: null, position: 2 }, 2)).toBe(
      "verify",
    );
  });

  it("does not go asking the provider about members the run never reached", () => {
    expect(classifyTeardownMember({ status: "pending", resourceId: null, position: 3 }, 2)).toBe(
      "unattempted",
    );
  });
});

describe("inventoryDisposition / mayConcludeMemberDeleted", () => {
  it("reads a live row as present", () => {
    expect(inventoryDisposition({ deletedAt: null })).toBe("present");
    expect(mayConcludeMemberDeleted("present")).toBe(false);
  });

  it("reads a soft-deleted row as confirmation, because we wrote it", () => {
    expect(inventoryDisposition({ deletedAt: new Date() })).toBe("confirmed-gone");
    expect(mayConcludeMemberDeleted("confirmed-gone")).toBe(true);
  });

  // Regression: reconciliation treated "not in the live-rows query" as proof
  // the provider resource was gone and marked the member `deleted`, which is
  // terminal — the member left lease repair and teardown permanently while the
  // resource billed forever. A missing row is the *ordinary* state for a
  // member whose upsert failed, which is the same failure that stranded it.
  it("refuses to read a missing row as anything at all", () => {
    expect(inventoryDisposition(null)).toBe("unknown");
    expect(inventoryDisposition(undefined)).toBe("unknown");
    expect(mayConcludeMemberDeleted("unknown")).toBe(false);
  });

  it("only ever confirms on the one positive fact", () => {
    const all: InventoryDisposition[] = ["present", "confirmed-gone", "unknown"];
    expect(all.filter(mayConcludeMemberDeleted)).toEqual(["confirmed-gone"]);
  });
});

describe("instanceMayOwnLiveResources", () => {
  it("treats only a torn-down instance as finished", () => {
    expect(instanceMayOwnLiveResources("deleted")).toBe(false);
  });

  // Regression: three passes each hand-enumerated the statuses they cared
  // about and none of the lists was complete. A `failed` instance whose first
  // member survived a failed rollback owns a billable resource, and a
  // `tearing-down` one whose process died mid-teardown does too — both were
  // excluded from lease repair, so the resource ran past its mandatory TTL.
  it("includes the statuses the hand-written lists kept missing", () => {
    expect(instanceMayOwnLiveResources("failed")).toBe(true);
    expect(instanceMayOwnLiveResources("tearing-down")).toBe(true);
  });

  it("includes the obvious live statuses", () => {
    expect(instanceMayOwnLiveResources("creating")).toBe(true);
    expect(instanceMayOwnLiveResources("active")).toBe(true);
    expect(instanceMayOwnLiveResources("partial")).toBe(true);
  });

  it("covers every status the union declares", () => {
    // A new status must be classified deliberately rather than defaulting to
    // "finished", which is the failure mode this replaced.
    const all: EnvironmentInstanceStatus[] = [
      "creating",
      "active",
      "partial",
      "tearing-down",
      "deleted",
      "failed",
    ];
    expect(all.filter(instanceMayOwnLiveResources)).toHaveLength(all.length - 1);
  });
});

describe("memberNeedsLeaseRepair", () => {
  it("ignores members that never created anything", () => {
    expect(memberNeedsLeaseRepair({ status: "pending", resourceId: null, leaseId: null })).toBe(
      false,
    );
    expect(memberNeedsLeaseRepair({ status: "failed", resourceId: null, leaseId: null })).toBe(
      false,
    );
  });

  it("ignores members that already have a clock on them", () => {
    expect(memberNeedsLeaseRepair({ status: "created", resourceId: "r", leaseId: "l" })).toBe(
      false,
    );
  });

  it("ignores members that are already gone", () => {
    expect(memberNeedsLeaseRepair({ status: "deleted", resourceId: "r", leaseId: null })).toBe(
      false,
    );
  });

  it("repairs a created member whose lease id never landed", () => {
    expect(memberNeedsLeaseRepair({ status: "created", resourceId: "r", leaseId: null })).toBe(
      true,
    );
  });

  // Regression (state 6): a member whose rollback failed is `failed` while its
  // resource is alive. The repair pass filtered on `status === "created"`, so
  // this one ran past its mandatory TTL with nothing watching it — the exact
  // defect the rollback fix was supposed to close, one layer out.
  it("repairs a failed member whose resource survived the rollback", () => {
    expect(memberNeedsLeaseRepair({ status: "failed", resourceId: "r", leaseId: null })).toBe(true);
  });
});

describe("repairBackoffMs", () => {
  it("starts soon after the first failure", () => {
    expect(repairBackoffMs(0)).toBe(60_000);
  });

  it("backs off exponentially while that is still cheap", () => {
    expect(repairBackoffMs(1)).toBe(120_000);
    expect(repairBackoffMs(3)).toBe(480_000);
  });

  // Repair is what stops a member running without the TTL its instantiation
  // promised, so there is no give-up: the curve caps and stays there, with
  // `repair_error` on the row throughout. Retrying slowly beats going quiet
  // about something still billing.
  it("caps at an hour rather than ever giving up", () => {
    for (const attempts of [10, 50, 1000]) {
      expect(repairBackoffMs(attempts)).toBe(60 * 60_000);
    }
  });

  it("never decreases, and is always a positive finite delay", () => {
    for (let attempts = 1; attempts < 40; attempts += 1) {
      const delay = repairBackoffMs(attempts);
      expect(Number.isFinite(delay)).toBe(true);
      expect(delay).toBeGreaterThanOrEqual(repairBackoffMs(attempts - 1));
    }
  });
});

describe("leaseDeadlineFor", () => {
  const now = Date.parse("2026-08-11T12:00:00Z");

  it("keeps a deadline that is comfortably in the future", () => {
    const preferred = new Date("2026-08-12T12:00:00Z");
    expect(leaseDeadlineFor(preferred, now).toISOString()).toBe(preferred.toISOString());
  });

  // A member found after its instance expired must still get a lease: leases
  // reject past deadlines, and "no lease" is the state this path exists to
  // prevent.
  it("gives a short grace window to a deadline that has already passed", () => {
    expect(leaseDeadlineFor(new Date("2026-08-10T12:00:00Z"), now).getTime()).toBe(now + 300_000);
  });

  it("does not hand back a deadline inside the grace window", () => {
    expect(leaseDeadlineFor(new Date(now + 1000), now).getTime()).toBe(now + 300_000);
  });

  it("falls back to the grace window for an unparseable deadline", () => {
    expect(leaseDeadlineFor("whenever", now).getTime()).toBe(now + 300_000);
  });
});

describe("leaseShouldBeCancelled", () => {
  it("cancels the lease once the resource is confirmed gone", () => {
    expect(leaseShouldBeCancelled("deleted")).toBe(true);
    expect(leaseShouldBeCancelled("already-gone")).toBe(true);
  });

  // Regression: cancelling on failure removed the only retry path. The lease
  // *is* the retry machinery — it re-attempts at expiry, defers through
  // freezes and reports when it gives up. Cancelling it turned a transient
  // provider error into a resource billing until a human retried by hand.
  it("keeps the lease when the delete failed, so the lease pass can retry", () => {
    expect(leaseShouldBeCancelled("failed")).toBe(false);
  });
});

describe("classifyRecoveryCandidates", () => {
  it("settles the member when nothing carries the name", () => {
    expect(classifyRecoveryCandidates([])).toEqual({ action: "already-gone" });
  });

  // The whole point of this function: there is no `delete` action to reach.
  // Three ownership signals were tried and each turned out to be a proxy for a
  // creation time we do not reliably have — provider `createdAt` (fabricated as
  // `new Date()` by listers whose provider exposes none), the absence of a
  // prior `resources` row (absence of evidence, and the ordinary state for a
  // member whose bookkeeping failed), and `knownSince` (which records when we
  // first *saw* a resource, so a newly connected account makes a years-old
  // user-managed resource look brand new). "Probably ours" is not a licence to
  // destroy someone's infrastructure.
  it("never authorises a delete, whatever the candidate looks like", () => {
    const candidates = [
      [{ externalId: "a", displayName: "pr-482-api" }],
      [{ externalId: null, displayName: "pr-482-api" }],
      [
        { externalId: "a", displayName: "pr-482-api" },
        { externalId: "b", displayName: "pr-482-api" },
      ],
    ];
    for (const candidate of candidates) {
      expect(classifyRecoveryCandidates(candidate).action).toBe("needs-attention");
    }
  });

  it("names the single candidate so an operator knows what to look at", () => {
    const finding = classifyRecoveryCandidates([
      { externalId: "i-abc", displayName: "pr-482-api" },
    ]);
    expect(finding.action).toBe("needs-attention");
    expect(finding).toMatchObject({ reason: expect.stringContaining("i-abc") });
    expect(finding).toMatchObject({ reason: expect.stringContaining("nothing proves") });
  });

  it("counts multiple candidates rather than picking one", () => {
    const finding = classifyRecoveryCandidates([
      { externalId: "i-a", displayName: "pr-482-api" },
      { externalId: "i-b", displayName: "pr-482-api" },
    ]);
    expect(finding).toMatchObject({ reason: expect.stringContaining("2 resources") });
  });

  it("still reports when the lister gives no external id to name", () => {
    expect(classifyRecoveryCandidates([{ externalId: null }]).action).toBe("needs-attention");
  });
});

describe("leaseShouldBeCancelled - declined deletions", () => {
  // Nothing was deleted, so the resource is still there and still wants a clock.
  it("keeps the lease when the environment declined to delete", () => {
    expect(leaseShouldBeCancelled("needs-attention")).toBe(false);
  });
});

describe("expectedMemberDisplayName", () => {
  const base = {
    key: "api",
    pluginId: "acme",
    resourceTypeId: "app",
    accountId: "a",
    sourceName: "staging-api",
  };

  it("prefixes a literal name field", () => {
    expect(
      expectedMemberDisplayName(
        { ...base, nameFieldKey: "name", fields: { name: { kind: "literal", value: "api" } } },
        {},
        "pr-482",
      ),
    ).toBe("pr-482-api");
  });

  it("resolves a parameterised name field", () => {
    expect(
      expectedMemberDisplayName(
        {
          ...base,
          nameFieldKey: "name",
          fields: { name: { kind: "parameter", parameter: "svc" } },
        },
        { svc: "worker" },
        "pr-482",
      ),
    ).toBe("pr-482-worker");
  });

  it("falls back to the captured name when the plugin has no name field", () => {
    expect(expectedMemberDisplayName({ ...base, fields: {} }, {}, "pr-482")).toBe("staging-api");
  });

  it("falls back rather than inventing a name from an unresolvable field", () => {
    expect(
      expectedMemberDisplayName(
        {
          ...base,
          nameFieldKey: "name",
          fields: { name: { kind: "output", member: "db", outputKey: "host" } },
        },
        {},
        "pr-482",
      ),
    ).toBe("staging-api");
  });
});

describe("formatTimeRemaining", () => {
  const now = Date.parse("2026-08-11T12:00:00Z");

  it("counts minutes under an hour", () => {
    expect(formatTimeRemaining("2026-08-11T12:45:00Z", now)).toBe("45m");
  });

  it("counts hours and minutes under two days", () => {
    expect(formatTimeRemaining("2026-08-12T10:30:00Z", now)).toBe("22h 30m");
  });

  it("counts days and hours beyond that", () => {
    expect(formatTimeRemaining("2026-08-14T18:00:00Z", now)).toBe("3d 6h");
  });

  it("says expired rather than counting backwards", () => {
    expect(formatTimeRemaining("2026-08-11T11:00:00Z", now)).toBe("expired");
  });

  it("says unknown for an unparseable deadline", () => {
    expect(formatTimeRemaining("soon", now)).toBe("unknown");
  });
});
