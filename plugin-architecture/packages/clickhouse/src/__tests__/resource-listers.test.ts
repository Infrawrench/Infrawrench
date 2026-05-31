import { describe, expect, it, vi } from "vitest";
import { listServices, listDatabases, type ListerContext } from "../resource-listers.js";

const ACCOUNT = "acct-1";

function makeCtx(over: Partial<ListerContext> = {}): ListerContext {
  return {
    cloudApi: vi.fn(),
    chQuery: vi.fn(),
    id: (a, t, e) => `${a}:${t}:${e}`,
    now: () => "NOW",
    organizationId: "org-1",
    ...over,
  } as ListerContext;
}

describe("listServices", () => {
  it("maps services with https + native endpoints", async () => {
    const cloudApi = vi.fn(async () => ({
      result: [
        {
          id: "svc1",
          name: "prod",
          state: "running",
          provider: "aws",
          region: "us-east-1",
          clickhouseVersion: "24.1",
          tier: "production",
          minReplicaMemoryGb: 8,
          maxReplicaMemoryGb: 16,
          numReplicas: 3,
          idleScaling: true,
          idleTimeoutMinutes: 5,
          isPrimary: true,
          isReadonly: false,
          endpoints: [
            { protocol: "https", host: "h.clickhouse.cloud", port: 8443 },
            { protocol: "nativesecure", host: "h.clickhouse.cloud", port: 9440 },
          ],
          createdAt: "2024-01-01",
        },
      ],
    }));
    const ctx = makeCtx({ cloudApi: cloudApi as never });
    const res = await listServices(ctx, ACCOUNT);
    expect(cloudApi).toHaveBeenCalledWith("GET", "/v1/organizations/org-1/services");
    expect(res).toHaveLength(1);
    const s = res[0];
    expect(s.id).toBe("acct-1:ch-service:svc1");
    expect(s.fields["clickhouseVersion"]).toBe("24.1");
    expect(s.resolvedOutputs["host"]).toBe("h.clickhouse.cloud");
    expect(s.resolvedOutputs["port"]).toBe("8443");
    expect(s.resolvedOutputs["nativePort"]).toBe("9440");
    expect(s.resolvedOutputs["httpUrl"]).toBe("https://h.clickhouse.cloud:8443");
    expect(s.resolvedOutputs["connectionString"]).toBe("clickhouse://h.clickhouse.cloud:9440");
    expect(s.createdAt).toBe("2024-01-01");
  });

  it("uses defaults when endpoints + optional fields missing", async () => {
    const ctx = makeCtx({
      cloudApi: vi.fn(async () => ({
        result: [
          { id: "svc2", name: "", state: "stopped", provider: "gcp", region: "us-central1" },
        ],
      })) as never,
    });
    const res = await listServices(ctx, ACCOUNT);
    const s = res[0];
    expect(s.displayName).toBe("svc2");
    expect(s.resolvedOutputs["host"]).toBe("");
    expect(s.resolvedOutputs["port"]).toBe("8443");
    expect(s.resolvedOutputs["nativePort"]).toBe("9440");
    expect(s.resolvedOutputs["httpUrl"]).toBe("");
    expect(s.resolvedOutputs["connectionString"]).toBe("");
    expect(s.fields["clickhouseVersion"]).toBe("");
    expect(s.createdAt).toBe("NOW");
  });

  it("handles native (non-secure) endpoint protocol", async () => {
    const ctx = makeCtx({
      cloudApi: vi.fn(async () => ({
        result: [
          {
            id: "s",
            name: "n",
            state: "running",
            provider: "aws",
            region: "r",
            endpoints: [{ protocol: "native", host: "h", port: 9000 }],
          },
        ],
      })) as never,
    });
    const res = await listServices(ctx, ACCOUNT);
    expect(res[0].resolvedOutputs["nativePort"]).toBe("9000");
  });

  it("returns empty when result missing", async () => {
    const ctx = makeCtx({ cloudApi: vi.fn(async () => ({})) as never });
    expect(await listServices(ctx, ACCOUNT)).toEqual([]);
  });
});

describe("listDatabases", () => {
  it("maps rows from chQuery", async () => {
    const chQuery = vi.fn(async () => [
      { name: "default", engine: "Atomic", comment: "" },
      { name: "analytics", engine: "Atomic", comment: "metrics" },
    ]);
    const ctx = makeCtx({ chQuery: chQuery as never });
    const res = await listDatabases(ctx, ACCOUNT, "svc1");
    expect(chQuery).toHaveBeenCalledWith(expect.stringContaining("system.databases"));
    expect(res).toHaveLength(2);
    expect(res[0].id).toBe("acct-1:ch-database:svc1/default");
    expect(res[0].parentResourceId).toBe("acct-1:ch-service:svc1");
    expect(res[1].fields["comment"]).toBe("metrics");
  });

  it("handles missing row fields", async () => {
    const ctx = makeCtx({ chQuery: vi.fn(async () => [{}]) as never });
    const res = await listDatabases(ctx, ACCOUNT, "svc1");
    expect(res[0].fields["name"]).toBe("");
    expect(res[0].fields["engine"]).toBe("");
  });

  it("returns empty when chQuery throws", async () => {
    const ctx = makeCtx({
      chQuery: vi.fn(async () => {
        throw new Error("connection refused");
      }) as never,
    });
    expect(await listDatabases(ctx, ACCOUNT, "svc1")).toEqual([]);
  });
});
