import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Idle collection: what the plugin is asked, what is stored, and that the
 * replacement happens inside one transaction. The DB is a chainable fake that
 * records every write with the handle that issued it.
 */

vi.mock("../db/schema", () => ({
  accountIdleFindings: {
    __t: "accountIdleFindings",
    id: "id",
    accountId: "accountId",
    ruleId: "ruleId",
    subjectKey: "subjectKey",
    evaluatedAt: "evaluatedAt",
  },
  accountIdlePolls: { __t: "accountIdlePolls", accountId: "accountId", failureCount: 0 },
  resources: {
    __t: "resources",
    id: "id",
    resourceTypeId: "resourceTypeId",
    externalId: "externalId",
    displayName: "displayName",
    fieldsJson: "fieldsJson",
    outputsJson: "outputsJson",
    accountId: "accountId",
    deletedAt: "deletedAt",
  },
}));

interface Write {
  via: "db" | "tx";
  op: "insert" | "delete";
  table: string;
  values?: unknown;
}
let writes: Write[] = [];
let resourceRows: unknown[] = [];
let pollRows: unknown[] = [];
let pollWrites: Record<string, unknown>[] = [];

function makeHandle(via: "db" | "tx") {
  return {
    insert: (table: { __t: string }) => {
      const self: Record<string, unknown> = {};
      self["values"] = (values: unknown) => {
        if (table.__t === "accountIdlePolls") pollWrites.push(values as Record<string, unknown>);
        else writes.push({ via, op: "insert", table: table.__t, values });
        return self;
      };
      self["onConflictDoUpdate"] = () => Promise.resolve(undefined);
      return self;
    },
    delete: (table: { __t: string }) => ({
      where: () => {
        writes.push({ via, op: "delete", table: table.__t });
        return Promise.resolve(undefined);
      },
    }),
    select: () => ({
      from: (table: { __t: string }) => ({
        where: () => {
          const rows = table.__t === "resources" ? resourceRows : pollRows;
          return {
            limit: () => Promise.resolve(rows),
            then: (resolve: (v: unknown) => unknown) => resolve(rows),
          };
        },
      }),
    }),
  };
}

vi.mock("../db/client", () => {
  const dbHandle = makeHandle("db") as Record<string, unknown>;
  dbHandle["transaction"] = async (fn: (tx: unknown) => Promise<unknown>) => fn(makeHandle("tx"));
  return { db: dbHandle };
});

let orgSettings = { enabled: true, lookbackDays: 21, rules: {} as Record<string, unknown> };
vi.mock("../idle/settings", async (orig) => {
  const actual = await orig<typeof import("../idle/settings")>();
  return { ...actual, getOrgIdleSettings: async () => orgSettings };
});

const fetchIdleFindings = vi.fn();
vi.mock("../sync-resources", () => ({
  loadAccountClient: async () => ({
    account: { pluginId: "aws" },
    plugin: {
      manifest: {
        idleFindings: {
          rules: [
            {
              id: "nat-gateway",
              label: "Idle NAT gateway",
              description: "x",
              resourceTypeIds: ["nat-gateway"],
              action: "remove",
              thresholds: [
                { key: "maxBytesOut", label: "B", unit: "bytes", default: 1000, min: 0, max: 1e9 },
              ],
            },
            {
              id: "load-balancer",
              label: "Idle load balancer",
              description: "x",
              resourceTypeIds: ["alb"],
              action: "remove",
              thresholds: [],
            },
          ],
        },
      },
    },
    client: { fetchIdleFindings },
  }),
}));

const { collectAccountIdleFindings, markIdlePollFailure } = await import("../idle/collect");

beforeEach(() => {
  writes = [];
  pollWrites = [];
  pollRows = [];
  orgSettings = { enabled: true, lookbackDays: 21, rules: {} };
  resourceRows = [
    {
      id: "res-1",
      resourceTypeId: "nat-gateway",
      externalId: "nat-1",
      displayName: "nat-1",
      fieldsJson: { region: "us-east-1", nested: { a: 1 } },
      outputsJson: { arn: "arn:aws:ec2:nat-1", count: 3 },
    },
  ];
  fetchIdleFindings.mockReset();
});

describe("collectAccountIdleFindings", () => {
  it("asks the plugin with resolved thresholds and the stored rows, then stores in one transaction", async () => {
    fetchIdleFindings.mockResolvedValue([
      {
        ruleId: "nat-gateway",
        subjectKey: "nat-1",
        resourceId: "res-1",
        resourceTypeId: "nat-gateway",
        displayName: "nat-1",
        reason: "No traffic",
        evidence: [],
        estimate: null,
      },
      // Dropped: not a resource the host handed over.
      {
        ruleId: "nat-gateway",
        subjectKey: "nat-2",
        resourceId: "res-404",
        resourceTypeId: "nat-gateway",
        displayName: "nat-2",
        reason: "No traffic",
        evidence: [],
        estimate: null,
      },
    ]);
    const now = new Date("2026-10-16T00:00:00Z");
    const result = await collectAccountIdleFindings("acc-1", "org-1", now);

    expect(result).toEqual({ findingCount: 1, droppedCount: 1, ran: true });
    const [, request] = fetchIdleFindings.mock.calls[0]!;
    expect(request.lookbackDays).toBe(21);
    expect(request.windowEnd).toBe(now.toISOString());
    expect(request.rules).toEqual({
      "nat-gateway": { thresholds: { maxBytesOut: 1000 } },
      "load-balancer": { thresholds: {} },
    });
    expect(request.resources[0]).toMatchObject({
      id: "res-1",
      fields: { region: "us-east-1" },
      resolvedOutputs: { arn: "arn:aws:ec2:nat-1" },
    });
    expect(writes.filter((w) => w.via === "db")).toEqual([]);
    expect(writes.map((w) => w.op)).toEqual(["insert", "delete"]);
    expect(writes[0]!.values).toMatchObject({
      firstDetectedAt: now,
      evaluatedAt: now,
      lookbackDays: 21,
    });
  });

  it("does not call the plugin, and clears stored findings, when every rule is off", async () => {
    orgSettings = { enabled: false, lookbackDays: 14, rules: {} };
    const result = await collectAccountIdleFindings("acc-1", "org-1");
    expect(result.ran).toBe(false);
    expect(fetchIdleFindings).not.toHaveBeenCalled();
    expect(writes).toEqual([{ via: "db", op: "delete", table: "accountIdleFindings" }]);
  });

  it("propagates a plugin failure without touching stored findings", async () => {
    fetchIdleFindings.mockRejectedValue(new Error("throttled"));
    await expect(collectAccountIdleFindings("acc-1", "org-1")).rejects.toThrow("throttled");
    expect(writes).toEqual([]);
  });
});

describe("markIdlePollFailure", () => {
  it("keeps an https help link from an access error and drops anything else", async () => {
    const err = Object.assign(new Error("no cloudwatch:GetMetricData"), {
      name: "IdleFindingAccessError",
      helpLabel: "Add the permission",
      helpUrl: "https://docs.example.com/iam",
    });
    await markIdlePollFailure("acc-1", "org-1", err, new Date());
    expect(pollWrites[0]).toMatchObject({
      failureCount: 1,
      lastError: "no cloudwatch:GetMetricData",
      lastErrorHelpUrl: "https://docs.example.com/iam",
    });

    pollWrites = [];
    const bad = Object.assign(new Error("x"), {
      name: "IdleFindingAccessError",
      helpLabel: "Click",
      helpUrl: "javascript:alert(1)",
    });
    await markIdlePollFailure("acc-1", "org-1", bad, new Date());
    expect(pollWrites[0]).toMatchObject({ lastErrorHelpUrl: null, lastErrorHelpLabel: null });
  });
});
