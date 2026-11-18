import { hostClient } from "@infrawrench/plugin-base/effect";
import { describe, expect, it } from "vitest";
import type { HostServices } from "@infrawrench/plugin-base";
import { XataClient } from "../client.js";

const API = "https://api.xata.tech";
const BRANCHES = `${API}/organizations/org1/projects/p1/branches`;

interface Call {
  method: string;
  url: string;
  body?: string | Uint8Array;
}
type Route = (call: Call) => { status: number; body: unknown } | undefined;

/** Every request goes through the host transport here; nothing reaches Xata. */
function fake(routes: Route[]) {
  const calls: Call[] = [];
  const services: HostServices = {
    http: {
      async request(req) {
        const call: Call = {
          method: req.method,
          url: req.url,
          ...(req.body !== undefined ? { body: req.body } : {}),
        };
        calls.push(call);
        for (const r of routes) {
          const res = r(call);
          if (res) return { status: res.status, headers: {}, body: JSON.stringify(res.body) };
        }
        return { status: 404, headers: {}, body: JSON.stringify({ message: "not found" }) };
      },
    },
  };
  return { client: hostClient(new XataClient({ apiKey: "xau_k" }, services)), calls };
}

const on =
  (method: string, url: string, body: unknown, status = 200): Route =>
  (call) => {
    const u = new URL(call.url);
    return call.method === method && `${u.origin}${u.pathname}` === url
      ? { status, body }
      : undefined;
  };

const source = {
  id: "br-main",
  name: "main",
  configuration: { region: "eu", instanceType: "small", image: "pg17", replicas: 2 },
  status: { status: "healthy", statusType: "STATUS_TYPE_HEALTHY" },
};

const request = {
  resourceTypeId: "xata-branch",
  resourceId: "acct:xata-branch:org1/p1/br-main",
  accountId: "acct",
  copyName: "iw-drill-abc",
} as const;

describe("Xata restore drills", () => {
  it("restores the latest backup into a branch without replicas", async () => {
    const { client, calls } = fake([
      on("GET", `${BRANCHES}/br-main`, source),
      on("GET", `${API}/organizations/org1/projects/p1/backups`, {
        backups: [
          { branchID: "br-main", id: "bk", description: "", latestRestore: "2026-11-17T08:00:00Z" },
        ],
      }),
      on("POST", `${BRANCHES}/br-main/restore`, { id: "br-drill", name: "iw-drill-abc" }, 201),
    ]);
    const handle = await client.startRestoreDrill!({
      ...request,
      restorePoint: { kind: "latest-backup" },
    });
    expect(handle).toEqual({
      ref: "org1/p1/br-drill",
      restoredFrom: "main, latest backup",
      restorePointAt: "2026-11-17T08:00:00Z",
    });
    const post = calls.find((c) => c.method === "POST");
    expect(JSON.parse(String(post!.body))).toEqual({
      name: "iw-drill-abc",
      configuration: { ...source.configuration, replicas: 0 },
    });
  });

  it("passes the target time for a point-in-time drill", async () => {
    const { client, calls } = fake([
      on("GET", `${BRANCHES}/br-main`, source),
      on("POST", `${BRANCHES}/br-main/restore`, { id: "br-drill", name: "iw-drill-abc" }, 201),
    ]);
    await client.startRestoreDrill!({
      ...request,
      restorePoint: { kind: "point-in-time", at: "2026-11-17T06:00:00.000Z" },
    });
    const post = calls.find((c) => c.method === "POST");
    expect(JSON.parse(String(post!.body))).toMatchObject({
      targetTime: "2026-11-17T06:00:00.000Z",
    });
  });

  it("is pending until healthy, then connects with TLS", async () => {
    const coming = fake([
      on("GET", `${BRANCHES}/br-drill`, {
        ...source,
        status: { status: "creating", statusType: "STATUS_TYPE_TRANSIENT" },
      }),
    ]);
    expect(await coming.client.checkRestoreDrill!("org1/p1/br-drill", "acct")).toEqual({
      state: "pending",
      detail: "creating",
    });

    const ready = fake([
      on("GET", `${BRANCHES}/br-drill`, source),
      on("GET", `${BRANCHES}/br-drill/credentials`, {
        connectionString: "postgresql://u:p@h.example.test/db",
      }),
    ]);
    expect(await ready.client.checkRestoreDrill!("org1/p1/br-drill", "acct")).toEqual({
      state: "ready",
      connection: {
        driver: "postgres",
        connectionString: "postgresql://u:p@h.example.test/db?sslmode=require",
      },
    });
  });

  it("deletes only drill branches, and treats a missing one as deleted", async () => {
    const drill = fake([
      on("GET", `${BRANCHES}/br-drill`, { ...source, id: "br-drill", name: "iw-drill-abc" }),
      on("DELETE", `${BRANCHES}/br-drill`, {}),
    ]);
    await drill.client.endRestoreDrill!("org1/p1/br-drill", "acct");
    expect(drill.calls.map((c) => c.method)).toEqual(["GET", "DELETE"]);

    const gone = fake([]);
    await expect(gone.client.endRestoreDrill!("org1/p1/br-drill", "acct")).resolves.toBeUndefined();

    const foreign = fake([on("GET", `${BRANCHES}/br-main`, source)]);
    await expect(foreign.client.endRestoreDrill!("org1/p1/br-main", "acct")).rejects.toThrow(
      "refusing",
    );
    expect(foreign.calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});
