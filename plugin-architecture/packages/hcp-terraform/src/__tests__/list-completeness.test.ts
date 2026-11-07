import type { UnreadListPart } from "@infrawrench/plugin-base";
import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tfList } from "../api.js";
import { HcpTerraformClient } from "../client.js";
import { fetchInvoiceCost } from "../cost.js";
import { runMetrics } from "../metrics.js";
import type { Call } from "./helpers.js";
import { makeHttp } from "./helpers.js";

const ACC = "acc";
const UNREAD_HOOK = Symbol.for("infrawrench.unreadListPart");
const TRUNCATED = "has more than Infrawrench reads";
const NOT_A_LIST = "is not a list";
const REFUSED = { status: 404, body: { errors: ["not found"] } };
const BROKEN = { status: 500, body: { errors: ["boom"] } };

let unread: UnreadListPart[];

beforeEach(() => {
  unread = [];
  Reflect.set(globalThis, UNREAD_HOOK, (part: UnreadListPart) => void unread.push(part));
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, UNREAD_HOOK);
  vi.useRealTimers();
});

function client(route: (call: Call) => unknown) {
  const { http, calls } = makeHttp(route);
  const c = hostClient(new HcpTerraformClient({ apiToken: "tok", organization: "acme" }, { http }));
  c.setSleep(async () => {});
  return { c, calls };
}

function doc(id: string, type: string, attributes: Record<string, unknown> = {}) {
  return { id, type, attributes };
}

/** A workspace list of `count` rows, 100 to a page. */
function workspacePage(call: Call, count: number) {
  const page = Number(call.url.searchParams.get("page[number]") ?? 1);
  const rows = Array.from({ length: Math.min(100, count - (page - 1) * 100) }, (_, i) =>
    doc(`ws-${String((page - 1) * 100 + i).padStart(5, "0")}`, "workspaces", { name: `w${i}` }),
  );
  return {
    data: rows,
    meta: { pagination: { "next-page": page * 100 < count ? page + 1 : null } },
  };
}

function endless(call: Call) {
  const page = Number(call.url.searchParams.get("page[number]") ?? 1);
  return {
    data: [doc(`r${page}`, "things")],
    meta: { pagination: { "next-page": page + 1 } },
  };
}

const ctx = (http: ReturnType<typeof makeHttp>["http"]) => ({
  token: "t",
  hostname: "app.terraform.io",
  http,
});

describe("tfList", () => {
  it("throws at its cap with more to read, after exactly that many requests", async () => {
    const { http, calls } = makeHttp(endless);
    await expect(tfList(ctx(http), "/organizations/acme/workspaces")).rejects.toThrow(TRUNCATED);
    expect(calls).toHaveLength(1000);
  });

  it("reads a list past the old 2,000 rows", async () => {
    const { http } = makeHttp((call) => workspacePage(call, 2500));
    const res = await tfList(ctx(http), "/organizations/acme/workspaces");
    expect(res.data).toHaveLength(2500);
  });

  it("stops quietly at the cap of a partial read", async () => {
    const { http, calls } = makeHttp(endless);
    const res = await tfList(
      ctx(http),
      "/workspaces/ws-1/runs",
      {},
      {
        maxPages: 1,
        partial: true,
      },
    );
    expect(res.data).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it("refuses a page whose list is not a list, on the first page and on a later one", async () => {
    const first = makeHttp(() => ({ items: [] }));
    await expect(tfList(ctx(first.http), "/x")).rejects.toThrow(NOT_A_LIST);
    const later = makeHttp((call) =>
      call.url.searchParams.get("page[number]") === "2"
        ? { items: [] }
        : { data: [doc("a", "things")], meta: { pagination: { "next-page": 2 } } },
    );
    await expect(tfList(ctx(later.http), "/x")).rejects.toThrow(NOT_A_LIST);
  });
});

describe("listResources", () => {
  it("reads every workspace past the old cap", async () => {
    const { c } = client((call) =>
      call.url.pathname.endsWith("/explorer") ? { data: [] } : workspacePage(call, 2500),
    );
    expect(await c.listResources("workspace", ACC)).toHaveLength(2500);
  });

  it("reads explorer health past the old ten pages", async () => {
    const { c } = client((call) => {
      if (!call.url.pathname.endsWith("/explorer")) return workspacePage(call, 1);
      const page = Number(call.url.searchParams.get("page[number]"));
      return {
        data:
          page === 12
            ? [doc("x", "visibility-workspace", { "external-id": "ws-00000", drifted: true })]
            : [],
        meta: { pagination: { "next-page": page < 12 ? page + 1 : null } },
      };
    });
    const [w] = await c.listResources("workspace", ACC);
    expect(w!.fields["drifted"]).toBe(true);
  });

  it("does not read an explorer list past its cap as no health", async () => {
    const { c } = client((call) =>
      call.url.pathname.endsWith("/explorer") ? endless(call) : workspacePage(call, 1),
    );
    await expect(c.listResources("workspace", ACC)).rejects.toThrow(TRUNCATED);
  });

  it("does not read a workspace list past its cap as no workspace count", async () => {
    const { c } = client((call) =>
      call.url.pathname.endsWith("/projects")
        ? { data: [doc("prj-1", "projects", { name: "p" })] }
        : endless(call),
    );
    await expect(c.listResources("project", ACC)).rejects.toThrow(TRUNCATED);
  });

  it("does not read a bad workspace page as no organization counts", async () => {
    const { c } = client((call) => {
      if (call.url.pathname.endsWith("/workspaces")) return { items: [] };
      if (call.url.pathname.endsWith("/organizations/acme")) return { data: doc("acme", "orgs") };
      return { data: [] };
    });
    await expect(c.listResources("organization", ACC)).rejects.toThrow(NOT_A_LIST);
  });

  for (const [typeId, parentPath, childPath, parentType] of [
    ["variable", "/organizations/acme/workspaces", "/vars", "workspace"],
    [
      "state-output",
      "/organizations/acme/workspaces",
      "/current-state-version-outputs",
      "workspace",
    ],
    ["varset-variable", "/organizations/acme/varsets", "/relationships/vars", "variable-set"],
    ["agent", "/organizations/acme/agent-pools", "/agents", "agent-pool"],
    ["agent-token", "/organizations/acme/agent-pools", "/authentication-tokens", "agent-pool"],
  ] as const) {
    const parents = { data: [doc("p-1", "parents"), doc("p-2", "parents")] };

    it(`${typeId}: a parent that refuses keeps its stored rows and the rest are read`, async () => {
      const { c } = client((call) => {
        if (call.url.pathname.endsWith(parentPath)) return parents;
        if (call.url.pathname.includes("/p-1")) return REFUSED;
        return { data: [doc("child", "children", { key: "k", name: "n" })] };
      });
      const rows = await c.listResources(typeId, ACC);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.parentResourceId).toBe(`${ACC}:${parentType}:p-2`);
      expect(unread).toEqual([{ parentResourceIds: [`${ACC}:${parentType}:p-1`] }]);
    });

    it(`${typeId}: a parent that refuses fails the type where the host keeps no track`, async () => {
      Reflect.deleteProperty(globalThis, UNREAD_HOOK);
      const { c } = client((call) => {
        if (call.url.pathname.endsWith(parentPath)) return parents;
        if (call.url.pathname.includes("/p-1")) return REFUSED;
        return { data: [doc("child", "children", { key: "k", name: "n" })] };
      });
      await expect(c.listResources(typeId, ACC)).rejects.toThrow("404");
    });

    it(`${typeId}: any other failure fails the type`, async () => {
      const { c } = client((call) => {
        if (call.url.pathname.endsWith(parentPath)) return parents;
        return call.url.pathname.endsWith(childPath) ? BROKEN : { data: [] };
      });
      await expect(c.listResources(typeId, ACC)).rejects.toThrow("500");
    });

    it(`${typeId}: a child list past its cap fails the type`, async () => {
      const { c } = client((call) =>
        call.url.pathname.endsWith(parentPath) ? parents : endless(call),
      );
      await expect(c.listResources(typeId, ACC)).rejects.toThrow(TRUNCATED);
    });
  }

  it("keeps a workspace's outputs while its new state is being processed", async () => {
    const { c } = client((call) => {
      if (call.url.pathname.endsWith("/organizations/acme/workspaces"))
        return workspacePage(call, 1);
      return { status: 503, body: { errors: ["processing"] } };
    });
    expect(await c.listResources("state-output", ACC)).toEqual([]);
    expect(unread).toEqual([{ parentResourceIds: [`${ACC}:workspace:ws-00000`] }]);
  });

  it("reads 1,000 workspaces' children and names the rest, moving on each hour", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
    const read = (calls: Call[]) =>
      calls.filter((call) => call.url.pathname.endsWith("/vars")).map((call) => call.url.pathname);
    const route = (call: Call) =>
      call.url.pathname.endsWith("/organizations/acme/workspaces")
        ? workspacePage(call, 1200)
        : { data: [doc(`v-${call.url.pathname}`, "vars", { key: "k" })] };

    const first = client(route);
    expect(await first.c.listResources("variable", ACC)).toHaveLength(1000);
    expect(read(first.calls)).toHaveLength(1000);
    expect(read(first.calls)[0]).toBe("/api/v2/workspaces/ws-00000/vars");
    expect(unread).toHaveLength(1);
    expect(unread[0]!.parentResourceIds).toHaveLength(200);
    expect(unread[0]!.parentResourceIds![0]).toBe(`${ACC}:workspace:ws-01000`);

    vi.setSystemTime(60 * 60 * 1000);
    unread = [];
    const next = client(route);
    expect(await next.c.listResources("variable", ACC)).toHaveLength(1000);
    expect(read(next.calls)[0]).toBe("/api/v2/workspaces/ws-01000/vars");
    expect(read(next.calls)).toContain("/api/v2/workspaces/ws-00799/vars");
    expect(read(next.calls)).not.toContain("/api/v2/workspaces/ws-00800/vars");
    expect(unread[0]!.parentResourceIds![0]).toBe(`${ACC}:workspace:ws-00800`);
  });

  it("reads every workspace's children where the host keeps no track of the rest", async () => {
    Reflect.deleteProperty(globalThis, UNREAD_HOOK);
    const { c, calls } = client((call) =>
      call.url.pathname.endsWith("/organizations/acme/workspaces")
        ? workspacePage(call, 1200)
        : { data: [doc(`v-${call.url.pathname}`, "vars", { key: "k" })] },
    );
    expect(await c.listResources("variable", ACC)).toHaveLength(1200);
    expect(calls.filter((call) => call.url.pathname.endsWith("/vars"))).toHaveLength(1200);
  });

  it("names nobody when every parent fits", async () => {
    const { c } = client((call) =>
      call.url.pathname.endsWith("/organizations/acme/workspaces")
        ? workspacePage(call, 1000)
        : { data: [] },
    );
    await c.listResources("variable", ACC);
    expect(unread).toEqual([]);
  });

  for (const typeId of ["policy-set", "team", "run-task", "registry-module", "registry-provider"]) {
    it(`${typeId}: a refused list keeps the stored rows quietly`, async () => {
      const { c } = client(() => REFUSED);
      expect(await c.listResources(typeId, ACC)).toEqual([]);
      expect(unread).toEqual([{ idPrefixes: [""] }]);
    });
  }

  for (const typeId of ["agent-pool", "agent", "agent-token", "variable-set", "varset-variable"]) {
    it(`${typeId}: refused parents keep the stored rows quietly`, async () => {
      const { c } = client(() => REFUSED);
      expect(await c.listResources(typeId, ACC)).toEqual([]);
      expect(unread).toEqual([{ idPrefixes: [""] }]);
    });
  }

  it("shows a 403 where the host keeps no track, but not a 404 a plan can answer", async () => {
    Reflect.deleteProperty(globalThis, UNREAD_HOOK);
    const forbidden = client(() => ({ status: 403, body: { errors: ["forbidden"] } }));
    await expect(forbidden.c.listResources("team", ACC)).rejects.toThrow("403");
    const absent = client(() => REFUSED);
    expect(await absent.c.listResources("team", ACC)).toEqual([]);
  });

  it("fails a type on a failure that is not a refusal", async () => {
    const { c } = client(() => BROKEN);
    await expect(c.listResources("team", ACC)).rejects.toThrow("500");
    await expect(c.listResources("agent-pool", ACC)).rejects.toThrow("500");
  });
});

describe("the run window", () => {
  const run = (id: string) =>
    doc(id, "runs", { status: "applied", "created-at": "2026-10-01T00:00:00Z" });

  it("reads one page of the organization's runs and does not call more a failure", async () => {
    const { c, calls } = client((call) => {
      if (call.url.pathname.endsWith("/workspaces")) return workspacePage(call, 1);
      return { data: [run("run-1")], meta: { pagination: { "next-page": 2 } } };
    });
    expect(await c.listResources("run", ACC)).toHaveLength(1);
    const reads = calls.filter((call) => call.url.pathname.endsWith("/acme/runs"));
    expect(reads).toHaveLength(1);
    expect(reads[0]!.url.searchParams.get("page[size]")).toBe("50");
  });

  it("refuses an organization run page that is not a list", async () => {
    const { c } = client((call) =>
      call.url.pathname.endsWith("/workspaces") ? workspacePage(call, 1) : { items: [] },
    );
    await expect(c.listResources("run", ACC)).rejects.toThrow(NOT_A_LIST);
  });

  it("falls back to a window of the 20 latest workspaces with no organization run list", async () => {
    const { c, calls } = client((call) => {
      if (call.url.pathname.endsWith("/acme/runs")) return REFUSED;
      if (call.url.pathname.endsWith("/workspaces")) return workspacePage(call, 30);
      return { data: [run("r")], meta: { pagination: { "next-page": 2 } } };
    });
    expect(await c.listResources("run", ACC)).toHaveLength(20);
    expect(
      calls.filter((call) => /\/workspaces\/ws-[^/]+\/runs$/.test(call.url.pathname)),
    ).toHaveLength(20);
  });

  it("skips a workspace that refuses in the fallback, and fails on anything else", async () => {
    const refusing = client((call) => {
      if (call.url.pathname.endsWith("/acme/runs")) return REFUSED;
      if (call.url.pathname.endsWith("/workspaces")) return workspacePage(call, 2);
      return call.url.pathname.includes("ws-00000") ? REFUSED : { data: [run("r")] };
    });
    expect(await refusing.c.listResources("run", ACC)).toHaveLength(1);

    const broken = client((call) => {
      if (call.url.pathname.endsWith("/acme/runs")) return REFUSED;
      if (call.url.pathname.endsWith("/workspaces")) return workspacePage(call, 2);
      return call.url.pathname.includes("ws-00000") ? BROKEN : { data: [run("r")] };
    });
    await expect(broken.c.listResources("run", ACC)).rejects.toThrow("500");
  });
});

describe("invoices", () => {
  const range = { fromDate: "2020-01-01", toDate: "2026-12-31" };
  const invoice = (id: string) =>
    doc(id, "billing-invoices", {
      "created-at": "2026-09-01T00:00:00Z",
      total: 100,
      status: "paid",
    });

  it("reads past the old twelve pages", async () => {
    let n = 0;
    const { http } = makeHttp(() => {
      n++;
      return { data: [invoice(`in_${n}`)], meta: { continuation: n < 20 ? `in_${n}` : null } };
    });
    expect(await fetchInvoiceCost(ctx(http), "acme", range)).toHaveLength(20);
  });

  it("throws at the cap with more to read", async () => {
    let n = 0;
    const { http, calls } = makeHttp(() => {
      n++;
      return { data: [invoice(`in_${n}`)], meta: { continuation: `in_${n}` } };
    });
    await expect(fetchInvoiceCost(ctx(http), "acme", range)).rejects.toThrow(TRUNCATED);
    expect(calls).toHaveLength(1000);
  });

  it("refuses a page that is not a list", async () => {
    const { http } = makeHttp(() => ({ invoices: [] }));
    await expect(fetchInvoiceCost(ctx(http), "acme", range)).rejects.toThrow(NOT_A_LIST);
  });

  it("does not read a 404 on a later page as no invoices", async () => {
    let n = 0;
    const { http } = makeHttp(() =>
      n++ === 0 ? { data: [invoice("in_1")], meta: { continuation: "in_1" } } : REFUSED,
    );
    await expect(fetchInvoiceCost(ctx(http), "acme", range)).rejects.toThrow("404");
  });
});

describe("run metrics", () => {
  it("refuses a page that is not a list", async () => {
    const { http } = makeHttp(() => ({ items: [] }));
    await expect(
      runMetrics(ctx(http), "/organizations/acme/runs", { startMs: 0, endMs: 1 }),
    ).rejects.toThrow(NOT_A_LIST);
  });
});
