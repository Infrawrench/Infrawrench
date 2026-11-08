import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

// `config export|plan|apply` on effect/cli: the document to stdout or a file,
// the plan rendering, apply's gate, the document read from a file or stdin,
// `--sections` narrowing, `--json`, and the refusals, against fixtures.
vi.mock("electron", () => ({
  app: { getPath: () => "/tmp", getVersion: () => "9.9.9" },
  shell: { openExternal: vi.fn() },
  ipcMain: { handle: () => {} },
  safeStorage: { isEncryptionAvailable: () => false },
}));

vi.mock("../cloud-tokens", () => ({
  getAccessToken: vi.fn(async () => "tok"),
  forceRefreshAccessToken: vi.fn(async () => null),
  fetchCloudOrgs: vi.fn(async () => [{ id: "org_1", displayName: "Acme", role: "admin" }]),
  getAuthStatus: vi.fn(async () => ({ authenticated: true, email: "ada@example.com" })),
  clearStoredTokens: vi.fn(),
  createPkceChallenge: vi.fn(),
  buildAuthorizeUrl: vi.fn(),
  exchangeAuthorizationCode: vi.fn(),
  setTokenStoreReadOnly: vi.fn(),
}));

import { run, serveRoutes, useCliCapture } from "./cli-harness";

const out = useCliCapture();

const cli = (...argv: string[]) => {
  out.stdout = "";
  out.stderr = "";
  return run(...argv);
};

const dir = mkdtempSync(path.join(tmpdir(), "iw-config-"));
const at = (name: string) => path.join(dir, name);

const documentBody = {
  version: 1,
  exportedAt: "2026-11-08T12:00:00.000Z",
  exportedFrom: { organizationId: "org_1", organizationName: "Acme" },
  budgets: [{ key: "prod", name: "Prod" }],
  dashboards: [{ key: "ops" }, { key: "cost" }],
  workflows: [],
  tagPolicy: { required: ["env"] },
};

const planBody = (over: Record<string, unknown> = {}) => ({
  mode: "merge",
  changes: [
    {
      section: "budgets",
      key: "prod",
      name: "Prod",
      action: "update",
      fields: ["amount", "period"],
    },
    { section: "budgets", key: "dev", name: "Dev", action: "create" },
    { section: "dashboards", key: "ops", name: "Ops", action: "unchanged" },
    { section: "dashboards", key: "old", name: "Old", action: "delete" },
  ],
  unresolved: [
    { section: "dashboards", key: "ops", detail: "Card 3 pins a resource nobody synced." },
  ],
  counts: { create: 1, update: 1, delete: 1, unchanged: 1 },
  ...over,
});

const noop = planBody({
  changes: [{ section: "budgets", key: "prod", name: "Prod", action: "unchanged" }],
  unresolved: [],
  counts: { create: 0, update: 0, delete: 0, unchanged: 1 },
});

const routes = {
  "GET /config/export": documentBody,
  "GET /config/export?sections=budgets%2Cdashboards": documentBody,
  "POST /config/plan": planBody(),
  "POST /config/apply": { ...planBody(), applied: true },
};

/** The request bodies sent with `method`, parsed. */
const sentBodies = (method: string) =>
  vi
    .mocked(fetch)
    .mock.calls.filter(([, init]) => init?.method === method)
    .map(([, init]) => JSON.parse(String(init?.body)));

const docFile = at("infrawrench.json");
writeFileSync(docFile, JSON.stringify({ version: 1, budgets: [], dashboards: [], probes: [] }));

describe("config export", () => {
  it("prints the document to stdout, bare and as export", async () => {
    serveRoutes(out, routes);
    expect(await cli("config")).toBe(0);
    expect(out.stdout).toBe(`${JSON.stringify(documentBody, null, 2)}\n`);
    serveRoutes(out, routes);
    expect(await cli("config", "export", "--sections", "budgets,dashboards")).toBe(0);
    expect(out.requests.at(-1)).toBe("GET /config/export?sections=budgets%2Cdashboards");
  });

  it("writes the document to --out (or -f) with a summary", async () => {
    serveRoutes(out, routes);
    expect(await cli("config", "export", "--out", at("a.json"))).toBe(0);
    expect(out.stdout.replaceAll(dir, "<dir>")).toMatchInlineSnapshot(`
      "✓ wrote <dir>/a.json
      1 budgets · 2 dashboards

      Commit it, then \`infrawrench config apply -f <file>\` to put it back (or into another org).
      "
    `);
    expect(readFileSync(at("a.json"), "utf8")).toBe(`${JSON.stringify(documentBody, null, 2)}\n`);
    serveRoutes(out, routes);
    expect(await cli("config", "export", "-f", at("b.json"), "--json")).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({
      org: "org_1",
      path: at("b.json"),
      counts: { budgets: 1, workflows: 0, dashboards: 2 },
    });
    serveRoutes(out, { ...routes, "GET /config/export": { version: 1 } });
    expect(await cli("config", "export", "--out", at("c.json"))).toBe(0);
    expect(out.stdout.replaceAll(dir, "<dir>")).toMatchInlineSnapshot(`
      "✓ wrote <dir>/c.json
      Nothing configured yet. The document is a valid empty starting point.

      Commit it, then \`infrawrench config apply -f <file>\` to put it back (or into another org).
      "
    `);
  });

  it("refuses a path it cannot write, and --local", async () => {
    serveRoutes(out, routes);
    expect(await cli("config", "export", "--out", at("missing/dir/x.json"))).toBe(2);
    expect(out.stderr.replaceAll(dir, "<dir>")).toMatchInlineSnapshot(`
      "Can't write <dir>/missing/dir/x.json: ENOENT: no such file or directory, open '<dir>/missing/dir/x.json'
      "
    `);
    expect(await cli("config", "--local")).toBe(1);
    expect(out.stderr).toMatchInlineSnapshot(`
      "Config as code covers cloud organizations only. Drop --local.
      "
    `);
  });
});

describe("config plan", () => {
  it("renders the plan from a file, merge and replace", async () => {
    serveRoutes(out, routes);
    expect(await cli("config", "plan", "-f", docFile)).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Plan (merge)

      budgets
        ~ Prod [prod]  (amount, period)
        + Dev [dev]

      dashboards
        - Old [old]

      1 to create · 1 to update · 1 to delete · 1 unchanged

      Not applied:
        ! dashboards · ops
          Card 3 pins a resource nobody synced.
      "
    `);
    expect(sentBodies("POST")).toEqual([
      { document: { version: 1, budgets: [], dashboards: [], probes: [] }, mode: "merge" },
    ]);
    serveRoutes(out, { ...routes, "POST /config/plan": planBody({ mode: "replace" }) });
    expect(await cli("config", "diff", "--file", docFile, "--prune")).toBe(0);
    expect(out.stdout.split("\n")[0]).toMatchInlineSnapshot(
      `"Plan (replace: anything not in the document is deleted)"`,
    );
    expect(sentBodies("POST").at(-1).mode).toBe("replace");
    serveRoutes(out, { ...routes, "POST /config/plan": noop });
    expect(await cli("config", "plan", "-f", docFile)).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Plan (merge)

      No changes.

      1 unchanged
      "
    `);
  });

  it("prints --json as the server sent it, narrowed by --sections", async () => {
    serveRoutes(out, routes);
    expect(await cli("config", "plan", "-f", docFile, "--sections", "budgets", "--json")).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ org: "org_1", ...planBody() });
    expect(sentBodies("POST")).toEqual([{ document: { version: 1, budgets: [] }, mode: "merge" }]);
  });

  it("names an action this build does not know", async () => {
    serveRoutes(out, {
      ...routes,
      "POST /config/plan": planBody({
        changes: [{ section: "rituals", key: "r", name: "Rain dance", action: "summon" }],
        unresolved: [],
      }),
    });
    expect(await cli("config", "plan", "-f", docFile)).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Plan (merge)

      rituals
        ? (summon) Rain dance [r]

      1 to create · 1 to update · 1 to delete · 1 unchanged
      "
    `);
  });

  describe("reading stdin", () => {
    const real = Object.getOwnPropertyDescriptor(process, "stdin");
    afterEach(() => {
      if (real) Object.defineProperty(process, "stdin", real);
    });
    const pipe = (text: string) =>
      Object.defineProperty(process, "stdin", {
        configurable: true,
        get: () => Object.assign(Readable.from([Buffer.from(text)]), { isTTY: false }),
      });

    it("reads a piped document", async () => {
      pipe(JSON.stringify({ version: 1, slos: [] }));
      serveRoutes(out, routes);
      expect(await cli("config", "plan", "--json")).toBe(0);
      expect(sentBodies("POST")).toEqual([{ document: { version: 1, slos: [] }, mode: "merge" }]);
    });

    it("refuses a piped document that is not one", async () => {
      pipe("[1, 2]");
      expect(await cli("config", "plan")).toBe(2);
      expect(out.stderr).toMatchInlineSnapshot(`
        "Expected a config document object at the top level.
        "
      `);
      pipe("{ nope");
      expect(await cli("config", "plan")).toBe(2);
      expect(out.stderr).toMatchInlineSnapshot(`
        "That file isn't valid JSON: Expected property name or '}' in JSON at position 2 (line 1 column 3)
        "
      `);
    });

    it("refuses when nothing is piped at a terminal", async () => {
      Object.defineProperty(process, "stdin", {
        configurable: true,
        get: () => Object.assign(new Readable({ read() {} }), { isTTY: true }),
      });
      expect(await cli("config", "plan")).toBe(2);
      expect(out.stderr).toMatchInlineSnapshot(`
        "No document. Pass --file <path> or pipe one on stdin (\`infrawrench config export | …\`).
        "
      `);
    });
  });

  it("refuses an unreadable file, bad JSON and an unknown section", async () => {
    writeFileSync(at("bad.json"), "{ nope");
    writeFileSync(at("list.json"), "[]");
    const said: string[] = [];
    for (const argv of [
      ["config", "plan", "-f", at("none.json")],
      ["config", "plan", "-f", at("bad.json")],
      ["config", "apply", "-f", at("list.json")],
      ["config", "plan", "-f", docFile, "--sections", "budgets,rituals"],
    ]) {
      serveRoutes(out, routes);
      expect(await cli(...argv)).toBe(2);
      said.push(out.stderr.replaceAll(dir, "<dir>"));
    }
    expect(said).toMatchInlineSnapshot(`
      [
        "Can't read <dir>/none.json: ENOENT: no such file or directory, open '<dir>/none.json'
      ",
        "That file isn't valid JSON: Expected property name or '}' in JSON at position 2 (line 1 column 3)
      ",
        "Expected a config document object at the top level.
      ",
        "Unknown section(s): rituals. Valid: budgets, customGraphs, workflows, dashboards, metricAlerts, probes, slos, costCentres, tagPolicy, alertSettings, savingsViews.
      ",
      ]
    `);
  });
});

describe("config apply", () => {
  it("plans, then applies with -y", async () => {
    serveRoutes(out, routes);
    expect(await cli("config", "apply", "-f", docFile, "-y")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Plan (merge)

      budgets
        ~ Prod [prod]  (amount, period)
        + Dev [dev]

      dashboards
        - Old [old]

      1 to create · 1 to update · 1 to delete · 1 unchanged

      Not applied:
        ! dashboards · ops
          Card 3 pins a resource nobody synced.

      Applied (merge)

      budgets
        ~ Prod [prod]  (amount, period)
        + Dev [dev]

      dashboards
        - Old [old]

      1 to create · 1 to update · 1 to delete · 1 unchanged

      Not applied:
        ! dashboards · ops
          Card 3 pins a resource nobody synced.
      "
    `);
    expect(out.requests).toEqual(["POST /config/plan", "POST /config/apply"]);
    serveRoutes(out, routes);
    expect(await cli("config", "apply", "-f", docFile, "-y", "--json")).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ org: "org_1", ...planBody(), applied: true });
  });

  it("stops when there is nothing to apply", async () => {
    serveRoutes(out, { ...routes, "POST /config/plan": noop });
    expect(await cli("config", "apply", "-f", docFile)).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Plan (merge)

      No changes.

      1 unchanged

      Already up to date. Nothing to apply.
      "
    `);
    expect(out.requests).toEqual(["POST /config/plan"]);
    serveRoutes(out, { ...routes, "POST /config/plan": noop });
    expect(await cli("config", "apply", "-f", docFile, "--json")).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ org: "org_1", ...noop, applied: false });
  });

  it("refuses to apply unasked off a terminal", async () => {
    serveRoutes(out, routes);
    expect(await cli("config", "apply", "-f", docFile)).toBe(2);
    expect(out.stderr).toMatchInlineSnapshot(`
      "Refusing to apply without confirmation on a non-interactive terminal. Re-run with -y once you've reviewed the plan.
      "
    `);
    expect(out.requests).toEqual(["POST /config/plan"]);
  });
});
