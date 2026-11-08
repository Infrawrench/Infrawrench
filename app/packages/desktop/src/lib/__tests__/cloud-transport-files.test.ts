/**
 * The cloud calls whose answer is a file (a CSV, a PDF, a ZIP, the typings)
 * or that send a header (the fan-out's change-freeze override), over the
 * cloud transport: what each sends, and that the bytes or text reach the
 * caller as the per-channel handlers handed them over.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RESOURCE_REPORT_CONFIG } from "@infrawrench/client-core";

vi.mock("../rpc/client", async () => (await import("./fake-rpc")).fakeRpcClientModule);
vi.mock("../rpc/desktop-client", async () => (await import("./fake-rpc")).fakeRpcClientModule);

const ui = vi.hoisted(() => ({
  activeCloudOrgId: "org-1" as string | null,
  downloadBlob: vi.fn<(blob: Blob, name: string) => void>(),
}));
vi.mock("@infrawrench/ui", () => ({
  useUIStore: { getState: () => ({ activeCloudOrgId: ui.activeCloudOrgId }) },
  downloadBlob: ui.downloadBlob,
  createSharingClient: () => ({}),
}));

const { answerCloudHttp, answerCloudHttpBytes, resetFakeRpc } = await import("./fake-rpc");
const costs = await import("../cloud-costs");
const resources = await import("../cloud-resources");
const fanout = await import("../cloud-ssh-fanout");
const { createCloudCustomGraphsClient } = await import("../cloud-custom-graphs");
const { createDesktopResourceReportsClient } = await import("../resource-reports-client");
const { createDesktopInvoicesClient } = await import("../invoices-client");

const ORG = "/api/org/org-1";
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff]);
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const tzQuery = tz ? `?tz=${encodeURIComponent(tz)}` : "";

beforeEach(() => {
  resetFakeRpc();
  ui.activeCloudOrgId = "org-1";
  ui.downloadBlob.mockReset();
});

/** Every request a transport mock received, bodies parsed. */
function requests(
  http: ReturnType<typeof answerCloudHttp> | ReturnType<typeof answerCloudHttpBytes>,
) {
  return http.mock.calls.map(([request]) => ({
    method: request.method,
    url: request.url,
    ...(request.body === undefined ? {} : { body: JSON.parse(request.body) }),
    ...(request.headers === undefined ? {} : { headers: request.headers }),
  }));
}

describe("binary answers", () => {
  it("reads the report, dashboard and canvas PDFs with the local zone", async () => {
    const http = answerCloudHttpBytes(() => ({ status: 200, bytes: PDF }));

    expect(await costs.loadCloudCostReportPdf("org-1", "r1")).toEqual(PDF);
    expect(await costs.loadCloudDashboardPdf("org-1", "d1")).toEqual(PDF);

    expect(requests(http)).toEqual([
      { method: "GET", url: `${ORG}/cost-reports/r1/pdf${tzQuery}` },
      { method: "GET", url: `${ORG}/dashboards/d1/pdf${tzQuery}` },
    ]);
  });

  it("reads the compliance evidence pack for the framework and period", async () => {
    const http = answerCloudHttpBytes(() => ({ status: 200, bytes: PDF }));

    const pack = await resources.loadCloudCompliancePack("org-1", "soc2", {
      from: "2026-08-01",
      to: "",
    });

    expect(pack).toEqual(PDF);
    expect(requests(http)).toEqual([
      { method: "GET", url: `${ORG}/compliance/pack?framework=soc2&from=2026-08-01` },
    ]);
  });

  it("saves an invoice's PDF as its bytes and its CSV as the text's UTF-8", async () => {
    const bytes = answerCloudHttpBytes(() => ({ status: 200, bytes: PDF }));
    const text = answerCloudHttp((request) =>
      request.url.endsWith("/export")
        ? { status: 200, text: "line,amount\nHosting – EU,12.5\n" }
        : { status: 200, json: { id: "inv-12345678", number: "INV-2026-0001" } },
    );
    const client = createDesktopInvoicesClient();
    const invoice = await client.getInvoice("inv-12345678");

    await client.downloadInvoiceFile?.(invoice, "pdf");
    await client.downloadInvoiceFile?.(invoice, "csv");

    expect(requests(bytes)).toEqual([{ method: "GET", url: `${ORG}/invoices/inv-12345678/pdf` }]);
    expect(requests(text)).toEqual([
      { method: "GET", url: `${ORG}/invoices/inv-12345678` },
      { method: "GET", url: `${ORG}/invoices/inv-12345678/export` },
    ]);
    const [pdf, csv] = ui.downloadBlob.mock.calls;
    expect(pdf?.[1]).toBe("INV-2026-0001.pdf");
    expect(new Uint8Array((await pdf?.[0].arrayBuffer()) ?? new ArrayBuffer(0))).toEqual(PDF);
    expect(csv?.[1]).toBe("INV-2026-0001.csv");
    expect(await csv?.[0].text()).toBe("line,amount\nHosting – EU,12.5\n");
  });

  it("fails a refused PDF with the sentence the handlers threw, the query included", async () => {
    answerCloudHttpBytes(() => ({
      status: 404,
      bytes: new TextEncoder().encode('{"error":"Dashboard not found"}'),
    }));

    await expect(costs.loadCloudDashboardPdf("org-1", "d1")).rejects.toThrow(
      `Cloud request failed: 404 /dashboards/d1/pdf${tzQuery} {"error":"Dashboard not found"}`,
    );
  });
});

describe("text answers", () => {
  it("hands the FOCUS CSV on as text, stating the filters the server defaults", async () => {
    const http = answerCloudHttp(() => ({ status: 200, text: "BilledCost\n1.00\n" }));

    const csv = await costs.downloadCloudFocusExport("org-1", {
      from: "2026-10-01",
      to: "2026-10-31",
      version: "1.4",
    });

    expect(csv).toBe("BilledCost\n1.00\n");
    expect(requests(http)).toEqual([
      {
        method: "POST",
        url: `${ORG}/costs/focus-export`,
        body: { from: "2026-10-01", to: "2026-10-31", filters: [], version: "1.4" },
      },
    ]);
  });

  it("writes a finished export job's text back to the bytes the caller saves", async () => {
    const http = answerCloudHttp(() => ({ status: 200, text: '{"cost":1}\n' }));

    const file = await costs.loadCloudCostExportJobFile("org-1", "job-1");

    expect(new TextDecoder().decode(file)).toBe('{"cost":1}\n');
    expect(requests(http)).toEqual([
      { method: "GET", url: `${ORG}/costs/exports/jobs/job-1/download` },
    ]);
  });

  it("reads the access review export in either format as the text the server wrote", async () => {
    const pretty = '{\n  "findings": []\n}';
    const http = answerCloudHttp((request) =>
      request.url.includes("format=json")
        ? { status: 200, text: pretty }
        : { status: 200, text: '"Resource","Rule"\n' },
    );

    expect(await resources.exportCloudAccessReview("org-1", "csv", 90)).toBe('"Resource","Rule"\n');
    expect(await resources.exportCloudAccessReview("org-1", "json", 30)).toBe(pretty);
    expect(requests(http)).toEqual([
      { method: "GET", url: `${ORG}/access-review/export?format=csv&staleDays=90` },
      { method: "GET", url: `${ORG}/access-review/export?format=json&staleDays=30` },
    ]);
  });

  it("reads the custom-graph typings and the resource report CSV", async () => {
    const http = answerCloudHttp((request) =>
      request.url.endsWith("/typings")
        ? { status: 200, text: "declare const infra: Infra;" }
        : { status: 200, text: "name,cost\n" },
    );
    const config = DEFAULT_RESOURCE_REPORT_CONFIG;

    expect(await createCloudCustomGraphsClient("org-1").typings?.()).toBe(
      "declare const infra: Infra;",
    );
    expect(await createDesktopResourceReportsClient().exportCsv(config, "Unowned")).toBe(
      "name,cost\n",
    );
    expect(requests(http)).toEqual([
      { method: "GET", url: `${ORG}/custom-graphs/typings` },
      { method: "POST", url: `${ORG}/resource-reports/csv`, body: { config, name: "Unowned" } },
    ]);
  });
});

describe("the fan-out", () => {
  const body = {
    command: "uptime",
    targets: [{ kind: "account" as const, id: "a1" }],
    sshKeyId: undefined,
  };

  it("runs without the override header, and with it when the user overrides a freeze", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { results: [] } }));

    expect(await fanout.runCloudFanout("org-1", body, false)).toEqual({
      kind: "results",
      results: [],
    });
    await fanout.runCloudFanout("org-1", body, true);

    expect(requests(http)).toEqual([
      {
        method: "POST",
        url: `${ORG}/ssh-fanout/run`,
        body: { command: "uptime", targets: [{ kind: "account", id: "a1" }] },
      },
      {
        method: "POST",
        url: `${ORG}/ssh-fanout/run`,
        body: { command: "uptime", targets: [{ kind: "account", id: "a1" }] },
        headers: { "x-change-freeze-override": "true" },
      },
    ]);
  });

  it("answers a freeze as data, with the server's sentence", async () => {
    answerCloudHttp(() => ({
      status: 423,
      json: { error: "Frozen for the launch", code: "change_freeze_active" },
    }));
    expect(await fanout.runCloudFanout("org-1", body, false)).toEqual({
      kind: "freeze",
      message: "Frozen for the launch",
    });

    answerCloudHttp(() => ({ status: 423 }));
    expect(await fanout.runCloudFanout("org-1", body, false)).toEqual({
      kind: "freeze",
      message: "Blocked by an active change freeze",
    });
  });

  it("fails any other refusal with the server's sentence, else the old fallback", async () => {
    answerCloudHttp(() => ({ status: 400, json: { error: "Select at least one target" } }));
    await expect(fanout.runCloudFanout("org-1", body, false)).rejects.toThrow(
      "Select at least one target",
    );

    answerCloudHttp(() => ({ status: 502, text: "Bad gateway" }));
    await expect(fanout.runCloudFanout("org-1", body, false)).rejects.toThrow("Fan-out run failed");
  });

  it("lists, saves and deletes the org's snippets", async () => {
    const http = answerCloudHttp((request) =>
      request.method === "GET"
        ? { status: 200, json: { snippets: [{ id: "s1", name: "Uptime", command: "uptime" }] } }
        : { status: 200, json: request.method === "POST" ? { id: "s2" } : { ok: true } },
    );

    expect(await fanout.listCloudFanoutSnippets("org-1")).toEqual([
      { id: "s1", name: "Uptime", command: "uptime" },
    ]);
    await fanout.createCloudFanoutSnippet("org-1", { name: "Disk", command: "df -h" });
    await fanout.deleteCloudFanoutSnippet("org-1", "s1");

    expect(requests(http)).toEqual([
      { method: "GET", url: `${ORG}/ssh-fanout/snippets` },
      {
        method: "POST",
        url: `${ORG}/ssh-fanout/snippets`,
        body: { name: "Disk", command: "df -h" },
      },
      { method: "DELETE", url: `${ORG}/ssh-fanout/snippets/s1` },
    ]);
  });
});
