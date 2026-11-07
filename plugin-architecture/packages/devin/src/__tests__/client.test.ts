import { hostClient } from "@infrawrench/plugin-base/effect";
import { describe, expect, it, vi } from "vitest";
import { DevinClient } from "../client.js";
import { mapComponent } from "../status-feed.js";
import { day, makeHttp, page, reply } from "./helpers.js";

const SESSION = {
  session_id: "devin-abc",
  url: "https://app.devin.ai/sessions/abc",
  status: "running",
  status_detail: "working",
  title: "Fix flaky test",
  tags: ["ci"],
  playbook_id: "pb1",
  user_id: "u1",
  org_id: "org-1",
  created_at: day("2026-10-01"),
  updated_at: day("2026-10-01") + 60,
  is_archived: false,
  acus_consumed: 4,
  pull_requests: [
    { pr_url: "https://github.com/acme/app/pull/1", pr_state: "merged" },
    { pr_url: "https://github.com/acme/app/pull/2", pr_state: "open" },
  ],
};

function api(self: Record<string, unknown> = { principal_type: "service_user", org_id: "org-1" }) {
  return makeHttp((c) => {
    if (c.path === "/v3/self") return self;
    if (c.path === "/v3/enterprise/organizations") {
      return page([
        { org_id: "org-1", name: "Platform" },
        { org_id: "org-2", name: "Data" },
      ]);
    }
    if (c.path.endsWith("/members/users"))
      return page([{ user_id: "u1", name: "Ada", email: "a@x.io" }]);
    if (c.path.endsWith("/playbooks") && c.method === "GET") {
      return page([{ playbook_id: "pb1", title: "Triage", body: "…" }]);
    }
    if (c.path === "/v3/organizations/org-1/sessions") return page([SESSION]);
    if (c.path === "/v3/organizations/org-1/sessions/devin-abc") return SESSION;
    if (c.path === "/v3/organizations/org-1/knowledge/notes/n1") {
      return {
        note_id: "n1",
        name: "Billing",
        trigger: "billing work",
        body: "Use Stripe",
        is_enabled: true,
        folder_id: "f1",
      };
    }
    if (c.method !== "GET") return {};
    return reply(404, { detail: "nope" });
  });
}

const client = (http: unknown, creds: Record<string, string> = {}) =>
  hostClient(new DevinClient({ apiKey: "cog_test", ...creds }, { http } as never));

describe("organization resolution", () => {
  it("uses the org an org-scoped service user names", async () => {
    const { http, calls } = api();
    const orgs = await client(http).listResources("organization", "acct");
    expect(orgs.map((o) => o.externalId)).toEqual(["org-1"]);
    expect(calls.some((c) => c.path.startsWith("/v3/enterprise"))).toBe(false);
  });

  it("lists every org for an enterprise key", async () => {
    const { http } = api({ principal_type: "service_user", org_id: null });
    const orgs = await client(http).listResources("organization", "acct");
    expect(orgs.map((o) => o.displayName)).toEqual(["Platform", "Data"]);
  });

  it("falls back to a personal token's session org when it cannot list orgs", async () => {
    const { http } = makeHttp((c) =>
      c.path === "/v3/self"
        ? { principal_type: "pat_user", user_id: "u1", devin_sessions_org_id: "org-9" }
        : reply(403, { detail: "forbidden" }),
    );
    const orgs = await client(http).listResources("organization", "acct");
    expect(orgs.map((o) => o.externalId)).toEqual(["org-9"]);
  });
});

describe("sessions", () => {
  it("maps status, user, playbook, ACUs, cost and pull requests", async () => {
    const { http } = api();
    const [s] = await client(http, { acuPrice: "2.5" }).listResources("session", "acct");
    expect(s!.externalId).toBe("org-1/devin-abc");
    expect(s!.fields).toMatchObject({
      title: "Fix flaky test",
      user: "Ada",
      playbook: "Triage",
      acus: 4,
      estimatedCost: 10,
      pullRequests: 2,
      pullRequestsMerged: 1,
      tags: "ci",
    });
    const detail = client(http).renderDetail(s!);
    expect(detail.status?.label).toBe("Running");
    expect(detail.headerActions?.map((a) => a.label)).toEqual([
      "Open in Devin",
      "Terminate",
      "Archive",
    ]);
    const terminate = detail.headerActions!.find((a) => a.label === "Terminate")!.action;
    expect(terminate).toMatchObject({ type: "plugin-action", destructive: true });
    expect((terminate as { confirmMessage?: string }).confirmMessage).toBeTruthy();
    expect(detail.metricsCapability).toBeDefined();
  });

  it("terminates with DELETE and archives with POST", async () => {
    const { http, calls } = api();
    const c = client(http);
    await c.invokeAction("session", "acct:session:org-1/devin-abc", "terminate", "acct");
    await c.invokeAction("session", "acct:session:org-1/devin-abc", "archive", "acct");
    const writes = calls.filter((x) => x.method !== "GET").map((x) => `${x.method} ${x.path}`);
    expect(writes).toEqual([
      "DELETE /v3/organizations/org-1/sessions/devin-abc",
      "POST /v3/organizations/org-1/sessions/devin-abc/archive",
    ]);
  });

  it("replaces tags from the comma-separated field", async () => {
    const { http, calls } = api();
    await client(http).updateResource("session", "acct:session:org-1/devin-abc", "acct", {
      tags: "ci, nightly,ci",
    });
    const put = calls.find((x) => x.method === "PUT")!;
    expect(put.path).toBe("/v3/organizations/org-1/sessions/devin-abc/tags");
    expect(put.body).toEqual({ tags: ["ci", "nightly"] });
  });
});

describe("writes", () => {
  it("rejects a malformed playbook macro before calling Devin", async () => {
    const { http, calls } = api();
    await expect(
      client(http).createResource("playbook", "acct", { title: "T", body: "B", macro: "deploy" }),
    ).rejects.toThrow(/starts with !/);
    expect(calls.some((x) => x.method === "POST")).toBe(false);
  });

  it("creates a secret with its type and sensitivity", async () => {
    const { http, calls } = api();
    await client(http)
      .createResource("secret", "acct", {
        secretType: "key-value",
        key: "API_TOKEN",
        value: "s3cr3t",
        sensitive: "false",
      })
      .catch(() => undefined);
    expect(calls.find((x) => x.method === "POST")!.body).toEqual({
      type: "key-value",
      key: "API_TOKEN",
      value: "s3cr3t",
      is_sensitive: false,
      note: null,
    });
  });

  it("disables a note by writing the whole note back", async () => {
    const { http, calls } = api();
    await client(http).invokeAction(
      "knowledge-note",
      "acct:knowledge-note:org-1/n1",
      "disable",
      "acct",
    );
    expect(calls.find((x) => x.method === "PUT")!.body).toEqual({
      name: "Billing",
      trigger: "billing work",
      body: "Use Stripe",
      pinned_repo: null,
      folder_id: "f1",
      is_enabled: false,
    });
  });
});

describe("lists that cannot say they are complete", () => {
  const SELF = { principal_type: "service_user", org_id: "org-1" };
  const isList = (path: string, c: { path: string; method: string }) =>
    c.method === "GET" && c.path === `/v3/organizations/org-1${path}`;

  /** Full pages, numbered by cursor, for as long as `more` says. */
  const pages = (
    path: string,
    row: (n: number) => Record<string, unknown>,
    more: (page: number) => boolean,
  ) =>
    makeHttp((c) => {
      if (c.path === "/v3/self") return SELF;
      if (c.path.endsWith("/members/users") && !path.endsWith("/members/users")) return page([]);
      if (c.path.endsWith("/playbooks") && !path.endsWith("/playbooks")) return page([]);
      const n = Number(c.query.get("after") ?? 0);
      const first = Number(c.query.get("first"));
      return {
        items: Array.from({ length: first }, (_, i) => row(n * first + i)),
        has_next_page: more(n),
        end_cursor: more(n) ? String(n + 1) : null,
      };
    });

  const playbook = (n: number) => ({ playbook_id: `pb${n}`, title: `P${n}`, body: "b" });
  const session = (n: number) => ({ ...SESSION, session_id: `s${n}` });

  it("throws at 10,000 rows of a list with more to read, after exactly 50 requests", async () => {
    const { http, calls } = pages("/playbooks", playbook, () => true);
    await expect(client(http).listResources("playbook", "acct")).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(calls.filter((c) => isList("/playbooks", c))).toHaveLength(50);
  });

  it("throws at 50,000 sessions, after exactly 250 requests", async () => {
    const { http, calls } = pages("/sessions", session, () => true);
    await expect(client(http).listResources("session", "acct")).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(calls.filter((c) => isList("/sessions", c))).toHaveLength(250);
  });

  it("reads every row past the old caps of 5,000 and 1,000 sessions", async () => {
    const members = pages(
      "/members/users",
      (n) => ({ user_id: `u${n}`, name: `U${n}`, email: `${n}@x.io` }),
      (n) => n < 25,
    );
    expect(await client(members.http).listResources("member", "acct")).toHaveLength(5200);

    const sessions = pages("/sessions", session, (n) => n < 5);
    expect(await client(sessions.http).listResources("session", "acct")).toHaveLength(1200);
  });

  it("rejects a page with its key renamed, first or later, on every list", async () => {
    for (const [type, path] of [
      ["playbook", "/playbooks"],
      ["knowledge-note", "/knowledge/notes"],
      ["secret", "/secrets"],
      ["automation", "/automations"],
      ["session", "/sessions"],
    ]) {
      const first = makeHttp((c) => {
        if (c.path === "/v3/self") return SELF;
        if (isList(path!, c)) return { results: [], has_next_page: false };
        return page([]);
      });
      await expect(client(first.http).listResources(type!, "acct")).rejects.toThrow(
        "is not a list",
      );

      const later = makeHttp((c) => {
        if (c.path === "/v3/self") return SELF;
        if (!isList(path!, c)) return page([]);
        return c.query.get("after")
          ? { results: [] }
          : { items: [], has_next_page: true, end_cursor: "next" };
      });
      await expect(client(later.http).listResources(type!, "acct")).rejects.toThrow(
        "is not a list",
      );
    }
  });

  it("rejects an enterprise listing that is not a list instead of naming no orgs", async () => {
    const { http } = makeHttp((c) =>
      c.path === "/v3/self" ? { principal_type: "service_user", org_id: null } : { orgs: [] },
    );
    await expect(client(http).listResources("organization", "acct")).rejects.toThrow(
      "is not a list",
    );
  });

  it("rejects a page that says there is more and gives no cursor", async () => {
    const { http, calls } = makeHttp((c) => {
      if (c.path === "/v3/self") return SELF;
      return { items: [{ secret_id: "s1", key: "K" }], has_next_page: true, end_cursor: null };
    });
    await expect(client(http).listResources("secret", "acct")).rejects.toThrow("end_cursor");
    expect(calls.filter((c) => isList("/secrets", c))).toHaveLength(1);
  });

  it("keeps reading past an empty page that says there is more", async () => {
    const { http } = makeHttp((c) => {
      if (c.path === "/v3/self") return SELF;
      return c.query.get("after")
        ? page([{ secret_id: "s1", key: "K" }])
        : { items: [], has_next_page: true, end_cursor: "next" };
    });
    expect(await client(http).listResources("secret", "acct")).toHaveLength(1);
  });

  it("does not let the session labels' catch hide a list that is not one", async () => {
    for (const lookup of ["/members/users", "/playbooks"]) {
      const { http } = makeHttp((c) => {
        if (c.path === "/v3/self") return SELF;
        if (c.path.endsWith(lookup)) return { results: [] };
        return page([]);
      });
      await expect(client(http).listResources("session", "acct")).rejects.toThrow("is not a list");
    }
  });

  it("still lists sessions with no labels when a label read fails another way", async () => {
    const { http } = makeHttp((c) => {
      if (c.path === "/v3/self") return SELF;
      if (c.path.endsWith("/members/users")) return reply(500, { detail: "boom" });
      return c.path.endsWith("/sessions") ? page([SESSION]) : page([]);
    });
    expect(await client(http).listResources("session", "acct")).toHaveLength(1);
  });

  it("rejects a key Devin stops accepting, rather than reading every list as empty", async () => {
    let revoked = false;
    const { http } = makeHttp((c) => {
      if (c.path === "/v3/self") return SELF;
      return revoked ? reply(401, { detail: "invalid key" }) : page([]);
    });
    const c = client(http);
    await c.listResources("organization", "acct");
    revoked = true;
    await expect(c.listResources("secret", "acct")).rejects.toThrow("401");
  });

  it("lists nothing for an org whose role cannot read that list", async () => {
    const { http } = makeHttp((c) =>
      c.path === "/v3/self" ? SELF : reply(403, { detail: "forbidden" }),
    );
    expect(await client(http).listResources("secret", "acct")).toEqual([]);
  });

  it("goes through the host's transport, with no CA and no fetch", async () => {
    const fetchStub = vi.fn(() => {
      throw new Error("unexpected fetch");
    });
    vi.stubGlobal("fetch", fetchStub);
    try {
      const request = vi.fn(async (req: { url: string }) => ({
        status: 200,
        headers: {},
        body: JSON.stringify(req.url.endsWith("/v3/self") ? SELF : page([])),
      }));
      await client({ request }).listResources("secret", "acct");
      expect(request).toHaveBeenCalled();
      expect(request.mock.calls[0]![0]).not.toHaveProperty("caCert");
      expect(fetchStub).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("status feed", () => {
  it("folds Enterprise twins into one service and escalates the cloud agent", () => {
    expect(mapComponent("Cloud Web Client (Enterprise)")).toEqual({
      services: ["Cloud Web Client"],
    });
    expect(mapComponent("Cloud Agent")).toMatchObject({ providerWide: true });
    expect(mapComponent("Enterprise")).toBeNull();
  });
});
