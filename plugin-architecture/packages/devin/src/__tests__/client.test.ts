import { describe, expect, it } from "vitest";
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
  new DevinClient({ apiKey: "cog_test", ...creds }, { http } as never);

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

describe("status feed", () => {
  it("folds Enterprise twins into one service and escalates the cloud agent", () => {
    expect(mapComponent("Cloud Web Client (Enterprise)")).toEqual({
      services: ["Cloud Web Client"],
    });
    expect(mapComponent("Cloud Agent")).toMatchObject({ providerWide: true });
    expect(mapComponent("Enterprise")).toBeNull();
  });
});
