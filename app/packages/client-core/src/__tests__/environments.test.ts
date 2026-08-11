import { describe, expect, it } from "vitest";
import {
  ENVIRONMENT_LIMITS,
  applyChosenParameters,
  applyNamePrefix,
  buildCaptureDraft,
  buildInstantiationPlan,
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
