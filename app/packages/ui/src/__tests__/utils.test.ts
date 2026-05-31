import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deriveSSHUsername,
  formatSize,
  formatDate,
  groupBy,
  formatErrorMessage,
  evaluateShowWhen,
  buildDefaultFields,
  getAccountResourceTypes,
  getListableResourceTypes,
  isCreateOnlyType,
  extractHostLabel,
  buildChildResourceGroups,
  resourceTabTitle,
  dispatchResourcesChanged,
  dispatchRefreshResource,
  dispatchNavigateToResource,
  dispatchInvokePluginAction,
  dispatchRerollParentOutput,
  dispatchPromptNoSqlCommand,
  RESOURCES_CHANGED_EVENT,
  REFRESH_RESOURCE_EVENT,
  NAVIGATE_TO_RESOURCE_EVENT,
  INVOKE_PLUGIN_ACTION_EVENT,
  REROLL_PARENT_OUTPUT_EVENT,
  PROMPT_NOSQL_COMMAND_EVENT,
} from "../utils";

describe("deriveSSHUsername", () => {
  it("extracts the user part before @", () => {
    expect(deriveSSHUsername("alice@host")).toBe("alice");
  });
  it("returns root for empty comment", () => {
    expect(deriveSSHUsername("")).toBe("root");
  });
  it("returns the whole string when no @", () => {
    expect(deriveSSHUsername("ubuntu")).toBe("ubuntu");
  });
});

describe("formatSize", () => {
  it("returns em dash for 0", () => {
    expect(formatSize(0)).toBe("—");
  });
  it("formats bytes", () => {
    expect(formatSize(512)).toBe("512 B");
  });
  it("formats KB", () => {
    expect(formatSize(2048)).toBe("2.0 KB");
  });
  it("formats MB", () => {
    expect(formatSize(5 * 1_048_576)).toBe("5.0 MB");
  });
  it("formats GB", () => {
    expect(formatSize(3 * 1_073_741_824)).toBe("3.00 GB");
  });
});

describe("formatDate", () => {
  it("returns em dash for empty string", () => {
    expect(formatDate("")).toBe("—");
  });
  it("formats an ISO date", () => {
    const out = formatDate("2024-01-15T10:30:00Z");
    expect(out).toMatch(/2024/);
  });
});

describe("groupBy", () => {
  it("groups items by derived key", () => {
    const out = groupBy(
      [
        { t: "a", n: 1 },
        { t: "b", n: 2 },
        { t: "a", n: 3 },
      ],
      (x) => x.t,
    );
    expect(out["a"]).toHaveLength(2);
    expect(out["b"]).toHaveLength(1);
  });
  it("returns empty object for empty array", () => {
    expect(groupBy([], () => "k")).toEqual({});
  });
});

describe("formatErrorMessage", () => {
  it("strips Error: prefix", () => {
    expect(formatErrorMessage(new Error("boom"))).toBe("boom");
  });
  it("strips the remote-method wrapper", () => {
    expect(formatErrorMessage("Error invoking remote method 'x': real problem")).toBe(
      "real problem",
    );
  });
  it("maps ECONNREFUSED to a friendly message", () => {
    expect(formatErrorMessage("connect ECONNREFUSED 1.2.3.4")).toMatch(/Connection refused/);
  });
  it("maps ENOTFOUND to host not found", () => {
    expect(formatErrorMessage("getaddrinfo ENOTFOUND host")).toMatch(/Host not found/);
  });
  it("maps timeouts", () => {
    expect(formatErrorMessage("operation timed out")).toMatch(/timed out/);
  });
  it("prefixes auth errors", () => {
    expect(formatErrorMessage("unauthorized request")).toMatch(/Authentication or permission/);
  });
  it("extracts message from a top-level JSON message field", () => {
    const payload = JSON.stringify({ message: "top message" });
    expect(formatErrorMessage(payload)).toBe("top message");
  });
  it("extracts message from a nested error object", () => {
    const payload = JSON.stringify({ error: { message: "nested message" } });
    expect(formatErrorMessage(payload)).toBe("nested message");
  });
  it("unwraps a doubly-stringified error payload", () => {
    const inner = JSON.stringify({ message: "inner" });
    const payload = JSON.stringify({ error: inner });
    expect(formatErrorMessage(payload)).toBe("inner");
  });
  it("surfaces a Google SERVICE_DISABLED error with activation url", () => {
    const gcp = JSON.stringify({
      error: {
        message: "disabled",
        details: [
          {
            reason: "SERVICE_DISABLED",
            metadata: {
              serviceTitle: "Compute Engine API",
              containerInfo: "proj-1",
              activationUrl: "https://console.cloud.google.com/x",
            },
          },
        ],
      },
    });
    const out = formatErrorMessage(gcp);
    expect(out).toContain("Compute Engine API is not enabled for project proj-1");
    expect(out).toContain("https://console.cloud.google.com/x");
  });
  it("surfaces cloud scheduler app-engine guidance", () => {
    const gcp = JSON.stringify({ error: { message: "sync mutate calls cannot be queued" } });
    expect(formatErrorMessage(gcp)).toMatch(/App Engine application/);
  });
  it("prefixes permission denied with message", () => {
    const gcp = JSON.stringify({ error: { status: "PERMISSION_DENIED", message: "no access" } });
    expect(formatErrorMessage(gcp)).toBe("Permission denied. no access");
  });
  it("handles non-error thrown values", () => {
    expect(formatErrorMessage("plain string")).toBe("plain string");
    expect(formatErrorMessage(null)).toBe("Unknown error");
  });
});

describe("evaluateShowWhen", () => {
  it("returns true when no rule", () => {
    expect(evaluateShowWhen({}, {})).toBe(true);
  });
  it("matches fieldValue equality", () => {
    expect(evaluateShowWhen({ showWhen: { fieldKey: "k", fieldValue: "a" } }, { k: "a" })).toBe(
      true,
    );
    expect(evaluateShowWhen({ showWhen: { fieldKey: "k", fieldValue: "a" } }, { k: "b" })).toBe(
      false,
    );
  });
  it("matches fieldValues membership", () => {
    expect(
      evaluateShowWhen({ showWhen: { fieldKey: "k", fieldValues: ["a", "b"] } }, { k: "b" }),
    ).toBe(true);
  });
  it("respects fieldValuesNot exclusion", () => {
    expect(
      evaluateShowWhen({ showWhen: { fieldKey: "k", fieldValuesNot: ["x"] } }, { k: "x" }),
    ).toBe(false);
    expect(
      evaluateShowWhen({ showWhen: { fieldKey: "k", fieldValuesNot: ["x"] } }, { k: "y" }),
    ).toBe(true);
  });
  it("handles allOf rules", () => {
    const rule = {
      showWhen: {
        allOf: [
          { fieldKey: "a", fieldValue: "1" },
          { fieldKey: "b", fieldValue: "2" },
        ],
      },
    };
    expect(evaluateShowWhen(rule, { a: "1", b: "2" })).toBe(true);
    expect(evaluateShowWhen(rule, { a: "1", b: "3" })).toBe(false);
  });
  it("handles anyOf rules", () => {
    const rule = {
      showWhen: {
        anyOf: [
          { fieldKey: "a", fieldValue: "1" },
          { fieldKey: "b", fieldValue: "2" },
        ],
      },
    };
    expect(evaluateShowWhen(rule, { a: "9", b: "2" })).toBe(true);
    expect(evaluateShowWhen(rule, { a: "9", b: "9" })).toBe(false);
  });
});

describe("buildDefaultFields", () => {
  it("uses defaultValue", () => {
    expect(buildDefaultFields([{ key: "k", kind: "text", defaultValue: "v" }])).toEqual({ k: "v" });
  });
  it("defaults disk-slider to defaultGb", () => {
    expect(buildDefaultFields([{ key: "d", kind: "disk-slider", defaultGb: 50 }])).toEqual({
      d: "50",
    });
  });
  it("defaults disk-slider to minGb then 20", () => {
    expect(buildDefaultFields([{ key: "d", kind: "disk-slider", minGb: 10 }])).toEqual({ d: "10" });
    expect(buildDefaultFields([{ key: "d", kind: "disk-slider" }])).toEqual({ d: "20" });
  });
  it("ignores fields without default or slider", () => {
    expect(buildDefaultFields([{ key: "k", kind: "text" }])).toEqual({});
  });
});

describe("resource type filters", () => {
  const types = [
    { id: "top" },
    { id: "child", parentTypeId: "top" },
    { id: "child-sidebar", parentTypeId: "top", showInSidebar: true },
    { id: "child-create", parentTypeId: "top", supportsCreate: true },
  ];

  it("getAccountResourceTypes keeps top-level, sidebar, and create-only children", () => {
    const ids = getAccountResourceTypes(types).map((t) => t.id);
    expect(ids).toEqual(["top", "child-sidebar", "child-create"]);
  });

  it("getListableResourceTypes keeps top-level and sidebar children only", () => {
    const ids = getListableResourceTypes(types).map((t) => t.id);
    expect(ids).toEqual(["top", "child-sidebar"]);
  });

  it("isCreateOnlyType true only for create-only child", () => {
    expect(isCreateOnlyType({ parentTypeId: "top", supportsCreate: true })).toBe(true);
    expect(
      isCreateOnlyType({ parentTypeId: "top", showInSidebar: true, supportsCreate: true }),
    ).toBe(false);
    expect(isCreateOnlyType({ supportsCreate: true })).toBe(false);
  });
});

describe("extractHostLabel", () => {
  it("returns empty when no host fields", () => {
    expect(extractHostLabel({})).toBe("");
  });
  it("returns host directly", () => {
    expect(extractHostLabel({ host: "db.example.com" })).toBe("db.example.com");
  });
  it("parses hostname from URL", () => {
    expect(extractHostLabel({ host: "https://db.example.com:5432" })).toBe("db.example.com");
  });
  it("falls back to region then engine", () => {
    expect(extractHostLabel({ region: "us-east-1" })).toBe("us-east-1");
    expect(extractHostLabel({ engine: "postgres" })).toBe("postgres");
  });
  it("truncates long hosts", () => {
    const out = extractHostLabel({ host: "a".repeat(40) }, 10);
    // Truncation keeps maxLength-2 chars and appends a single-char ellipsis (…).
    expect(out.length).toBe(9);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("buildChildResourceGroups", () => {
  it("groups child resources by type and drops empty non-creatable groups", () => {
    const childTypes = [
      { id: "t1", displayName: "T1", pluralDisplayName: "T1s" },
      { id: "t2", displayName: "T2", pluralDisplayName: "T2s", supportsCreate: true },
      { id: "t3", displayName: "T3", pluralDisplayName: "T3s" },
    ];
    const childResources = [
      {
        id: "r1",
        displayName: "R1",
        pluginId: "p",
        resourceTypeId: "t1",
        accountId: "a",
      },
    ];
    const groups = buildChildResourceGroups(childTypes, childResources);
    const ids = groups.map((g) => g.typeId);
    expect(ids).toContain("t1"); // has a resource
    expect(ids).toContain("t2"); // supportsCreate
    expect(ids).not.toContain("t3"); // empty + non-creatable
    expect(groups.find((g) => g.typeId === "t1")!.resources).toHaveLength(1);
  });

  it("carries fields when present", () => {
    const groups = buildChildResourceGroups(
      [{ id: "t", displayName: "T", pluralDisplayName: "Ts", supportsCreate: true, fields: [{}] }],
      [],
    );
    expect(groups[0]!.fields).toEqual([{}]);
  });
});

describe("resourceTabTitle", () => {
  it("prefixes ssh / sftp", () => {
    expect(resourceTabTitle("Box", "ssh")).toBe("SSH: Box");
    expect(resourceTabTitle("Box", "sftp")).toBe("SFTP: Box");
  });
  it("returns name for details / unknown view", () => {
    expect(resourceTabTitle("Box", "details")).toBe("Box");
    expect(resourceTabTitle("Box")).toBe("Box");
  });
});

describe("event dispatchers", () => {
  const events: Array<{ type: string; cleanup: () => void }> = [];
  afterEach(() => {
    while (events.length) events.pop()!.cleanup();
  });

  function capture(type: string): () => CustomEvent | undefined {
    let received: CustomEvent | undefined;
    const handler = (e: Event) => {
      received = e as CustomEvent;
    };
    window.addEventListener(type, handler);
    events.push({ type, cleanup: () => window.removeEventListener(type, handler) });
    return () => received;
  }

  it("dispatchResourcesChanged with string accountId", () => {
    const get = capture(RESOURCES_CHANGED_EVENT);
    dispatchResourcesChanged("acc-1", "vm");
    expect(get()!.detail).toEqual({ accountId: "acc-1", resourceTypeId: "vm" });
  });

  it("dispatchResourcesChanged with detail object", () => {
    const get = capture(RESOURCES_CHANGED_EVENT);
    dispatchResourcesChanged({ resourceTypeId: "vm" });
    expect(get()!.detail).toEqual({ resourceTypeId: "vm" });
  });

  it("dispatchResourcesChanged with no detail", () => {
    const get = capture(RESOURCES_CHANGED_EVENT);
    dispatchResourcesChanged();
    expect(get()!.detail).toBeNull();
  });

  it("dispatchRefreshResource fires the event", () => {
    const get = capture(REFRESH_RESOURCE_EVENT);
    dispatchRefreshResource();
    expect(get()).toBeDefined();
  });

  it("dispatchNavigateToResource carries the detail", () => {
    const get = capture(NAVIGATE_TO_RESOURCE_EVENT);
    dispatchNavigateToResource({ pluginId: "p", resourceTypeId: "t", resourceId: "r" });
    expect(get()!.detail).toEqual({ pluginId: "p", resourceTypeId: "t", resourceId: "r" });
  });

  it("dispatchInvokePluginAction carries the detail", () => {
    const get = capture(INVOKE_PLUGIN_ACTION_EVENT);
    dispatchInvokePluginAction({ actionId: "a", resourceId: "r" });
    expect(get()!.detail).toEqual({ actionId: "a", resourceId: "r" });
  });

  it("dispatchRerollParentOutput carries the detail", () => {
    const get = capture(REROLL_PARENT_OUTPUT_EVENT);
    dispatchRerollParentOutput({ outputKey: "k" });
    expect(get()!.detail).toEqual({ outputKey: "k" });
  });

  it("dispatchPromptNoSqlCommand carries the detail", () => {
    const get = capture(PROMPT_NOSQL_COMMAND_EVENT);
    dispatchPromptNoSqlCommand({ command: "db.x.find()", fields: [] });
    expect(get()!.detail).toEqual({ command: "db.x.find()", fields: [] });
  });
});
