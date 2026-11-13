import { describe, expect, it, vi } from "vitest";

// These modules import the database client and plugin code at load; the
// functions tested here touch neither.
vi.mock("../../db/client.js", () => ({ db: {} }));

const { accessFrom } = await import("../concurrency");
const { accessOf, cloudOf, namesSomethingLent } = await import("../runs");
const {
  AliasRegistry,
  buildLent,
  checked,
  fitLent,
  MAX_RUN_BODY_BYTES,
  mergeMaterials,
  needsLending,
  referencedNames,
  scopeRefusal,
  valueProblem,
} = await import("../lend");
const { claimBackoffMs, jobSegment, matchConnections, MAX_CLAIM_ATTEMPTS, orgTag } =
  await import("../cloud-jobs");
const { cleanPattern, cleanRepos } = await import("../access");

describe("what jobs name, from the runners' answer", () => {
  const answer = {
    pipelines: [
      {
        file: ".infrawrench/ci/deploy.yml",
        jobs: [
          {
            key: "deploy",
            connections: [{ name: "Production cluster" }, { name: "staging", namespace: "web" }],
            "ssh-keys": ["deploy"],
            resources: { "prod-db": ["connectionString"] },
            "env-from": ["r2-assets"],
          },
          { key: "image", cloud: { provider: "aws", kind: "vm", machine: "t3.large" } },
          { key: 7 },
        ],
      },
      { file: "old.yml" },
    ],
  };

  it("reads each job's references and cloud block, leniently", () => {
    expect(accessFrom(answer)).toEqual([
      {
        pipeline: ".infrawrench/ci/deploy.yml",
        job: "deploy",
        connections: [{ name: "Production cluster" }, { name: "staging", namespace: "web" }],
        sshKeys: ["deploy"],
        resources: { "prod-db": ["connectionString"] },
        envFrom: ["r2-assets"],
      },
      {
        pipeline: ".infrawrench/ci/deploy.yml",
        job: "image",
        cloud: { provider: "aws", kind: "vm", machine: "t3.large" },
      },
    ]);
    expect(accessFrom({})).toEqual([]);
  });

  it("merges names across jobs, keeping every namespace a name is used in", () => {
    const access = accessFrom(answer);
    const names = referencedNames([
      ...access,
      {
        pipeline: "x",
        job: "y",
        connections: [{ name: "staging", namespace: "api" }],
        resources: { "prod-db": ["password"] },
      },
    ]);
    expect([...names.connections].map(([n, ns]) => [n, [...ns]])).toEqual([
      ["Production cluster", [undefined]],
      ["staging", ["web", "api"]],
    ]);
    expect([...(names.resources.get("prod-db") ?? [])]).toEqual(["connectionString", "password"]);
    expect(needsLending(access)).toBe(true);
    expect(namesSomethingLent(access)).toBe(true);
    // A cloud block alone lends nothing.
    expect(needsLending([access[1]!])).toBe(false);
    expect(namesSomethingLent([access[1]!])).toBe(false);
    expect(namesSomethingLent(null)).toBe(false);
  });
});

describe("lending", () => {
  const run = {
    id: "run-1",
    organizationId: "org-1",
    repoFullName: "acme/web",
    event: "push" as const,
    headRef: "feature/x",
    fromFork: false,
  };

  it("lends nothing to a fork's run, or to a run that names nothing", async () => {
    const access = [{ pipeline: "p", job: "j", sshKeys: ["deploy"] }];
    expect(await buildLent({ ...run, fromFork: true }, access)).toBeNull();
    expect(await buildLent(run, [{ pipeline: "p", job: "j" }])).toBeNull();
    expect(await buildLent(run, null)).toBeNull();
  });

  it("refuses a repository or branch outside a permission, naming both", () => {
    expect(scopeRefusal("x", run, { repos: null, branchPattern: null })).toBeNull();
    expect(scopeRefusal("x", run, { repos: ["acme/web"], branchPattern: "feature/*" })).toBeNull();
    expect(scopeRefusal("connection `prod`", run, { repos: null, branchPattern: "main" })).toBe(
      "connection `prod` is not lent to CI for acme/web on feature/x",
    );
    expect(scopeRefusal("x", run, { repos: ["acme/api"], branchPattern: null })).not.toBeNull();
  });

  it("joins a connection's and its jump host's files at one path, keeping parts", () => {
    const entry = mergeMaterials([
      {
        env: {},
        files: [
          { path: "/root/.ssh/iw_bastion", content: "KEY1\n" },
          { path: "/root/.ssh/config", content: [{ text: "Host bastion\n" }] },
        ],
        summary: "",
      },
      {
        env: { X: [{ text: "1" }] },
        files: [{ path: "/root/.ssh/config", mode: "600", content: [{ text: "Host web\n" }] }],
        summary: "",
      },
    ]);
    expect(entry).toEqual({
      env: { X: [{ text: "1" }] },
      files: [
        { path: "/root/.ssh/iw_bastion", content: "KEY1\n" },
        {
          path: "/root/.ssh/config",
          content: [{ text: "Host bastion\n" }, { text: "\n" }, { text: "Host web\n" }],
        },
      ],
    });
  });

  it("refuses a file too large for the runner", () => {
    const big = "x".repeat(64 * 1024 + 1);
    expect(
      checked(
        "conn",
        mergeMaterials([{ env: {}, files: [{ path: "/a", content: big }], summary: "" }]),
      ),
    ).toEqual({ refused: "/a of conn is larger than 64 KiB" });
  });
});

describe("what the runner accepts in `lent`", () => {
  it("measures values in UTF-8 bytes and refuses NUL", () => {
    expect(valueProblem("x".repeat(64 * 1024))).toBeNull();
    // 32 Ki characters of two bytes each is 64 KiB; one more is over.
    expect(valueProblem("é".repeat(32 * 1024))).toBeNull();
    expect(valueProblem("é".repeat(32 * 1024 + 1))).toBe("is larger than 64 KiB");
    expect(valueProblem([{ text: "a" }, { secret: "b\u0000c" }])).toBe("holds a NUL character");
  });

  it("refuses an entry with more than 16 files, or a bad value, by name", () => {
    const files = Array.from({ length: 17 }, (_, i) => ({ path: `/root/f${i}`, content: "x" }));
    expect(checked("conn", { files })).toEqual({ refused: "conn would write more than 16 files" });
    expect(checked("conn", { files: files.slice(0, 16) })).toEqual({ files: files.slice(0, 16) });
    expect(checked("conn", { env: { TOKEN: "a\u0000" } })).toEqual({
      refused: "TOKEN of conn holds a NUL character",
    });
  });

  it("keeps the request within 1 MiB, refusing the largest names first", () => {
    const big = "x".repeat(60 * 1024);
    const lent = {
      connections: Object.fromEntries(
        Array.from({ length: 20 }, (_, i) => [`c${i}`, { files: [{ path: "/a", content: big }] }]),
      ),
      "ssh-keys": { small: { files: [{ path: "/b", content: "y" }] } },
    };
    const fitted = fitLent(lent, 1000);
    expect(Buffer.byteLength(JSON.stringify(fitted)) + 1000).toBeLessThanOrEqual(
      MAX_RUN_BODY_BYTES,
    );
    const refused = Object.values(fitted.connections ?? {}).filter((e) => "refused" in e);
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.length).toBeLessThan(20);
    expect(fitted["ssh-keys"]?.["small"]).toEqual({ files: [{ path: "/b", content: "y" }] });
    expect(JSON.stringify(refused[0])).toContain("too large to send with the run");
  });
});

describe("aliases", () => {
  it("never gives two names in a run the same file name", () => {
    const aliases = new AliasRegistry(["deploy", "Deploy", "a_b", "a-b"]);
    const all = ["deploy", "Deploy", "a_b", "a-b"].map((n) => aliases.aliasFor(n));
    expect(new Set(all).size).toBe(4);
    // Sorted, so the same run always gets the same aliases.
    expect(aliases.aliasFor("Deploy")).toBe("deploy");
    expect(aliases.aliasFor("deploy")).toBe("deploy-2");
    expect(aliases.aliasFor("a-b")).toBe("a-b");
    expect(aliases.aliasFor("a_b")).toBe("a-b-2");
  });
});

describe("claiming", () => {
  it("backs off, and gives up after a bounded number of tries", () => {
    expect(claimBackoffMs(1)).toBe(15_000);
    expect(claimBackoffMs(3)).toBe(60_000);
    expect(claimBackoffMs(20)).toBe(5 * 60_000);
    expect(MAX_CLAIM_ATTEMPTS).toBeGreaterThan(1);
  });
});

describe("matching a cloud job to a connection", () => {
  const run = { repoFullName: "acme/web", headRef: "main" };
  const row = {
    accountId: "a1",
    displayName: "Production",
    pluginId: "aws",
    jobsEnabled: true,
    jobKinds: ["vm"],
    jobRepos: null,
    jobBranchPattern: null,
    maxConcurrentJobs: 2,
    maxJobMinutes: 60,
  };
  const spec = { cloud: { provider: "aws", kind: "vm" }, timeout_secs: 1800 };

  it("finds an opted-in connection", () => {
    expect(matchConnections(run, spec, [row])).toEqual([
      { accountId: "a1", displayName: "Production", maxConcurrentJobs: 2, maxJobMinutes: 60 },
    ]);
  });

  it("names what to opt in when nothing matches", () => {
    expect(
      matchConnections(run, { ...spec, cloud: { provider: "gcp", kind: "build" } }, [row]),
    ).toEqual({
      refuse: "No `gcp` connection is opted in to cloud jobs. Turn one on in CI, CI access.",
    });
    expect(matchConnections(run, spec, [{ ...row, jobKinds: [] }])).toEqual({
      refuse: "No `aws` connection is opted in to `vm` cloud jobs. Turn it on in CI, CI access.",
    });
    expect(
      matchConnections(run, { ...spec, cloud: { ...spec.cloud, connection: "Staging" } }, [row]),
    ).toEqual({
      refuse:
        "No `aws` connection called `Staging` is opted in to cloud jobs. Turn one on in CI, CI access.",
    });
    expect(matchConnections(run, spec, [{ ...row, jobBranchPattern: "release/*" }])).toEqual({
      refuse: "No `aws` connection runs cloud jobs for acme/web on main.",
    });
    const tooLong = matchConnections(run, { ...spec, timeout_secs: 7200 }, [row]);
    expect("refuse" in tooLong && tooLong.refuse).toContain("120 minutes");
  });
});

describe("helpers", () => {
  it("encodes a job id as one path segment", () => {
    expect(jobSegment("build[app/web]")).toBe("build%5Bapp%2Fweb%5D");
    expect(jobSegment("a(b)*")).toBe("a%28b%29%2A");
  });

  it("tags compute with the organization", () => {
    expect(orgTag("org-1")).toBe("org-org-1");
  });

  it("reads a job report's lent names and cloud block", () => {
    expect(
      accessOf({
        connections: ["prod"],
        "ssh-keys": [],
        resources: { db: ["url"] },
        "env-from": ["r2"],
      }),
    ).toEqual({ access: { connections: ["prod"], resources: ["db"], envFrom: ["r2"] } });
    expect(accessOf(undefined)).toEqual({});
    expect(
      cloudOf({ provider: "aws", kind: "vm", executor: "aws ec2 i-1", claimed_ms: 5 }),
    ).toEqual({
      cloud: { provider: "aws", kind: "vm", executor: "aws ec2 i-1" },
    });
    expect(cloudOf({ kind: "vm" })).toEqual({});
  });

  it("checks repositories and branch patterns as sent", () => {
    expect(cleanRepos(null)).toBeNull();
    expect(cleanRepos([" acme/web ", "acme/web"])).toEqual(["acme/web"]);
    expect(() => cleanRepos(["web"])).toThrow("owner/name");
    expect(cleanPattern("  ")).toBeNull();
    expect(() => cleanPattern("a\nb")).toThrow("one line");
    // Commas alone are not "every branch".
    expect(() => cleanPattern(",")).toThrow("at least one branch");
    expect(() => cleanPattern(" , ")).toThrow("at least one branch");
    expect(cleanPattern("main, release/*")).toBe("main, release/*");
  });
});
