import { hostClient } from "@infrawrench/plugin-base/effect";
import { describe, expect, it } from "vitest";
import type { HostServices } from "@infrawrench/plugin-base";
import { SupabaseClient } from "../client.js";

const REF = "abcdefghijklmnopqrst";
const BRANCH = "6f0c1d2e-3a4b-4c5d-8e9f-001122334455";

interface Call {
  method: string;
  url: string;
  body?: string | Uint8Array;
}
type Route = (call: Call) => { status: number; body: unknown } | undefined;

/** Every request goes through the host transport here; nothing reaches Supabase. */
function client(routes: Route[]) {
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
        for (const route of routes) {
          const res = route(call);
          if (res) return { status: res.status, headers: {}, body: JSON.stringify(res.body) };
        }
        return { status: 404, headers: {}, body: JSON.stringify({ message: "not found" }) };
      },
    },
  };
  return { c: hostClient(new SupabaseClient({ accessToken: "test-token" }, services)), calls };
}

const on =
  (method: string, path: string, body: unknown, status = 200): Route =>
  (call) =>
    call.method === method && new URL(call.url).pathname === path ? { status, body } : undefined;

describe("Supabase restore drills", () => {
  it("branches the project with its data", async () => {
    const { c, calls } = client([
      on("POST", `/v1/projects/${REF}/branches`, { id: BRANCH, name: "iw-drill-abc" }, 201),
    ]);
    const handle = await c.startRestoreDrill!({
      resourceTypeId: "supabase-project",
      resourceId: `acct:supabase-project:${REF}`,
      accountId: "acct",
      restorePoint: { kind: "latest-backup" },
      copyName: "iw-drill-abc",
    });
    expect(handle).toEqual({ ref: `${REF}/${BRANCH}`, restoredFrom: `${REF}, latest data` });
    expect(JSON.parse(String(calls[0]!.body))).toEqual({
      branch_name: "iw-drill-abc",
      with_data: true,
      persistent: false,
    });
  });

  it("is pending until the branch is healthy, then connects to its database", async () => {
    const coming = client([
      on("GET", `/v1/branches/${BRANCH}`, { status: "COMING_UP", db_host: "", db_port: 5432 }),
    ]);
    expect(await coming.c.checkRestoreDrill!(`${REF}/${BRANCH}`, "acct")).toEqual({
      state: "pending",
      detail: "The branch is coming_up.",
    });

    const ready = client([
      on("GET", `/v1/branches/${BRANCH}`, {
        status: "ACTIVE_HEALTHY",
        db_host: "db.branch.example.test",
        db_port: 5432,
        db_user: "postgres",
        db_pass: "p@ss",
      }),
    ]);
    expect(await ready.c.checkRestoreDrill!(`${REF}/${BRANCH}`, "acct")).toEqual({
      state: "ready",
      connection: {
        driver: "postgres",
        connectionString:
          "postgresql://postgres:p%40ss@db.branch.example.test:5432/postgres?sslmode=require",
      },
    });
  });

  it("deletes only drill branches, and treats a missing one as deleted", async () => {
    const drill = client([
      on("GET", `/v1/projects/${REF}/branches`, [{ id: BRANCH, name: "iw-drill-abc" }]),
      on("DELETE", `/v1/branches/${BRANCH}`, {}),
    ]);
    await drill.c.endRestoreDrill!(`${REF}/${BRANCH}`, "acct");
    expect(drill.calls.map((call) => call.method)).toEqual(["GET", "DELETE"]);

    const gone = client([on("GET", `/v1/projects/${REF}/branches`, [])]);
    await expect(gone.c.endRestoreDrill!(`${REF}/${BRANCH}`, "acct")).resolves.toBeUndefined();

    const foreign = client([
      on("GET", `/v1/projects/${REF}/branches`, [{ id: BRANCH, name: "staging" }]),
    ]);
    await expect(foreign.c.endRestoreDrill!(`${REF}/${BRANCH}`, "acct")).rejects.toThrow(
      "refusing",
    );
    expect(foreign.calls.some((call) => call.method === "DELETE")).toBe(false);
  });
});
