/**
 * Invoices, services and scorecards, and SSH install over the cloud
 * transport: what each call sends, the defaults the desktop fills in where
 * the contract's answer leaves a field optional, and the sentences the panels
 * show on a failure.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../rpc/client", async () => (await import("./fake-rpc")).fakeRpcClientModule);
vi.mock("../rpc/desktop-client", async () => (await import("./fake-rpc")).fakeRpcClientModule);

let activeCloudOrgId: string | null = "org-1";
vi.mock("@infrawrench/ui", () => ({
  useUIStore: { getState: () => ({ activeCloudOrgId }) },
}));

const { answerCloudHttp, resetFakeRpc } = await import("./fake-rpc");
const { createDesktopInvoicesClient } = await import("../invoices-client");
const services = await import("../cloud-services");
const { runCloudSshInstall, listCloudSshInstallAccounts } = await import("../cloud-ssh-install");

const ORG = "/api/org/org-1";

beforeEach(() => {
  resetFakeRpc();
  activeCloudOrgId = "org-1";
});

/** Every request the transport received, bodies parsed. */
function requests(http: ReturnType<typeof answerCloudHttp>) {
  return http.mock.calls.map(([request]) => ({
    method: request.method,
    url: request.url,
    ...(request.body === undefined ? {} : { body: JSON.parse(request.body) }),
  }));
}

describe("the invoices client", () => {
  it("reads the customer book, the invoices and the scope picker's lists", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: [] }));
    const client = createDesktopInvoicesClient();
    await client.listManagedAccounts();
    await client.listInvoices();
    await client.listCostCentres();
    await client.listBillingProfiles?.();
    expect(requests(http)).toEqual([
      { method: "GET", url: `${ORG}/managed-accounts` },
      { method: "GET", url: `${ORG}/invoices` },
      { method: "GET", url: `${ORG}/cost-centres` },
      { method: "GET", url: `${ORG}/billing-profiles` },
    ]);
  });

  it("drops the keys a form left undefined, as JSON.stringify did over IPC", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { id: "c1" } }));
    await createDesktopInvoicesClient().createManagedAccount?.({
      name: "Acme",
      contactName: undefined,
      contactEmail: null,
      billingCurrency: "EUR",
      pricing: undefined,
      costCentreIds: ["cc1"],
      accountIds: [],
    });
    expect(requests(http)).toEqual([
      {
        method: "POST",
        url: `${ORG}/managed-accounts`,
        body: {
          name: "Acme",
          contactEmail: null,
          billingCurrency: "EUR",
          costCentreIds: ["cc1"],
          accountIds: [],
        },
      },
    ]);
  });

  it("approves, sends (with or without resend) and voids", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { id: "i1" } }));
    const client = createDesktopInvoicesClient();
    await client.approveInvoice?.("i1");
    await client.sendInvoice?.("i1");
    await client.sendInvoice?.("i1", true);
    await client.voidInvoice?.("i1", "wrong period", true);
    expect(requests(http)).toEqual([
      { method: "POST", url: `${ORG}/invoices/i1/approve` },
      { method: "POST", url: `${ORG}/invoices/i1/send`, body: { resend: false } },
      { method: "POST", url: `${ORG}/invoices/i1/send`, body: { resend: true } },
      {
        method: "POST",
        url: `${ORG}/invoices/i1/void`,
        body: { reason: "wrong period", supersede: true },
      },
    ]);
  });

  it("sends the unassigned-spend period only when one is given", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: {} }));
    const client = createDesktopInvoicesClient();
    await client.findUnassignedSpend?.();
    await client.findUnassignedSpend?.({ from: "2026-09-01", to: "2026-09-30" });
    expect(requests(http).map((r) => r.url)).toEqual([
      `${ORG}/managed-accounts/unassigned`,
      `${ORG}/managed-accounts/unassigned?from=2026-09-01&to=2026-09-30`,
    ]);
  });

  it("previews a candidate rule with the nulls the server would have filled", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: {} }));
    await createDesktopInvoicesClient().previewPricing?.({
      rule: {
        name: "Markup",
        enabled: true,
        priority: 10,
        match: { pluginId: "aws" },
        adjustment: { kind: "percentage", percent: 10 },
      },
      month: "2026-09",
    });
    expect(requests(http)).toEqual([
      {
        method: "POST",
        url: `${ORG}/billing-rules/preview`,
        body: {
          month: "2026-09",
          rule: {
            name: "Markup",
            description: null,
            enabled: true,
            priority: 10,
            match: { pluginId: "aws" },
            adjustment: {
              kind: "percentage",
              percent: 10,
              amount: null,
              currency: null,
              period: null,
              targetKind: null,
              targetId: null,
              tiers: null,
              tierMode: null,
              tierScope: null,
              expression: null,
            },
          },
        },
      },
    ]);
  });

  it("refuses without an active org, in the panel's words", async () => {
    activeCloudOrgId = null;
    await expect(createDesktopInvoicesClient().listInvoices()).rejects.toThrow(
      "Invoices require cloud mode: sign in to sync.",
    );
  });
});

describe("services and scorecards", () => {
  it("removes, restores and looks up members", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { services: {} } }));
    await services.removeCloudServiceMember("org-1", "s1", "aws:a:i-1");
    await services.restoreCloudServiceMember("org-1", "s1", "aws:a:i-1");
    await services.getCloudServicesForResources("org-1", ["aws:a:i-1", "aws:a:i,2"]);
    expect(requests(http)).toEqual([
      { method: "DELETE", url: `${ORG}/services/s1/members/aws%3Aa%3Ai-1` },
      { method: "DELETE", url: `${ORG}/services/s1/members/aws%3Aa%3Ai-1?restore=1` },
      { method: "GET", url: `${ORG}/services/for-resources?ids=aws%3Aa%3Ai-1%2Caws%3Aa%3Ai%2C2` },
    ]);
  });

  it("reads the org grade's history for a number of days only when given", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { points: [] } }));
    await services.getCloudOrgScorecardHistory("org-1");
    await services.getCloudOrgScorecardHistory("org-1", 30);
    expect(requests(http).map((r) => r.url)).toEqual([
      `${ORG}/scorecards/org/history`,
      `${ORG}/scorecards/org/history?days=30`,
    ]);
  });

  it("hands on the schedules out of their envelope", async () => {
    answerCloudHttp(() => ({ status: 200, json: { schedules: [{ id: "oc1" }] } }));
    await expect(services.listCloudOnCallSchedules("org-1")).resolves.toEqual([{ id: "oc1" }]);
  });

  it("reads a virtual tag's stored rules with every field present", async () => {
    answerCloudHttp(() => ({
      status: 200,
      json: [
        {
          id: "v1",
          rules: [
            { kind: "value", value: "prod" },
            { kind: "tag", sources: [{ tagKey: "env" }] },
          ],
        },
      ],
    }));
    const [tag] = await services.listCloudVirtualTags("org-1");
    expect(tag?.rules).toEqual([
      {
        query: "",
        description: null,
        startsOn: null,
        endsOn: null,
        kind: "value",
        value: "prod",
        sources: [],
        valueTransform: "none",
        allocations: [],
      },
      {
        query: "",
        description: null,
        startsOn: null,
        endsOn: null,
        kind: "tag",
        value: null,
        sources: [{ tagKey: "env", valuePrefix: null, query: null }],
        valueTransform: "none",
        allocations: [],
      },
    ]);
  });

  it("reads a posture category this build does not know as other", async () => {
    answerCloudHttp(() => ({
      status: 200,
      json: {
        findings: {
          posture: {
            counts: {},
            items: [
              { ruleId: "a", category: "encryption" },
              { ruleId: "b", category: "supply-chain" },
            ],
          },
        },
      },
    }));
    const summary = await services.getCloudServiceSummary("org-1", "s1");
    expect(summary.findings.posture.items.map((f) => f.category)).toEqual(["encryption", "other"]);
  });
});

describe("SSH install", () => {
  it("lists the enrolling accounts and posts the install", async () => {
    const http = answerCloudHttp((request) =>
      request.method === "GET"
        ? { status: 200, json: [] }
        : { status: 200, json: { message: "Installed" } },
    );
    await listCloudSshInstallAccounts("org-1");
    await expect(
      runCloudSshInstall("org-1", {
        installerAccountId: "ts1",
        target: { accountId: "a1", resourceTypeId: "droplet", resourceId: "do:a1:1" },
        sshKeyId: undefined,
        username: "root",
        port: 22,
      }),
    ).resolves.toEqual({ message: "Installed" });
    expect(requests(http)).toEqual([
      { method: "GET", url: `${ORG}/resources/ssh-install/accounts` },
      {
        method: "POST",
        url: `${ORG}/resources/ssh-install`,
        body: {
          installerAccountId: "ts1",
          target: { accountId: "a1", resourceTypeId: "droplet", resourceId: "do:a1:1" },
          username: "root",
          port: 22,
        },
      },
    ]);
  });

  const input = {
    installerAccountId: "ts1",
    target: { accountId: "a1", resourceTypeId: "droplet", resourceId: "do:a1:1" },
  };

  it("shows the server's message, else its error, else the body", async () => {
    answerCloudHttp(() => ({
      status: 409,
      json: { error: "ssh_host_key_trust_required", message: "Host key not trusted" },
    }));
    await expect(runCloudSshInstall("org-1", input)).rejects.toThrow("Host key not trusted");

    answerCloudHttp(() => ({ status: 423, json: { error: "A change freeze is in effect" } }));
    await expect(runCloudSshInstall("org-1", input)).rejects.toThrow(
      "A change freeze is in effect",
    );

    answerCloudHttp(() => ({ status: 502, json: "upstream down" }));
    await expect(runCloudSshInstall("org-1", input)).rejects.toThrow('"upstream down"');
  });

  it("names the status when the refusal has no body", async () => {
    answerCloudHttp(() => ({ status: 500 }));
    await expect(runCloudSshInstall("org-1", input)).rejects.toThrow(
      "SSH installation failed (500).",
    );
  });
});

describe("cost canvases", () => {
  it("runs, previews and opens the side conversation with the bodies the handlers sent", async () => {
    const { createDesktopCostCanvasesClient } = await import("../cost-canvases-client");
    const http = answerCloudHttp((request) =>
      request.url.endsWith("/conversation")
        ? { status: 200, json: { conversationId: "conv1" } }
        : { status: 200, json: { blocks: [] } },
    );
    const client = createDesktopCostCanvasesClient("org-1");
    await client.runCanvas("c1");
    await client.runCanvas("c1", { includeChartData: false });
    await client.previewCanvas?.({ version: 1, blocks: [] }, "Draft");
    await expect(client.ensureConversation?.("c1")).resolves.toBe("conv1");
    await client.ensureConversation?.("c1", { fresh: true });
    expect(requests(http)).toEqual([
      { method: "POST", url: `${ORG}/cost-canvases/c1/run`, body: { includeChartData: true } },
      { method: "POST", url: `${ORG}/cost-canvases/c1/run`, body: { includeChartData: false } },
      {
        method: "POST",
        url: `${ORG}/cost-canvases/preview`,
        body: { spec: { version: 1, blocks: [] }, name: "Draft", includeChartData: false },
      },
      { method: "POST", url: `${ORG}/cost-canvases/c1/conversation`, body: {} },
      { method: "POST", url: `${ORG}/cost-canvases/c1/conversation`, body: { fresh: true } },
    ]);
  });

  it("reads a stored canvas with the defaulted block fields present", async () => {
    const { createDesktopCostCanvasesClient } = await import("../cost-canvases-client");
    const dateRange = { kind: "relative", preset: "30d" };
    answerCloudHttp(() => ({
      status: 200,
      json: {
        id: "c1",
        spec: {
          version: 1,
          blocks: [
            { id: "t", kind: "text", text: "Hello" },
            { id: "k", kind: "kpi", title: "Spend", metric: { type: "spend", dateRange } },
            { id: "a", kind: "anomalies", title: "Anomalies" },
            {
              id: "g",
              kind: "chart",
              title: "Chart",
              config: {
                version: 1,
                chartType: "line",
                binning: "daily",
                dateRange,
                groupBy: "none",
              },
            },
          ],
        },
      },
    }));
    const canvas = await createDesktopCostCanvasesClient("org-1").getCanvas("c1");
    expect(canvas.spec.blocks).toEqual([
      { id: "t", kind: "text", text: "Hello" },
      { id: "k", kind: "kpi", title: "Spend", metric: { type: "spend", dateRange, filters: [] } },
      { id: "a", kind: "anomalies", title: "Anomalies", days: 30, limit: 10 },
      {
        id: "g",
        kind: "chart",
        title: "Chart",
        config: {
          version: 1,
          chartType: "line",
          binning: "daily",
          dateRange,
          groupBy: "none",
          filters: [],
          topN: 5,
          comparePreviousPeriod: false,
          showForecast: false,
        },
      },
    ]);
  });
});
