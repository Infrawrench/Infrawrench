/**
 * The renderer clients of the findings, inventory and ops areas on the cloud
 * transport (posture, leaked secrets, vulnerabilities, access review,
 * savings, the calendar, the palette and the resource side calls), against a
 * fake `CloudHttp`: what each call sends, and what the panel gets back or
 * sees as the error.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";

vi.mock("../rpc/client", async () => (await import("./fake-rpc")).fakeRpcClientModule);
vi.mock("../rpc/desktop-client", async () => (await import("./fake-rpc")).fakeRpcClientModule);

let activeCloudOrgId: string | null = "org-1";
vi.mock("@infrawrench/ui", () => ({
  useUIStore: { getState: () => ({ activeCloudOrgId }) },
}));

const { answerCloudHttp, fakeRpc, resetFakeRpc } = await import("./fake-rpc");
const resources = await import("../cloud-resources");
const ownership = await import("../cloud-ownership");
const { createDesktopPaletteClient } = await import("../cloud-palette");
const { createDesktopSeatsClient } = await import("../seats-client");
const { createDesktopOrphansClient } = await import("../orphans-client");
const { createDesktopRightsizingClient } = await import("../rightsizing-client");
const { createDesktopExtendedSupportClient } = await import("../extended-support-client");
const { createDesktopMomentClient } = await import("../moment-client");
const { listCloudFanoutTargets } = await import("../cloud-ssh-fanout");
const { cloudSshTunnelCreateAccount, cloudSshTunnelExec } = await import("../cloud-sftp");
const { compareCloudPriceCatalog, searchCloudPriceCatalog } =
  await import("../cloud-price-catalog");
const { SEARCH_OBJECT_KINDS } = await import("@infrawrench/client-core");

const SEAT = "6f1f6a52-4c7b-4b7e-9d2c-2d3f4a5b6c7d";
const ACCOUNT_A = "0b9c2e3f-1d4a-4c5b-8e6f-7a8b9c0d1e2f";
const ACCOUNT_B = "1c0d3f4a-2e5b-4d6c-9f7a-8b9c0d1e2f3a";

beforeEach(() => {
  resetFakeRpc();
  activeCloudOrgId = "org-1";
});

/** The one request sent, with its JSON body parsed (the encoder writes keys in schema order). */
function sent(http: ReturnType<typeof answerCloudHttp>) {
  expect(http).toHaveBeenCalledTimes(1);
  const request = http.mock.calls[0]![0];
  return { ...request, body: request.body === undefined ? undefined : JSON.parse(request.body) };
}

describe("posture", () => {
  it("lists, dismisses and restores findings", async () => {
    let http = answerCloudHttp(() => ({ status: 200, json: { findings: [] } }));
    await resources.fetchCloudPosture("org-1");
    expect(sent(http)).toEqual({ method: "GET", url: "/api/org/org-1/posture", body: undefined });

    http = answerCloudHttp(() => ({ status: 201, json: {} }));
    await resources.dismissCloudPostureFinding("org-1", "r1", "aws:public-bucket", "accepted");
    expect(sent(http)).toEqual({
      method: "POST",
      url: "/api/org/org-1/posture/dismissals",
      body: { resourceId: "r1", ruleId: "aws:public-bucket", reason: "accepted" },
    });

    http = answerCloudHttp(() => ({ status: 204 }));
    await resources.restoreCloudPostureFinding("org-1", "r1", "aws:public-bucket");
    expect(sent(http)).toEqual({
      method: "DELETE",
      url: "/api/org/org-1/posture/dismissals?resourceId=r1&ruleId=aws%3Apublic-bucket",
      body: undefined,
    });
  });
});

describe("leaked credentials", () => {
  it("reads the account banner's open leaks", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { leaks: [] } }));
    await resources.fetchCloudAccountLeaks("org-1", "acc-1");
    expect(sent(http).url).toBe("/api/org/org-1/leaked-secrets?status=open&accountId=acc-1");
  });

  it("acts on one leak and hands back the leak", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { leak: { id: "l1" } } }));
    const client = resources.cloudLeakedCredentialsClient("org-1", true);
    await expect(client.dismiss?.("l 1", { reason: "false-positive" })).resolves.toEqual({
      id: "l1",
    });
    expect(sent(http)).toEqual({
      method: "POST",
      url: "/api/org/org-1/leaked-secrets/l%201/dismiss",
      body: { reason: "false-positive" },
    });
  });

  it("reopens and scans without a body", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { leak: { id: "l1" } } }));
    const client = resources.cloudLeakedCredentialsClient("org-1", true);
    await client.reopen?.("l1");
    expect(sent(http)).toEqual({
      method: "POST",
      url: "/api/org/org-1/leaked-secrets/l1/reopen",
      body: undefined,
    });
  });

  it("offers only the list without write access", () => {
    const client = resources.cloudLeakedCredentialsClient("org-1", false);
    expect(Object.keys(client)).toEqual(["list"]);
  });
});

describe("vulnerabilities", () => {
  it("trims the dismissal reason and leaves out an empty one", async () => {
    let http = answerCloudHttp(() => ({ status: 201, json: {} }));
    await resources.dismissCloudVulnerability("org-1", "CVE-1", "*", "  known  ");
    expect(sent(http).body).toEqual({ advisoryId: "CVE-1", artifactKey: "*", reason: "known" });

    http = answerCloudHttp(() => ({ status: 201, json: {} }));
    await resources.dismissCloudVulnerability("org-1", "CVE-1", "*", "   ");
    expect(sent(http).body).toEqual({ advisoryId: "CVE-1", artifactKey: "*" });
  });

  it("restores with the artifact key in the query", async () => {
    const http = answerCloudHttp(() => ({ status: 204 }));
    await resources.restoreCloudVulnerability("org-1", "CVE-1", "ecr/repo/app");
    expect(sent(http)).toEqual({
      method: "DELETE",
      url: "/api/org/org-1/vulnerabilities/dismissals?advisoryId=CVE-1&artifactKey=ecr%2Frepo%2Fapp",
      body: undefined,
    });
  });

  it("writes the settings patch", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { alertsEnabled: false } }));
    await resources.updateCloudVulnerabilitySettings("org-1", { alertsEnabled: false });
    expect(sent(http)).toEqual({
      method: "PUT",
      url: "/api/org/org-1/vulnerabilities/settings",
      body: { alertsEnabled: false },
    });
  });
});

describe("access review", () => {
  it("reads the review for a window and dismisses a finding", async () => {
    let http = answerCloudHttp(() => ({ status: 200, json: { principals: [] } }));
    await resources.fetchCloudAccessReview("org-1", 30);
    expect(sent(http).url).toBe("/api/org/org-1/access-review?staleDays=30");

    http = answerCloudHttp(() => ({ status: 201, json: {} }));
    await resources.dismissCloudAccessFinding("org-1", "r1", "access-review:no-mfa", "break glass");
    expect(sent(http)).toEqual({
      method: "POST",
      url: "/api/org/org-1/access-review/dismissals",
      body: { resourceId: "r1", ruleId: "access-review:no-mfa", reason: "break glass" },
    });
  });
});

describe("the operations calendar", () => {
  it("sends the kinds only when they narrow the window", async () => {
    let http = answerCloudHttp(() => ({ status: 200, json: { events: [] } }));
    const range = { from: "2026-11-01T00:00:00.000Z", to: "2026-12-01T00:00:00.000Z" };
    await resources.fetchCloudCalendar("org-1", { ...range, kinds: [] });
    expect(sent(http).url).toBe(
      "/api/org/org-1/calendar?from=2026-11-01T00%3A00%3A00.000Z&to=2026-12-01T00%3A00%3A00.000Z",
    );

    http = answerCloudHttp(() => ({ status: 200, json: { events: [] } }));
    await resources.fetchCloudCalendar("org-1", { ...range, kinds: ["change-freeze", "incident"] });
    expect(sent(http).url).toContain("&kinds=change-freeze%2Cincident");
  });

  it("refuses a subscription answer without its one-time URL", async () => {
    answerCloudHttp(() => ({ status: 201, json: { id: "s1" } }));
    await expect(
      resources.createCloudCalendarSubscription("org-1", { name: "Ops", kinds: [] }),
    ).rejects.toThrow("The server did not return a subscription URL");
  });

  it("revokes a subscription by id", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { id: SEAT } }));
    await resources.revokeCloudCalendarSubscription("org-1", SEAT);
    expect(sent(http)).toEqual({
      method: "DELETE",
      url: `/api/org/org-1/calendar/subscriptions/${SEAT}`,
      body: undefined,
    });
  });
});

describe("the environment diff", () => {
  it("asks for identity fields only when wanted and names both sides of a change", async () => {
    const http = answerCloudHttp(() => ({
      status: 200,
      json: { entries: [{ key: "k", changes: [{ field: "size", a: "s" }] }] },
    }));
    const diff = await resources.fetchCloudEnvironmentDiff("org-1", {
      a: ACCOUNT_A,
      b: ACCOUNT_B,
      includeIdentityFields: true,
    });
    expect(sent(http).url).toBe(
      `/api/org/org-1/environment-diff?a=${ACCOUNT_A}&b=${ACCOUNT_B}&includeIdentityFields=true`,
    );
    expect(diff.entries[0]?.changes[0]).toEqual({ field: "size", a: "s", b: undefined });
  });
});

describe("the resource side calls", () => {
  it("posts the metrics and peer panes requests", async () => {
    let http = answerCloudHttp(() => ({ status: 200, json: { series: [] } }));
    const body = { accountId: "a", resourceId: "r" };
    await resources.fetchCloudMetrics("org-1", "p", "t", body);
    expect(sent(http)).toEqual({
      method: "POST",
      url: "/api/org/org-1/resources/p/t/metrics",
      body,
    });

    http = answerCloudHttp(() => ({ status: 200, json: { panes: [] } }));
    await resources.fetchCloudPeerPanes("org-1", "p", "t", body);
    expect(sent(http)).toEqual({
      method: "POST",
      url: "/api/org/org-1/resources/p/t/peer-panes",
      body,
    });
  });

  it("execs and creates an account through a cloud tunnel", async () => {
    let http = answerCloudHttp(() => ({ status: 200, json: { stdout: "ok", code: 0 } }));
    const exec = { sshHost: "h", sshPort: 22, sshUser: "u", sshKeyId: "k", command: "ls" };
    await expect(cloudSshTunnelExec("org-1", exec)).resolves.toEqual({ stdout: "ok", code: 0 });
    expect(sent(http)).toEqual({
      method: "POST",
      url: "/api/org/org-1/ssh-tunnels/exec",
      body: exec,
    });

    http = answerCloudHttp(() => ({ status: 200, json: { accountId: "new" } }));
    const create = {
      sshHost: "h",
      sshPort: 22,
      sshUser: "u",
      sshKeyId: "k",
      remoteHost: "rh",
      remotePort: 5432,
      pluginId: "p",
      displayName: "n",
      credentials: {},
    };
    await expect(cloudSshTunnelCreateAccount("org-1", create)).resolves.toEqual({
      accountId: "new",
    });
    expect(sent(http)).toEqual({
      method: "POST",
      url: "/api/org/org-1/ssh-tunnels/create-account",
      body: create,
    });
  });

  it("lists the fan-out targets", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { targets: [{ id: "t1" }] } }));
    await expect(listCloudFanoutTargets("org-1")).resolves.toEqual([{ id: "t1" }]);
    expect(sent(http).url).toBe("/api/org/org-1/ssh-fanout/targets");
  });
});

describe("ownership", () => {
  it("reads, saves and clears one resource's record", async () => {
    let http = answerCloudHttp(() => ({ status: 200, json: { ownership: null } }));
    await expect(ownership.fetchCloudResourceOwnership("org-1", "r/1")).resolves.toBeNull();
    expect(sent(http).url).toBe("/api/org/org-1/ownership/resource?resourceId=r%2F1");

    http = answerCloudHttp(() => ({ status: 204 }));
    await ownership.clearCloudResourceOwnership("org-1", "r1");
    expect(sent(http)).toEqual({
      method: "DELETE",
      url: "/api/org/org-1/ownership?resourceId=r1",
      body: undefined,
    });
  });
});

describe("the command palette", () => {
  it("searches the object kinds only", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: [] }));
    await createDesktopPaletteClient("org-1").search(" budget ", new AbortController().signal);
    const url = new URL(sent(http).url, "https://cloud.test");
    expect(url.pathname).toBe("/api/org/org-1/search");
    expect(url.searchParams.get("q")).toBe("budget");
    expect(url.searchParams.get("kinds")).toBe(SEARCH_OBJECT_KINDS.join(","));
  });

  it("stars and unstars by kind and id", async () => {
    let http = answerCloudHttp(() => ({ status: 200, json: { item: { kind: "slo", id: "s1" } } }));
    const palette = createDesktopPaletteClient("org-1");
    await expect(palette.star({ kind: "slo", id: "s 1" })).resolves.toEqual({
      kind: "slo",
      id: "s1",
    });
    expect(sent(http)).toEqual({
      method: "PUT",
      url: "/api/org/org-1/starred/slo/s%201",
      body: undefined,
    });

    http = answerCloudHttp(() => ({ status: 200, json: { ok: true } }));
    await expect(palette.unstar({ kind: "slo", id: "s1" })).resolves.toBeUndefined();
    expect(sent(http).method).toBe("DELETE");
  });
});

describe("seats", () => {
  it("shows the server's refusal verbatim", async () => {
    answerCloudHttp(() => ({
      status: 423,
      json: { error: "An active change freeze blocks this" },
    }));
    await expect(createDesktopSeatsClient().removeSeat(SEAT)).rejects.toThrow(
      /^An active change freeze blocks this$/,
    );
  });

  it("keeps the transport's sentence for a body without one", async () => {
    answerCloudHttp(() => ({ status: 502 }));
    await expect(createDesktopSeatsClient().refreshSeats()).rejects.toThrow(
      "Cloud request failed: 502 /seats/refresh ",
    );
  });

  it("drops a null remediation and sends only the window", async () => {
    let http = answerCloudHttp(() => ({
      status: 200,
      json: { findings: [{ seatId: SEAT, remediation: null }] },
    }));
    const list = await createDesktopSeatsClient().listSeats();
    expect(list.findings[0]).toEqual({ seatId: SEAT });
    expect(sent(http).url).toBe("/api/org/org-1/seats");

    http = answerCloudHttp(() => ({ status: 200, json: { inactiveDays: 60 } }));
    await createDesktopSeatsClient().updateSeatSettings?.({ inactiveDays: 60 });
    expect(sent(http)).toEqual({
      method: "PUT",
      url: "/api/org/org-1/seats/settings",
      body: { inactiveDays: 60 },
    });
  });
});

describe("savings", () => {
  it("reads orphans from the cloud, or the local scan without an org", async () => {
    const http = answerCloudHttp(() => ({
      status: 200,
      json: { accounts: [{ resources: [{ id: "r1", remediation: null }] }] },
    }));
    const cloud = await createDesktopOrphansClient().listOrphans();
    expect(cloud.accounts[0]?.resources[0]).toEqual({ id: "r1" });
    expect(sent(http).url).toBe("/api/org/org-1/orphans");

    activeCloudOrgId = null;
    fakeRpc["LocalOrphansList"] = vi.fn(() => Effect.succeed({ accounts: [] }));
    await expect(createDesktopOrphansClient().listOrphans()).resolves.toEqual({ accounts: [] });
  });

  it("saves the idle rules and refuses them signed out", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { rules: {} } }));
    await createDesktopOrphansClient({ withIdleRules: true }).idleFindings?.save({
      enabled: true,
      lookbackDays: 14,
      rules: {},
    });
    expect(sent(http)).toEqual({
      method: "PUT",
      url: "/api/org/org-1/idle-findings/settings",
      body: { enabled: true, lookbackDays: 14, rules: {} },
    });

    activeCloudOrgId = null;
    expect(() =>
      createDesktopOrphansClient({ withIdleRules: true }).idleFindings?.rescan(),
    ).toThrow("Idle rules need Infrawrench Cloud; sign in to tune them.");
  });

  it("asks for a fresh right-sizing and extended-support scan only on refresh", async () => {
    let http = answerCloudHttp(() => ({ status: 200, json: { accounts: [] } }));
    await createDesktopRightsizingClient().listRightsizing(true);
    expect(sent(http).url).toBe("/api/org/org-1/rightsizing?refresh=true");

    http = answerCloudHttp(() => ({ status: 200, json: { accounts: [] } }));
    await createDesktopRightsizingClient().listRightsizing();
    expect(sent(http).url).toBe("/api/org/org-1/rightsizing");

    http = answerCloudHttp(() => ({ status: 200, json: { findings: [] } }));
    await createDesktopExtendedSupportClient().listExtendedSupport(false);
    expect(sent(http).url).toBe("/api/org/org-1/extended-support");
  });
});

describe("the moment view", () => {
  it("sends the centre and the half-window", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { items: [] } }));
    await createDesktopMomentClient().getMoment({
      at: "2026-11-08T03:14:00.000Z",
      windowMinutes: 30,
    });
    expect(sent(http).url).toBe("/api/org/org-1/moment?at=2026-11-08T03%3A14%3A00.000Z&window=30");
  });

  it("refuses without an org", () => {
    activeCloudOrgId = null;
    expect(() => createDesktopMomentClient().getMoment({})).toThrow(
      "The moment view requires cloud mode: sign in to sync.",
    );
  });
});

describe("the price catalog", () => {
  it("serializes the query as web does", async () => {
    let http = answerCloudHttp(() => ({ status: 200, json: { rows: [] } }));
    await searchCloudPriceCatalog("org-1", { q: "gpu", pluginIds: ["aws", "gcp"], minVcpus: 4 });
    const search = new URL(sent(http).url, "https://cloud.test");
    expect(search.pathname).toBe("/api/org/org-1/price-catalog/search");
    expect(Object.fromEntries(search.searchParams)).toEqual({
      q: "gpu",
      pluginIds: "aws,gcp",
      minVcpus: "4",
    });

    http = answerCloudHttp(() => ({ status: 200, json: { providers: [] } }));
    await compareCloudPriceCatalog("org-1", { reference: { pluginId: "aws", sku: "m5.large" } });
    const compare = new URL(sent(http).url, "https://cloud.test");
    expect(Object.fromEntries(compare.searchParams)).toEqual({
      referencePluginId: "aws",
      referenceSku: "m5.large",
    });
  });
});

describe("the read-only feeds", () => {
  it.each([
    ["expiring", () => resources.fetchCloudExpiring("org-1"), "/api/org/org-1/expiring"],
    ["dns", () => resources.fetchCloudDns("org-1"), "/api/org/org-1/dns"],
    ["wallboard", () => resources.fetchCloudWallboard("org-1"), "/api/org/org-1/wallboard"],
    [
      "vulnerabilities",
      () => resources.fetchCloudVulnerabilities("org-1"),
      "/api/org/org-1/vulnerabilities",
    ],
  ])("reads %s", async (_name, call, url) => {
    const http = answerCloudHttp(() => ({ status: 200, json: {} }));
    await call();
    expect(sent(http)).toEqual({ method: "GET", url, body: undefined });
  });

  it("shows the server's failure in the words the handlers used", async () => {
    answerCloudHttp(() => ({ status: 500, json: { error: "boom" } }));
    await expect(resources.fetchCloudWallboard("org-1")).rejects.toThrow(
      'Cloud request failed: 500 /wallboard {"error":"boom"}',
    );
  });
});
