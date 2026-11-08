import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `deploy` on effect/cli: a run streamed as it goes (stages, logs, build
// output), `--plan` with its diff against the last deploy, `--json`, the run
// recorded locally and in the org, the history (`log`), `outputs`,
// `rollback`, the ledger (`status`, `destroy --created`), `typings`, and the
// refusals. The workflow runtime, Docker and the plugins are fakes; the local
// deploy history is a real file in a temporary userData directory.
const state = vi.hoisted(() => ({
  userData: "",
  /** What the fake `runInfrafile` does with the host it is handed. */
  script: async (_opts: never): Promise<unknown> => ({}),
}));

vi.mock("electron", () => ({
  app: { getPath: () => state.userData, getVersion: () => "9.9.9" },
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

vi.mock("../cli/context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cli/context")>()),
  listLocalAccounts: vi.fn(async () => [
    { id: "acc_local", pluginId: "hetzner", displayName: "Lab" },
  ]),
}));

const listed = vi.hoisted(() => ({
  rows: [{ id: "acc_local:server:1", externalId: "1" }],
}));

vi.mock("../infrafile/plugin-host", () => ({
  createLocalPluginClient: vi.fn(async () => ({
    listResources: async (typeId: string) => {
      if (typeId === "volume") throw new Error("volumes: 403 Forbidden");
      return listed.rows;
    },
    deleteResource: async (_typeId: string, resourceId: string) => {
      if (resourceId.endsWith(":stuck")) throw new Error("still attached");
    },
  })),
  createPluginClientFromCredentials: vi.fn(async (pluginId: string, credentials: unknown) => ({
    listResources: async () => [{ id: `from-${pluginId}`, credentials }],
  })),
}));

vi.mock("../infrafile/plugins.js", () => ({
  loadPlugins: vi.fn(async () => [
    {
      plugin: {
        manifest: { id: "hetzner", displayName: "Hetzner Cloud" },
        resourceTypes: [
          {
            id: "server",
            displayName: "Server",
            pluralDisplayName: "Servers",
            outputs: [{ key: "ipv4", label: "IPv4" }],
            supportsCreate: true,
          },
        ],
      },
    },
  ]),
  getPlugin: vi.fn(async () => undefined),
}));

vi.mock("../infrafile/build-local", () => ({
  buildLocally: vi.fn(async (_request: unknown, options: { log: (line: string) => void }) => {
    options.log("#1 [internal] load build definition");
    options.log("#2 DONE 0.4s");
    return { image: "acme/web:abc1234" };
  }),
  pushLocally: vi.fn(async () => {}),
  runInImage: vi.fn(async () => ({ exitCode: 0 })),
}));

vi.mock("@infrawrench/workflow-runtime", () => ({
  runInfrafile: vi.fn((opts: never) => state.script(opts)),
  attachSidecarInfo: vi.fn(async () => {}),
  generateInfrafileDts: vi.fn(
    ({ plugins, envs }: { plugins: Array<{ pluginId: string }>; envs: string[] }) =>
      `// plugins: ${plugins.map((p) => p.pluginId).join(", ")}\ntype InfraEnv = ${envs.map((e) => JSON.stringify(e)).join(" | ") || "string"};\n`,
  ),
  buildWorkflowHost: vi.fn(
    (opts: {
      listPlugins: () => Promise<unknown>;
      getClient: (accountId: string) => Promise<{
        listResources: (typeId: string) => Promise<unknown>;
        deleteResource: (typeId: string, id: string) => Promise<void>;
      }>;
      prompt: (spec: unknown) => Promise<unknown>;
    }) => ({
      listPlugins: opts.listPlugins,
      prompt: opts.prompt,
      listResources: async (accountId: string, typeId: string) =>
        (await opts.getClient(accountId)).listResources(typeId),
      deleteResource: async (accountId: string, typeId: string, resourceId: string) =>
        (await opts.getClient(accountId)).deleteResource(typeId, resourceId),
    }),
  ),
}));

import { run, serveRoutes, useCliCapture } from "./cli-harness";
import { recordLocalDeploy, type LocalDeployRun } from "../deploy-history";

const out = useCliCapture();

let project = "";
beforeEach(() => {
  state.userData = mkdtempSync(path.join(tmpdir(), "iw-deploy-data-"));
  project = mkdtempSync(path.join(tmpdir(), "iw-deploy-project-"));
  writeFileSync(
    path.join(project, "Infrafile"),
    `export default { envs: ["prod"], plan() {}, deploy() {} };\n`,
  );
  vi.spyOn(process, "cwd").mockReturnValue(project);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-08T12:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(state.userData, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

const cli = (...argv: string[]) => {
  out.stdout = "";
  out.stderr = "";
  return run(...argv);
};

/** Paths that differ between runs, for snapshots. */
const scrub = (text: string) => text.replaceAll(project, "<project>");

interface FakeRunOptions {
  host: {
    infrafileBuild: (request: unknown) => Promise<{ image: string }>;
    infrafileAnswer: (key: string) => Promise<string | undefined>;
    listPlugins: () => Promise<unknown>;
    listResources: (accountId: string, typeId: string) => Promise<unknown>;
  };
  env?: string;
  planOnly?: boolean;
  destroy?: boolean;
  destroyPlan?: unknown;
  onLog?: (entry: { at: number; level: string; message: string }) => void;
  onStage?: (stage: string) => void;
}

/** A runtime that walks the stages, logging and building through the host as a real one does. */
const deployScript =
  (over: Record<string, unknown> = {}) =>
  async (opts: FakeRunOptions) => {
    const logs: Array<{ at: number; level: string; message: string }> = [];
    const log = (level: string, message: string) => {
      const entry = { at: Date.now(), level, message };
      logs.push(entry);
      opts.onLog?.(entry);
    };
    if (opts.destroy) {
      opts.onStage?.("destroy");
      log("info", `tearing down with plan ${JSON.stringify(opts.destroyPlan ?? null)}`);
      return {
        status: "success",
        env: opts.env ?? "prod",
        notes: [],
        createdResources: [],
        plannedChanges: [],
        logs,
        durationMs: 900,
        ...over,
      };
    }
    opts.onStage?.("plan");
    log("info", `region answer: ${(await opts.host.infrafileAnswer("region")) ?? "(none)"}`);
    opts.onStage?.("dockerfile");
    if (opts.planOnly) {
      return {
        status: "success",
        env: opts.env ?? "prod",
        plan: { region: "fsn1", replicas: 2, registryToken: "secret" },
        dockerfile: "FROM node:22\nCOPY . .",
        notes: [],
        createdResources: [],
        plannedChanges: [
          {
            action: "create",
            accountId: "acc_local",
            resourceTypeId: "server",
            displayName: "web-1",
          },
          {
            action: "update",
            accountId: "acc_local",
            resourceTypeId: "server",
            displayName: "web-2",
          },
          {
            action: "delete",
            accountId: "acc_local",
            resourceTypeId: "volume",
            displayName: "old",
          },
        ],
        logs,
        durationMs: 300,
        ...over,
      };
    }
    opts.onStage?.("build");
    const built = await opts.host.infrafileBuild({ dockerfile: "FROM node:22" });
    opts.onStage?.("deploy");
    log("error", "health check flapped once");
    return {
      status: "success",
      env: opts.env ?? "prod",
      plan: { region: "fsn1", replicas: 2 },
      dockerfile: "FROM node:22",
      image: built.image,
      notes: ["rolled 2 servers"],
      createdResources: [
        {
          pluginId: "hetzner",
          accountId: "acc_local",
          resourceTypeId: "server",
          resourceId: "acc_local:server:1",
          externalId: "1",
          displayName: "web-1",
        },
      ],
      plannedChanges: [],
      logs,
      output: { url: "https://web.example.com" },
      durationMs: 4200,
      reachedStage: "deploy",
      ...over,
    };
  };

const localRun = (over: Partial<LocalDeployRun> = {}): LocalDeployRun => ({
  id: "run-1",
  startedAt: "2026-11-01T09:30:00.000Z",
  env: "prod",
  repo: "acme/web",
  branch: "main",
  gitSha: "abc1234def",
  dirty: false,
  image: "acme/web:abc1234",
  status: "success",
  stage: "deploy",
  durationMs: 61_000,
  dir: "/src/web",
  notes: [],
  createdResources: [],
  error: null,
  orgId: null,
  plan: { region: "nbg1", replicas: 2, registryToken: "old" },
  output: { url: "https://old.example.com" },
  ...over,
});

const cloudRun = (
  id: string,
  status: string,
  image: string | null,
  over: Record<string, unknown> = {},
) => ({
  id,
  env: "prod",
  repo: "acme/web",
  branch: "main",
  gitSha: `${id}cafe00`,
  image,
  status,
  origin: "cli",
  stage: "deploy",
  durationMs: 45_000,
  buildSeconds: null,
  buildRunner: null,
  startedAt: "2026-11-0" + id.slice(-1) + "T10:00:00.000Z",
  ...over,
});

const runs = [
  cloudRun("run3", "success", "acme/web:333"),
  cloudRun("run2", "failure", null, { durationMs: null }),
  cloudRun("run1", "success", "acme/web:111", { origin: "web" }),
];

describe("deploy", () => {
  it("streams a local deploy and records it on this machine", async () => {
    state.script = deployScript();
    serveRoutes(out, {});
    expect(await cli("deploy", "--local", "--set", "region=fsn1")).toBe(0);
    expect(scrub(out.stdout)).toMatchInlineSnapshot(`
      "Infrafile
      commit  0000000 (HEAD)

      [plan]
      region answer: fsn1
      [dockerfile]
      [build]
      #1 [internal] load build definition
      #2 DONE 0.4s
      [deploy]
      health check flapped once

      ✓ deployed acme/web:abc1234 to prod
      "
    `);
    expect(out.requests).toEqual([]);

    expect(await cli("deploy", "log", "--local")).toBe(0);
    expect(out.stdout).toContain("acme/web:abc1234");
  });

  it("prints --json with the build output interleaved into the logs", async () => {
    state.script = deployScript();
    serveRoutes(out, {});
    expect(await cli("deploy", "--local", "--json")).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchInlineSnapshot(`
      {
        "dockerfile": "FROM node:22",
        "durationMs": 4200,
        "env": "prod",
        "image": "acme/web:abc1234",
        "logs": [
          {
            "at": 1794139200000,
            "level": "info",
            "message": "region answer: (none)",
          },
          {
            "at": 1794139200000,
            "level": "error",
            "message": "health check flapped once",
          },
          {
            "at": 1794139200000,
            "level": "info",
            "message": "#1 [internal] load build definition",
          },
          {
            "at": 1794139200000,
            "level": "info",
            "message": "#2 DONE 0.4s",
          },
        ],
        "notes": [
          "rolled 2 servers",
        ],
        "plan": {
          "region": "fsn1",
          "replicas": 2,
        },
        "plannedChanges": [],
        "status": "success",
      }
    `);
  });

  it("previews with --plan and diffs against the last local deploy", async () => {
    state.script = deployScript();
    recordLocalDeploy(localRun());
    serveRoutes(out, {});
    expect(await cli("deploy", "--plan", "--local", "-e", "prod")).toBe(0);
    expect(scrub(out.stdout)).toMatchInlineSnapshot(`
      "Infrafile
      commit  0000000 (HEAD)

      [plan]
      region answer: (none)
      [dockerfile]

      Plan
      {
        "region": "fsn1",
        "replicas": 2,
        "registryToken": "secret"
      }

      Dockerfile
      FROM node:22
      COPY . .

      Planned changes
      + server web-1
      ~ server web-2
      - volume old
      1 to create, 1 to update, 1 to delete

      Changes since last deploy:
      ~ region: "nbg1" → "fsn1"
      ~ registryToken: (redacted) → (redacted)

      Nothing was built. Re-run without --plan to deploy.
      "
    `);
    rmSync(path.join(state.userData, "deploy-history.jsonl"), { force: true });
    expect(await cli("deploy", "--plan", "--local")).toBe(0);
    expect(out.stdout).toContain("No previous deploy to diff against.");
  });

  it("records a cloud deploy in the org, with org accounts in the tree", async () => {
    state.script = async (opts: FakeRunOptions) => {
      const tree = await opts.host.listPlugins();
      const fromOrg = await opts.host.listResources("acc_org", "server");
      return deployScript({ notes: [JSON.stringify({ tree, fromOrg })] })(opts);
    };
    serveRoutes(out, {
      "GET /accounts": [
        { id: "acc_org", pluginId: "hetzner", displayName: "Lab", createdAt: "x" },
        { id: "acc_gpu", pluginId: "lambda-labs", displayName: "GPUs", createdAt: "x" },
      ],
      "GET /accounts/plugins": [{ id: "lambda-labs", displayName: "Lambda" }],
      "GET /accounts/acc_org/credentials": { token: "hcloud-test" },
      "POST /deployments/runs": { id: "6f9c1a2e-0000-4000-8000-000000000009" },
    });
    expect(await cli("deploy", "--json")).toBe(0);
    const printed = JSON.parse(out.stdout);
    expect(JSON.parse(printed.notes[0])).toMatchInlineSnapshot(`
      {
        "fromOrg": [
          {
            "credentials": {
              "token": "hcloud-test",
            },
            "id": "from-hetzner",
          },
        ],
        "tree": [
          {
            "accounts": [
              {
                "displayName": "Lab",
                "id": "acc_local",
                "pluginId": "hetzner",
              },
              {
                "displayName": "Lab (Acme)",
                "id": "acc_org",
                "pluginId": "hetzner",
              },
            ],
            "displayName": "Hetzner Cloud",
            "pluginId": "hetzner",
            "resourceTypes": [
              {
                "displayName": "Server",
                "id": "server",
                "outputs": [
                  {
                    "key": "ipv4",
                    "label": "IPv4",
                  },
                ],
                "pluralDisplayName": "Servers",
                "supportsCreate": true,
                "supportsDelete": true,
                "supportsUpdate": false,
              },
            ],
          },
          {
            "accounts": [
              {
                "displayName": "GPUs",
                "id": "acc_gpu",
                "pluginId": "lambda-labs",
              },
            ],
            "displayName": "Lambda",
            "pluginId": "lambda-labs",
            "resourceTypes": [],
          },
        ],
      }
    `);
    expect(out.requests).toEqual([
      "GET /accounts",
      "GET /accounts/plugins",
      "GET /accounts/acc_org/credentials",
      "POST /deployments/runs",
    ]);
    const recorded = vi
      .mocked(fetch)
      .mock.calls.filter(([, init]) => init?.method === "POST")
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(recorded).toMatchInlineSnapshot(`
      [
        {
          "branch": "HEAD",
          "createdResources": [
            {
              "accountId": "acc_local",
              "displayName": "web-1",
              "externalId": "1",
              "pluginId": "hetzner",
              "resourceId": "acc_local:server:1",
              "resourceTypeId": "server",
            },
          ],
          "durationMs": 4200,
          "env": "prod",
          "error": null,
          "gitSha": "0000000000000000000000000000000000000000",
          "image": "acme/web:abc1234",
          "notes": [
            "{"tree":[{"pluginId":"hetzner","displayName":"Hetzner Cloud","accounts":[{"id":"acc_local","pluginId":"hetzner","displayName":"Lab"},{"id":"acc_org","pluginId":"hetzner","displayName":"Lab (Acme)"}],"resourceTypes":[{"id":"server","displayName":"Server","pluralDisplayName":"Servers","outputs":[{"key":"ipv4","label":"IPv4"}],"supportsCreate":true,"supportsUpdate":false,"supportsDelete":true}]},{"pluginId":"lambda-labs","displayName":"Lambda","accounts":[{"id":"acc_gpu","pluginId":"lambda-labs","displayName":"GPUs"}],"resourceTypes":[]}],"fromOrg":[{"id":"from-hetzner","credentials":{"token":"hcloud-test"}}]}",
          ],
          "output": {
            "url": "https://web.example.com",
          },
          "plan": {
            "region": "fsn1",
            "replicas": 2,
          },
          "stage": "deploy",
          "status": "success",
        },
      ]
    `);
  });

  it("fails with the run's message, still recording it", async () => {
    state.script = deployScript({ status: "failure", error: { message: "health check failed" } });
    serveRoutes(out, {});
    expect(await cli("deploy", "--local")).toBe(1);
    expect(out.stderr).toMatchInlineSnapshot(`
      "health check failed
      "
    `);
    expect(await cli("deploy", "log", "--local", "--json")).toBe(0);
    expect(JSON.parse(out.stdout).map((r: LocalDeployRun) => [r.status, r.error])).toEqual([
      ["failure", "health check failed"],
    ]);
  });

  it("refuses what it cannot run, in the legacy sentences", async () => {
    state.script = deployScript();
    const said: string[] = [];
    for (const argv of [
      ["deploy", "--local", "--set", "region"],
      ["deploy", "destroy", "--plan"],
      ["deploy", "destroy", "--created"],
      ["deploy", "rollback", "--local"],
    ]) {
      serveRoutes(out, {});
      expect(await cli(...argv)).toBe(2);
      said.push(out.stderr);
    }
    rmSync(path.join(project, "Infrafile"));
    writeFileSync(path.join(project, ".git"), "");
    serveRoutes(out, {});
    expect(await cli("deploy", "--local")).toBe(2);
    said.push(scrub(out.stderr));
    expect(said).toMatchInlineSnapshot(`
      [
        "--set expects key=value, got "region".
      ",
        "--plan previews a deploy; destroy has no plan stage.
      ",
        "Deleting by ledger needs an explicit --env.
      ",
        "Rollback needs the cloud deploy history. Pass --org instead.
      ",
        "No Infrafile at the root of this repository (<project>).
      An Infrafile lives beside your .git directory.
      ",
      ]
    `);
  });
});

describe("deploy destroy", () => {
  it("runs destroy() with the last deploy's recorded plan", async () => {
    state.script = deployScript();
    recordLocalDeploy(localRun());
    serveRoutes(out, {});
    expect(await cli("deploy", "destroy", "--local")).toBe(0);
    expect(scrub(out.stdout)).toMatchInlineSnapshot(`
      "Infrafile
      commit  0000000 (HEAD)

      [destroy]
      tearing down with plan {"region":"nbg1","replicas":2,"registryToken":"old"}

      ✓ destroyed prod
      "
    `);
  });

  it("points at the ledger when the Infrafile has no destroy()", async () => {
    state.script = deployScript({
      status: "failure",
      error: { message: "The Infrafile has no destroy() stage." },
    });
    serveRoutes(out, {});
    expect(await cli("deploy", "destroy", "--local", "-e", "prod")).toBe(1);
    expect(out.stderr).toMatchInlineSnapshot(`
      "The Infrafile has no destroy() stage. Or run \`deploy destroy --created\` to delete what the ledger says this env created.
      "
    `);
  });

  it("deletes what the ledger recorded, children first", async () => {
    const ledger = [
      localRun({
        createdResources: [
          {
            pluginId: "hetzner",
            accountId: "acc_local",
            resourceTypeId: "server",
            resourceId: "acc_local:server:1",
            displayName: "web-1",
          },
          {
            pluginId: "hetzner",
            accountId: "acc_local",
            resourceTypeId: "volume",
            resourceId: "acc_local:volume:stuck",
            displayName: "data",
          },
        ],
      }),
    ];
    for (const entry of ledger) recordLocalDeploy(entry);
    serveRoutes(out, {});
    expect(await cli("deploy", "destroy", "--created", "-e", "prod", "--local")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "! could not delete volume data: still attached
      ✓ deleted server web-1

      1 deleted, 1 failed
      "
    `);
    for (const entry of ledger) recordLocalDeploy(entry);
    expect(await cli("deploy", "-e", "prod", "destroy", "--created", "--json")).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchInlineSnapshot(`
      {
        "deleted": 1,
        "env": "prod",
        "failed": 1,
        "notes": [
          "could not delete volume data: still attached",
          "deleted server web-1",
        ],
      }
    `);
    serveRoutes(out, {});
    expect(await cli("deploy", "destroy", "--created", "-e", "staging")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Nothing recorded. Deploys that create resources will appear here.
      "
    `);
  });
});

describe("deploy status", () => {
  it("checks what the ledger says exists", async () => {
    const ledger = [
      localRun({
        id: "older",
        env: "staging",
        createdResources: [
          {
            pluginId: "hetzner",
            accountId: "acc_local",
            resourceTypeId: "server",
            resourceId: "acc_local:server:2",
            displayName: "web-2",
          },
        ],
      }),
      localRun({
        createdResources: [
          {
            pluginId: "hetzner",
            accountId: "acc_local",
            resourceTypeId: "server",
            resourceId: "acc_local:server:1",
            externalId: "1",
            displayName: "web-1",
          },
          {
            pluginId: "hetzner",
            accountId: "acc_local",
            resourceTypeId: "volume",
            resourceId: "acc_local:volume:9",
            displayName: "data",
          },
          {
            pluginId: "kubernetes",
            accountId: "acc_local",
            resourceTypeId: "deployment",
            resourceId: "web",
            displayName: "web",
            sidecar: { pluginId: "kubernetes", parentResourceId: "acc_local:cluster:1" },
          },
        ],
      }),
    ];
    for (const entry of ledger) recordLocalDeploy(entry);
    serveRoutes(out, {});
    expect(await cli("deploy", "status", "--local")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "TYPE        NAME   ACCOUNT    ENV      STATE  
      deployment  web    acc_local  prod     unknown
      volume      data   acc_local  prod     unknown
      server      web-1  acc_local  prod     ok     
      server      web-2  acc_local  staging  missing

      1 ok, 1 missing, 2 unknown
      "
    `);
    expect(out.stderr).toMatchInlineSnapshot(`
      "could not list volume on acc_local: volumes: 403 Forbidden
      "
    `);
    for (const entry of ledger) recordLocalDeploy(entry);
    expect(await cli("deploy", "status", "--local", "-e", "staging", "--json")).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchInlineSnapshot(`
      [
        {
          "accountId": "acc_local",
          "displayName": "web-2",
          "env": "staging",
          "externalId": null,
          "resourceId": "acc_local:server:2",
          "resourceTypeId": "server",
          "state": "missing",
        },
      ]
    `);
    expect(await cli("deploy", "status")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "TYPE        NAME   ACCOUNT    ENV      STATE  
      deployment  web    acc_local  prod     unknown
      volume      data   acc_local  prod     unknown
      server      web-1  acc_local  prod     ok     
      server      web-2  acc_local  staging  missing

      1 ok, 1 missing, 2 unknown
      "
    `);
  });
});

describe("deploy log, outputs and rollback", () => {
  const routes = {
    "GET /deployments/runs": runs,
    "GET /deployments/runs?env=prod": runs,
    "GET /deployments/runs/run3": { ...runs[0], output: { url: "https://web.example.com" } },
    "POST /deployments/runs/run1/rollback": {
      runId: "run4",
      result: {
        status: "success",
        env: "prod",
        image: "acme/web:111",
        notes: ["deleted server web-9", "could not delete volume data: in use", "kept dns"],
        createdResources: [],
        plannedChanges: [],
        logs: [],
        durationMs: 1000,
      },
    },
  };

  it("lists the org's deploys, and this machine's", async () => {
    serveRoutes(out, routes);
    expect(await cli("deploy", "log")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "WHEN              ENV   COMMIT   IMAGE         STATUS   TOOK  FROM
      2026-11-03 10:00  prod  run3caf  acme/web:333  success   45s  cli 
      2026-11-02 10:00  prod  run2caf  —             failure     —  cli 
      2026-11-01 10:00  prod  run1caf  acme/web:111  success   45s  web 
      "
    `);
    serveRoutes(out, routes);
    expect(await cli("deploy", "log", "-e", "prod", "--json")).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual(runs);
    const local = [
      localRun(),
      localRun({ id: "run-2", dirty: true, status: "failure", durationMs: null }),
    ];
    for (const entry of local) recordLocalDeploy(entry);
    expect(await cli("deploy", "log", "--local")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "WHEN              ENV   COMMIT    IMAGE             STATUS   TOOK  WHERE   
      2026-11-01 09:30  prod  abc1234*  acme/web:abc1234  failure     —  /src/web
      2026-11-01 09:30  prod  abc1234   acme/web:abc1234  success   61s  /src/web

      * built from a working tree with uncommitted changes
      "
    `);
    expect(await cli("deploy", "log", "--local", "-e", "staging")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "No local deploys yet. Run \`infrawrench deploy\` in a project directory.
      "
    `);
  });

  it("prints the last successful deploy's outputs", async () => {
    serveRoutes(out, routes);
    expect(await cli("deploy", "outputs")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "{
        "url": "https://web.example.com"
      }
      "
    `);
    serveRoutes(out, { ...routes, "GET /deployments/runs/run3": runs[0] });
    expect(await cli("deploy", "outputs", "--json")).toBe(0);
    expect(out.stdout).toBe("null\n");
    recordLocalDeploy(localRun());
    expect(await cli("deploy", "outputs", "--local")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "{
        "url": "https://old.example.com"
      }
      "
    `);
    expect(await cli("deploy", "outputs", "--local", "-e", "staging")).toBe(1);
    expect(out.stderr).toMatchInlineSnapshot(`
      "No successful deploy found.
      "
    `);
  });

  it("rolls back to the deploy before the live one", async () => {
    serveRoutes(out, routes);
    expect(await cli("deploy", "rollback", "--delete-created")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "rolling back to acme/web:111 (run1)
      ✓ rolled back to acme/web:111 on prod
      ✓ deleted server web-9
      ! could not delete volume data: in use
      "
    `);
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls.at(-1)?.[1]?.body))).toEqual({
      deleteCreated: true,
    });
    serveRoutes(out, routes);
    expect(await cli("deploy", "rollback", "--to-run", "run1", "--json")).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual(routes["POST /deployments/runs/run1/rollback"].result);
    serveRoutes(out, {
      ...routes,
      "POST /deployments/runs/run1/rollback": {
        runId: "run4",
        result: { status: "failure", env: "prod", error: { message: "image gone" } },
      },
    });
    expect(await cli("deploy", "rollback", "--to-run", "run1")).toBe(1);
    expect(out.stderr).toMatchInlineSnapshot(`
      "image gone
      "
    `);
    serveRoutes(out, { ...routes, "GET /deployments/runs": [runs[0]] });
    expect(await cli("deploy", "rollback")).toBe(2);
    expect(out.stderr).toMatchInlineSnapshot(`
      "No earlier successful deploy to roll back to. Pass --to-run <runId> to choose one.
      "
    `);
  });
});

describe("deploy typings", () => {
  it("prints the declarations for the Infrafile's envs", async () => {
    serveRoutes(out, { "GET /accounts": [] });
    expect(await cli("deploy", "typings", "--local")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "// plugins: hetzner
      type InfraEnv = "prod";
      "
    `);
  });
});
