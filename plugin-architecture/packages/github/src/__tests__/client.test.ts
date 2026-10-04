import { evaluateOrphanRule } from "@infrawrench/plugin-base";
import { describe, expect, it } from "vitest";
import { buildBudgetBody, GitHubClient } from "../client.js";
import { parseCopilotReport, usageSeries } from "../metrics.js";
import { listOwnerOptions } from "../owners.js";
import { plugin } from "../plugin.js";
import { CodespaceResourceType, CopilotSeatResourceType } from "../resource-types.js";
import { credentials, makeHttp } from "./helpers.js";

const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

function client(route: Parameters<typeof makeHttp>[0], owner = "org:octo-org") {
  const { http, calls } = makeHttp(route);
  return { c: new GitHubClient(credentials(owner), { http }), calls };
}

describe("Copilot seats", () => {
  it("flags idle seats as orphans and prices them from the bill", async () => {
    const { c } = client((url) => {
      if (url.pathname.endsWith("/copilot/billing/seats")) {
        return {
          body: {
            total_seats: 3,
            seats: [
              {
                assignee: { login: "busy" },
                last_activity_at: ago(2),
                created_at: ago(200),
                plan_type: "business",
              },
              {
                assignee: { login: "idle" },
                last_activity_at: ago(45),
                created_at: ago(200),
                plan_type: "business",
              },
              {
                assignee: { login: "fresh" },
                last_activity_at: null,
                created_at: ago(3),
                plan_type: "business",
              },
            ],
          },
        };
      }
      if (url.pathname.endsWith("/usage/summary")) {
        return {
          body: {
            usageItems: [
              { product: "copilot", sku: "copilot_for_business", pricePerUnit: 19, netAmount: 57 },
            ],
          },
        };
      }
      return { status: 404, body: {} };
    });
    const seats = await c.listResources("copilot-seat", "acc");
    const byLogin = Object.fromEntries(seats.map((s) => [s.externalId, s]));
    expect(byLogin["idle"]!.fields["idle"]).toBe(true);
    expect(byLogin["busy"]!.fields["idle"]).toBe(false);
    expect(byLogin["fresh"]!.fields["idle"]).toBe(false);
    expect(byLogin["idle"]!.fields["monthlyPrice"]).toBe(19);
    expect(evaluateOrphanRule(CopilotSeatResourceType.orphanRule, byLogin["idle"]!.fields)).toMatch(
      /no activity/,
    );
    expect(
      evaluateOrphanRule(CopilotSeatResourceType.orphanRule, byLogin["busy"]!.fields),
    ).toBeNull();
  });

  it("removes a seat with the selected_users DELETE and explains a team seat", async () => {
    const { c, calls } = client(() => ({ body: { seats_cancelled: 1 } }));
    await c.invokeAction("copilot-seat", "acc:copilot-seat:idle", "remove-seat", "acc");
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url.pathname).toBe("/orgs/octo-org/copilot/billing/selected_users");
    expect(calls[0]!.body).toEqual({ selected_usernames: ["idle"] });

    const team = client(() => ({ body: { seats_cancelled: 0 } }));
    await expect(
      team.c.invokeAction("copilot-seat", "acc:copilot-seat:t", "remove-seat", "acc"),
    ).rejects.toThrow(/team/);
  });
});

describe("org-only and enterprise-only types", () => {
  it("lists nothing (and calls nothing) where the owner kind has no such thing", async () => {
    const ent = client(() => ({ body: {} }), "enterprise:big");
    expect(await ent.c.listResources("codespace", "acc")).toEqual([]);
    expect(await ent.c.listResources("actions-cache", "acc")).toEqual([]);
    expect(ent.calls).toHaveLength(0);
    const org = client(() => ({ body: {} }));
    expect(await org.c.listResources("cost-center", "acc")).toEqual([]);
    expect(org.calls).toHaveLength(0);
  });

  it("lists a type the token cannot read as empty", async () => {
    const { c } = client(() => ({ status: 403, body: { message: "nope" } }));
    expect(await c.listResources("codespace", "acc")).toEqual([]);
  });
});

describe("codespaces", () => {
  it("flags stale codespaces and stops one through the org admin route", async () => {
    const { c, calls } = client((url) =>
      url.pathname === "/orgs/octo-org/codespaces"
        ? {
            body: {
              total_count: 1,
              codespaces: [
                {
                  name: "fluffy-abc",
                  owner: { login: "mona" },
                  state: "Shutdown",
                  last_used_at: ago(20),
                  created_at: ago(40),
                },
              ],
            },
          }
        : { body: {} },
    );
    const [cs] = await c.listResources("codespace", "acc");
    expect(cs!.externalId).toBe("mona/fluffy-abc");
    expect(evaluateOrphanRule(CodespaceResourceType.orphanRule, cs!.fields)).toMatch(/14 days/);
    await c.invokeAction("codespace", cs!.id, "stop", "acc");
    expect(calls.at(-1)!.url.pathname).toBe(
      "/orgs/octo-org/members/mona/codespaces/fluffy-abc/stop",
    );
    await c.deleteResource("codespace", cs!.id, "acc");
    expect(calls.at(-1)!.method).toBe("DELETE");
    expect(calls.at(-1)!.url.pathname).toBe("/orgs/octo-org/members/mona/codespaces/fluffy-abc");
  });
});

describe("Actions caches", () => {
  it("deletes one cache by id and clears all by paging", async () => {
    let remaining = [{ id: 1 }, { id: 2 }];
    const { c, calls } = client((url, method) => {
      if (method === "DELETE") {
        const id = Number(url.pathname.split("/").pop());
        remaining = remaining.filter((r) => r.id !== id);
        return { status: 204 };
      }
      return { body: { total_count: remaining.length, actions_caches: remaining } };
    });
    await c.invokeAction(
      "actions-cache",
      "acc:actions-cache:octo-org/app",
      "delete-cache:7",
      "acc",
    );
    expect(calls[0]!.url.pathname).toBe("/repos/octo-org/app/actions/caches/7");
    await c.invokeAction(
      "actions-cache",
      "acc:actions-cache:octo-org/app",
      "delete-all-caches",
      "acc",
    );
    expect(remaining).toEqual([]);
  });
});

describe("budgets", () => {
  it("computes this month's spend within the budget's product and scope", () => {
    const items = [
      { product: "actions", sku: "actions_linux", netAmount: 5, repositoryName: "o/app" },
      { product: "actions", sku: "actions_macos", netAmount: 7, repositoryName: "o/web" },
      { product: "copilot", sku: "copilot_for_business", netAmount: 19 },
    ];
    expect(
      GitHubClient.budgetSpend(
        {
          budget_type: "ProductPricing",
          budget_product_sku: "actions",
          budget_scope: "organization",
        },
        items,
        [],
      ),
    ).toBe(12);
    expect(
      GitHubClient.budgetSpend(
        {
          budget_type: "SkuPricing",
          budget_product_sku: "actions_linux",
          budget_scope: "organization",
        },
        items,
        [],
      ),
    ).toBe(5);
    expect(
      GitHubClient.budgetSpend(
        {
          budget_type: "ProductPricing",
          budget_product_sku: "actions",
          budget_scope: "repository",
          budget_entity_name: "o/web",
        },
        items,
        [],
      ),
    ).toBe(7);
    expect(
      GitHubClient.budgetSpend(
        { budget_type: "BundlePricing", budget_product_sku: "ai_credits", budget_scope: "user" },
        items,
        [],
      ),
    ).toBeUndefined();
  });

  it("builds the create body from pickers", () => {
    expect(
      buildBudgetBody({
        product: "sku:actions_linux",
        scope: "repository",
        repository: "octo-org/app",
        budgetAmount: "50",
        preventFurtherUsage: "true",
        willAlert: "true",
        alertRecipients: "mona, hubot",
      }),
    ).toEqual({
      budget_type: "SkuPricing",
      budget_product_sku: "actions_linux",
      budget_scope: "repository",
      budget_amount: 50,
      prevent_further_usage: true,
      budget_entity_name: "octo-org/app",
      budget_alerting: { will_alert: true, alert_recipients: ["mona", "hubot"] },
    });
    expect(() =>
      buildBudgetBody({
        product: "product:actions",
        scope: "user",
        user: "mona",
        budgetAmount: "5",
      }),
    ).toThrow(/AI credits or premium requests/);
  });

  it("edits only the mutable fields", async () => {
    const { c, calls } = client((url, method) => {
      if (method === "PATCH") return { body: {} };
      if (url.pathname.endsWith("/budgets/b1")) {
        return {
          body: { id: "b1", budget_alerting: { will_alert: true, alert_recipients: ["mona"] } },
        };
      }
      if (url.pathname.endsWith("/budgets")) {
        return {
          body: {
            budgets: [
              {
                id: "b1",
                budget_type: "ProductPricing",
                budget_product_sku: "actions",
                budget_scope: "organization",
                budget_amount: 80,
              },
            ],
          },
        };
      }
      return { body: { usageItems: [] } };
    });
    await c.updateResource("budget", "acc:budget:b1", "acc", {
      budgetAmount: "80",
      willAlert: "false",
    });
    const patch = calls.find((x) => x.method === "PATCH")!;
    expect(patch.url.pathname).toBe("/organizations/octo-org/settings/billing/budgets/b1");
    expect(patch.body).toEqual({
      budget_amount: 80,
      budget_alerting: { will_alert: false, alert_recipients: ["mona"] },
    });
  });
});

describe("cost centres", () => {
  it("diffs member edits into add and remove calls", async () => {
    const { c, calls } = client((url, method) => {
      if (url.pathname.endsWith("/cost-centers/cc1") && method === "GET") {
        return {
          body: {
            id: "cc1",
            name: "Platform",
            resources: [
              { type: "User", name: "mona" },
              { type: "Repo", name: "o/a" },
            ],
          },
        };
      }
      if (url.pathname.endsWith("/cost-centers")) {
        return {
          body: { costCenters: [{ id: "cc1", name: "Platform", state: "active", resources: [] }] },
        };
      }
      return { body: { usageItems: [] } };
    }, "enterprise:big");
    await c.updateResource("cost-center", "acc:cost-center:cc1", "acc", {
      users: "mona, hubot",
      repositories: "",
    });
    const del = calls.find((x) => x.method === "DELETE")!;
    const post = calls.find((x) => x.method === "POST")!;
    expect(del.body).toEqual({ repositories: ["o/a"] });
    expect(post.body).toEqual({ users: ["hubot"] });
  });
});

describe("owner picker", () => {
  it("merges GraphQL and REST, enterprises first", async () => {
    const { http } = makeHttp((url) =>
      url.pathname === "/graphql"
        ? {
            body: {
              data: {
                viewer: {
                  organizations: { nodes: [{ login: "octo-org", name: "Octo Org" }] },
                  enterprises: { nodes: [{ slug: "big", name: "Big Corp" }] },
                },
              },
            },
          }
        : { body: [{ login: "octo-org" }, { login: "side-project" }] },
    );
    const options = await listOwnerOptions({ token: "t", host: "github.com" }, { http });
    expect(options.map((o) => o.id)).toEqual([
      "enterprise:big",
      "org:octo-org",
      "org:side-project",
    ]);
  });

  it("is reachable through the plugin for the owner field only", async () => {
    await expect(plugin.listCredentialOptions!("token", {}, undefined)).rejects.toThrow();
  });
});

describe("metrics", () => {
  it("builds Actions minutes by OS, premium requests and spend from line items", () => {
    const range = {
      startMs: Date.parse("2026-09-01T00:00:00Z"),
      endMs: Date.parse("2026-09-30T00:00:00Z"),
    };
    const series = usageSeries(
      [
        {
          date: "2026-09-02",
          sku: "actions_linux",
          unitType: "minutes",
          quantity: 100,
          netAmount: 0,
        },
        {
          date: "2026-09-02",
          sku: "actions_linux_4_core",
          unitType: "Minutes",
          quantity: 50,
          netAmount: 0.8,
        },
        {
          date: "2026-09-02",
          sku: "actions_macos",
          unitType: "minutes",
          quantity: 10,
          netAmount: 0.6,
        },
        {
          date: "2026-09-03",
          sku: "Copilot Premium Request",
          unitType: "requests",
          quantity: 30,
          netAmount: 1.2,
        },
      ],
      range,
    );
    const by = Object.fromEntries(series.map((s) => [s.label, s.points.map((p) => p.value)]));
    expect(by["Actions minutes (Linux)"]).toEqual([150]);
    expect(by["Actions minutes (macOS)"]).toEqual([10]);
    expect(by["Premium requests"]).toEqual([30]);
    expect(by["Net spend"]).toEqual([1.4, 1.2]);
  });

  it("reads day_totals out of the Copilot NDJSON report", () => {
    const days = parseCopilotReport([
      `${JSON.stringify({ report_start_day: "2026-09-01", day_totals: [{ day: "2026-09-01", daily_active_users: 4, weekly_active_users: 9 }] })}\n`,
    ]);
    expect(days).toEqual([{ day: "2026-09-01", daily_active_users: 4, weekly_active_users: 9 }]);
  });
});
