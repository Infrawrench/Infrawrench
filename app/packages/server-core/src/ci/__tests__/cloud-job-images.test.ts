/**
 * A cloud job's scripts run for real, in containers of the images people
 * start cloud jobs on, against a fake callback, a fake Kubernetes API server
 * and real `sshd`s on the loopback. It proves, per image, what
 * `ci-runner/README.md` ("Cloud jobs") says a cloud job gets: the commit, a
 * lent SSH key, a lent SSH host (one of them through a jump host, with host
 * keys checked against the pinned fingerprints), a lent kubeconfig, the
 * `ssh` and `kubectl` those need, and that what comes back is still what the
 * runner masks.
 *
 * What is lent is made by the plugins themselves (`lendCiCredential` of the
 * `ssh` and `kubernetes` plugins) and by `sshKeyEntry`, merged by path as
 * the runner merges it, so a change to any of them is tested here too.
 *
 * Off unless `IWCI_E2E_IMAGES` is set, because it needs things a unit test
 * run does not have:
 *
 * - Docker on Linux, with containers on the host's network (`docker run
 *   --network host`): the fixtures listen on 127.0.0.1.
 * - `sshd`, `ssh-keygen` and `openssl` on the host, and the internet (images,
 *   packages, kubectl's download).
 *
 *     IWCI_E2E_IMAGES=1 pnpm --filter @infrawrench/server-core exec vitest run src/ci/__tests__/cloud-job-images.test.ts
 *
 * `IWCI_E2E_IMAGES` may also be a comma-separated list of case names to run
 * only those; `IWCI_E2E_DOCKER` names the `docker` to use.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createTlsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import {
  ciBootstrapWithTools,
  ciContainerCommand,
  type CiLentMaterial,
  type CiToolDeclaration,
} from "@infrawrench/plugin-base";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootstrapScript, jobScript, parseFinishBody } from "../bootstrap";
import { mergeMaterials, sshKeyEntry, type LentEntry, type LentValue } from "../lend";
import { toolsOfJob } from "../tools";

const wanted = process.env["IWCI_E2E_IMAGES"] ?? "";
const DOCKER = process.env["IWCI_E2E_DOCKER"] ?? "docker";
const TOKEN = "b".repeat(64);
const KUBE_TOKEN = "kube-token-0123456789abcdef-never-in-a-log";

interface Case {
  name: string;
  image: string;
  /** Extra `docker run` arguments: a user, a read-only root. */
  args?: string[];
  /** The bootstrap gives up, telling the callback why. */
  refused?: RegExp;
  /** `ssh` cannot work there at all (a user with no passwd entry). */
  noSsh?: boolean;
  /** Its OpenSSH is older than 8.5: a lent key works, a lent host is refused. */
  oldSsh?: boolean;
  /** The job gets a root of its own, so the clone is not in `/app`. */
  ownRoot?: boolean;
}

const CASES: Case[] = [
  // The default of every container kind.
  { name: "buildpack-deps", image: "buildpack-deps:noble-curl" },
  // Bare distribution images: no curl, no ssh, a package manager.
  { name: "ubuntu", image: "ubuntu:24.04" },
  { name: "debian-slim", image: "debian:12-slim" },
  { name: "alpine", image: "alpine:3.22" },
  // curl-minimal and coreutils-single, which conflict with curl and coreutils.
  { name: "ubi-minimal", image: "redhat/ubi9-minimal" },
  // The defaults of the managed build kinds that are public images.
  // Cloud Build's own image is Ubuntu 20.04, whose OpenSSH is 8.2.
  { name: "cloud-builders-docker", image: "gcr.io/cloud-builders/docker", oldSsh: true },
  { name: "docker-cli", image: "docker:cli" },
  // A user other than root, who cannot write /root or /app or install anything.
  {
    name: "non-root",
    image: "buildpack-deps:noble-scm",
    args: ["--user", "1000:1000"],
    ownRoot: true,
  },
  // A user with no passwd entry: OpenSSH refuses to run for it at all.
  {
    name: "arbitrary-uid",
    image: "buildpack-deps:noble-scm",
    args: ["--user", "12345:12345"],
    ownRoot: true,
    noSsh: true,
  },
  // Root on a read-only file system: nothing can be written but /tmp.
  {
    name: "read-only-root",
    image: "buildpack-deps:noble-scm",
    args: ["--read-only", "--tmpfs", "/tmp:exec,mode=1777"],
    ownRoot: true,
  },
  // No bash, no curl and no package manager: it says so, through wget.
  { name: "busybox", image: "busybox:1.37", refused: /This machine has no bash curl/ },
];

const selected =
  wanted === ""
    ? []
    : wanted === "1"
      ? CASES
      : CASES.filter((c) => wanted.split(",").includes(c.name));

/** Whether a value is secret as a whole, or which of its parts are. */
function secretsOf(value: LentValue): string[] {
  return typeof value === "string"
    ? [value]
    : value.flatMap((p) => ("secret" in p ? [p.secret] : []));
}

function plain(value: LentValue): string {
  return typeof value === "string"
    ? value
    : value.map((p) => ("text" in p ? p.text : p.secret)).join("");
}

/** As the runner's `Masker`: each secret whole, and each of its lines, longest first. */
function masker(secrets: string[]): (text: string) => string {
  const values = [
    ...new Set(
      secrets
        .flatMap((s) => [s, ...s.split("\n").map((l) => l.trim())])
        .filter((v) => v.length >= 3),
    ),
  ].sort((a, b) => b.length - a.length);
  return (text) => values.reduce((out, value) => out.split(value).join("***"), text);
}

/** Lent entries as one job gets them: files with one path joined, the stricter mode kept. */
function merged(entries: LentEntry[]): {
  env: Record<string, string>;
  files: Array<{ path: string; mode: string; content: string }>;
  secrets: string[];
} {
  const env: Record<string, string> = {};
  const files = new Map<string, { path: string; mode: string; content: string }>();
  const secrets: string[] = [];
  for (const entry of entries) {
    if ("refused" in entry) throw new Error(entry.refused);
    for (const [key, value] of Object.entries(entry.env ?? {})) {
      env[key] = plain(value);
      secrets.push(...secretsOf(value));
    }
    for (const file of entry.files ?? []) {
      secrets.push(...secretsOf(file.content));
      const prior = files.get(file.path);
      const mode = file.mode ?? "600";
      files.set(file.path, {
        path: file.path,
        mode: prior ? (Number(prior.mode) <= Number(mode) ? prior.mode : mode) : mode,
        content: prior
          ? `${prior.content.replace(/\n?$/, "\n")}${plain(file.content)}`
          : plain(file.content),
      });
    }
  }
  return { env, files: [...files.values()], secrets };
}

interface Sshd {
  port: number;
  fingerprint: string;
  log: () => string;
  stop: () => void;
}

describe.skipIf(selected.length === 0)("a cloud job on an image", () => {
  let dir: string;
  let callback: Server;
  let api: ReturnType<typeof createTlsServer>;
  let port = 0;
  const sshds: Sshd[] = [];
  const user = userInfo().username;
  /** Per job token: the script it is served, and what it sent back. */
  const jobs = new Map<
    string,
    {
      script: string;
      logs: Array<{ stream: string; text: string }>;
      artifact: Buffer | null;
      finish: (value: { query: URLSearchParams; body: string }) => void;
    }
  >();
  let lent: ReturnType<typeof merged>;
  let tools: CiToolDeclaration[];
  let apiSaw: string[] = [];
  let keyOnlyPort = 0;

  /** An `sshd` of its own on the loopback, which lets `key` in and answers with `says`. */
  async function sshd(
    name: string,
    key: string,
    options: { forwards?: boolean } = {},
  ): Promise<Sshd> {
    const home = join(dir, `sshd-${name}`);
    execFileSync("mkdir", ["-p", home]);
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(home, "host")]);
    writeFileSync(join(home, "authorized_keys"), `${key}\n`, { mode: 0o600 });
    const free = createServer();
    await new Promise<void>((resolve) => free.listen(0, "127.0.0.1", resolve));
    const sshPort = (free.address() as AddressInfo).port;
    await new Promise((resolve) => free.close(resolve));
    writeFileSync(
      join(home, "sshd_config"),
      [
        `Port ${sshPort}`,
        "ListenAddress 127.0.0.1",
        `HostKey ${join(home, "host")}`,
        "PidFile none",
        `AuthorizedKeysFile ${join(home, "authorized_keys")}`,
        "StrictModes no",
        // Without PAM, sshd refuses an account whose password is locked, as
        // root's usually is; a user other than root cannot use PAM.
        `UsePAM ${userInfo().uid === 0 ? "yes" : "no"}`,
        "PasswordAuthentication no",
        "KbdInteractiveAuthentication no",
        "PermitRootLogin prohibit-password",
        `AllowTcpForwarding ${options.forwards ? "yes" : "no"}`,
        `ForceCommand /bin/echo iwci-ssh-ok:${name}`,
        "LogLevel DEBUG1",
        "",
      ].join("\n"),
    );
    const bin = execFileSync("sh", ["-c", "command -v sshd || echo /usr/sbin/sshd"])
      .toString()
      .trim();
    const child: ChildProcess = spawn(bin, ["-D", "-e", "-f", join(home, "sshd_config")], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let log = "";
    child.stderr?.on("data", (chunk: Buffer) => (log += chunk.toString()));
    const fingerprint = execFileSync("ssh-keygen", [
      "-l",
      "-E",
      "sha256",
      "-f",
      join(home, "host.pub"),
    ])
      .toString()
      .split(" ")[1]!;
    return { port: sshPort, fingerprint, log: () => log, stop: () => child.kill() };
  }

  function keypair(name: string): { private: string; public: string } {
    const path = join(dir, `key-${name}`);
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", name, "-f", path]);
    return {
      private: readFileSync(path, "utf8"),
      public: readFileSync(`${path}.pub`, "utf8").trim(),
    };
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "iwci-e2e-"));

    // The commit, as GitHub's source archive: one directory at the top.
    execFileSync("mkdir", ["-p", join(dir, "src", "acme-web-abc1234", "sub")]);
    writeFileSync(join(dir, "src", "acme-web-abc1234", "hello.txt"), "from the commit\n");
    writeFileSync(join(dir, "src", "acme-web-abc1234", "sub", "deep.txt"), "deep\n");
    execFileSync("tar", ["-czf", join(dir, "src.tgz"), "-C", join(dir, "src"), "acme-web-abc1234"]);

    // Three hosts: one lent directly, one reached only through the third, and
    // one a job reaches with a lent SSH key of its own.
    const keys = {
      web: keypair("web-1"),
      db: keypair("db-1"),
      bastion: keypair("bastion"),
      deploy: keypair("deploy"),
    };
    const web = await sshd("web-1", keys.web.public);
    const db = await sshd("db-1", keys.db.public);
    const bastion = await sshd("bastion", keys.bastion.public, { forwards: true });
    const keyOnly = await sshd("key", keys.deploy.public);
    sshds.push(web, db, bastion, keyOnly);
    keyOnlyPort = keyOnly.port;

    // The cluster: TLS with a certificate of its own, and one bearer token.
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
      "-days", "2", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
      "-addext", "basicConstraints=critical,CA:TRUE",
      "-keyout", join(dir, "api.key"), "-out", join(dir, "api.crt"),
    ], { stdio: "ignore" }); // prettier-ignore
    const namespace = (name: string) => ({
      apiVersion: "v1",
      kind: "Namespace",
      metadata: { name, uid: `uid-${name}`, resourceVersion: "1" },
      status: { phase: "Active" },
    });
    api = createTlsServer(
      { key: readFileSync(join(dir, "api.key")), cert: readFileSync(join(dir, "api.crt")) },
      (req, res) => {
        const path = new URL(req.url ?? "/", "https://x").pathname;
        const send = (status: number, body: unknown) => {
          res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
        };
        if (req.headers.authorization !== `Bearer ${KUBE_TOKEN}`) {
          send(401, {
            kind: "Status",
            apiVersion: "v1",
            status: "Failure",
            reason: "Unauthorized",
            code: 401,
          });
          return;
        }
        apiSaw.push(`${req.method} ${path}`);
        if (path === "/version")
          send(200, { major: "1", minor: "37", gitVersion: "v1.37.2-fixture" });
        else if (path === "/api")
          send(200, { kind: "APIVersions", versions: ["v1"], serverAddressByClientCIDRs: [] });
        else if (path === "/apis")
          send(200, { kind: "APIGroupList", apiVersion: "v1", groups: [] });
        else if (path === "/api/v1")
          send(200, {
            kind: "APIResourceList",
            groupVersion: "v1",
            resources: [
              {
                name: "namespaces",
                singularName: "namespace",
                namespaced: false,
                kind: "Namespace",
                verbs: ["get", "list"],
                shortNames: ["ns"],
              },
            ],
          });
        else if (path === "/api/v1/namespaces")
          send(200, {
            kind: "NamespaceList",
            apiVersion: "v1",
            metadata: { resourceVersion: "1" },
            items: [namespace("default"), namespace("iwci-fixture")],
          });
        else
          send(404, {
            kind: "Status",
            apiVersion: "v1",
            status: "Failure",
            reason: "NotFound",
            code: 404,
          });
      },
    );
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    const apiPort = (api.address() as AddressInfo).port;

    // What the job is lent, made by the plugins that lend it.
    const { getPlugin } = await import("../../plugin-loader");
    const sshPlugin = (await getPlugin("ssh"))!.plugin;
    const pinned = async (_host: string, p: number) =>
      [web, db, bastion].find((s) => s.port === p)?.fingerprint ?? null;
    const lendSsh = async (
      name: string,
      at: Sshd,
      key: string,
      references: Record<string, string> = {},
    ): Promise<CiLentMaterial> => {
      const client = sshPlugin.createClient({
        host: "127.0.0.1",
        port: String(at.port),
        username: user,
        privateKey: key,
        ...(references["connectThroughAccountId"]
          ? { connectThroughAccountId: "account-bastion" }
          : {}),
      });
      return client.lendCiCredential!({
        name,
        alias: name,
        ttlSeconds: 3600,
        references,
        pinnedHostKey: pinned,
      });
    };
    const kubernetes = (await getPlugin("kubernetes"))!.plugin;
    const cluster = await kubernetes.createClient({
      kubeconfig: [
        "apiVersion: v1",
        "kind: Config",
        "current-context: prod",
        "clusters:",
        "- name: prod",
        "  cluster:",
        `    server: https://127.0.0.1:${apiPort}`,
        `    certificate-authority-data: ${readFileSync(join(dir, "api.crt")).toString("base64")}`,
        "users:",
        "- name: ci",
        `  user: { token: ${KUBE_TOKEN} }`,
        "contexts:",
        "- name: prod",
        "  context: { cluster: prod, user: ci }",
        "",
      ].join("\n"),
    }).lendCiCredential!({
      name: "Production cluster",
      alias: "production-cluster",
      ttlSeconds: 3600,
      references: {},
      pinnedHostKey: async () => null,
    });
    const bastionLent = await lendSsh("bastion", bastion, keys.bastion.private);
    lent = merged([
      mergeMaterials([cluster]),
      mergeMaterials([await lendSsh("web-1", web, keys.web.private)]),
      // A host behind a jump host is lent with it, as `lendAccount` does.
      mergeMaterials([
        bastionLent,
        await lendSsh("db-1", db, keys.db.private, { connectThroughAccountId: "bastion" }),
      ]),
      sshKeyEntry("deploy", keys.deploy.private),
    ]);
    // And the tools those need, from the same plugins' manifests.
    tools = toolsOfJob(
      [
        {
          pipeline: "ci.yml",
          job: "deploy",
          connections: [{ name: "Production cluster" }, { name: "web-1" }, { name: "db-1" }],
          sshKeys: ["deploy"],
        },
      ],
      (name) => (name === "Production cluster" ? ["kubernetes"] : ["ssh"]),
      (pluginId) =>
        (pluginId === "kubernetes" ? kubernetes : sshPlugin).manifest.ciCredential?.tools ?? [],
    );
    expect(tools.map((t) => t.command).sort()).toEqual(["kubectl", "ssh"]);

    callback = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        if (url.pathname === "/src.tgz") {
          // The archive link is fetched without the job's token.
          if (req.headers["x-infrawrench-ci-job"]) return void res.writeHead(403).end();
          return void res.end(readFileSync(join(dir, "src.tgz")));
        }
        const proxied = /^\/proxy\/artifacts\/([0-9a-f]{64})$/.exec(url.pathname);
        if (proxied) {
          const job = jobs.get(proxied[1]!);
          if (job) job.artifact = body;
          return void res.end("{}");
        }
        const job = jobs.get(String(req.headers["x-infrawrench-ci-job"] ?? ""));
        if (!job) return void res.writeHead(404).end();
        if (url.pathname === "/cb/script") res.end(job.script);
        else if (url.pathname === "/cb/source")
          res.writeHead(302, { Location: `http://127.0.0.1:${port}/src.tgz` }).end();
        else if (url.pathname === "/cb/log") {
          job.logs.push({
            stream: url.searchParams.get("stream") ?? "",
            text: body.toString("utf8"),
          });
          res.writeHead(204).end();
        } else if (url.pathname === "/cb/finish") {
          res.writeHead(204).end();
          job.finish({ query: url.searchParams, body: body.toString("utf8") });
        } else res.writeHead(404).end();
      });
    });
    await new Promise<void>((resolve) => callback.listen(0, "127.0.0.1", resolve));
    port = (callback.address() as AddressInfo).port;
  }, 120_000);

  afterAll(() => {
    for (const s of sshds) s.stop();
    callback?.close();
    api?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it.each(selected)(
    "$name",
    async (testCase) => {
      const token = TOKEN.slice(0, 56) + String(CASES.indexOf(testCase)).padStart(8, "0");
      const cb = `http://127.0.0.1:${port}/cb`;
      const run = [
        'echo "repo=$(cat hello.txt) $(cat sub/deep.txt)"',
        'echo "who=$(id -u) home=$HOME pwd=$PWD kube=$KUBECONFIG"',
        'echo "modes=$(stat -c %a "$HOME/.ssh" "$HOME/.ssh/id_deploy" "$KUBECONFIG" | tr "\\n" " ")"',
        "kubectl version --client",
        "kubectl get namespaces -o name",
        ...(testCase.noSsh
          ? ['ssh -o BatchMode=yes web-1 true 2>&1 || echo "ssh-said=$?"']
          : [
              ...(testCase.oldSsh
                ? ['ssh -o BatchMode=yes web-1 true 2>&1 || echo "old-ssh-refused=$?"']
                : ["ssh -o BatchMode=yes web-1 true", "ssh -o BatchMode=yes db-1 true"]),
              `ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -p ${keyOnlyPort} ${user}@127.0.0.1 true`,
              // A host key other than the pinned one is refused.
              `if ssh -o BatchMode=yes -o HostKeyAlias=web-1 -p ${keyOnlyPort} web-1 true 2>/dev/null; then echo wrong-host-accepted; else echo wrong-host-refused; fi`,
            ]),
        // What a careless job prints: the runner must be able to mask it.
        'cat "$KUBECONFIG"',
        'cat "$HOME/.ssh/id_deploy" "$HOME/.ssh/iw_web-1"',
        'echo "digest=42" >> "$IWCI_OUTPUT"',
        "mkdir -p out && echo built > out/a.txt",
      ].join("\n");
      const done = new Promise<{ query: URLSearchParams; body: string }>((resolve) => {
        jobs.set(token, {
          script: jobScript({
            callbackUrl: cb,
            token,
            proxyUrl: `http://127.0.0.1:${port}/proxy`,
            name: "deploy",
            script: run,
            cwd: "/app",
            cloneInto: "/app",
            timeoutSecs: 240,
            changes: "ignore",
            // As the runner sends it: its own variables, then what is lent.
            env: { CI: "true", HOME: "/root", ...lent.env },
            files: lent.files,
            inputsUrl: null,
            artifacts: { url: `/artifacts/${token}`, paths: ["/app/out"] },
            tools,
          }),
          logs: [],
          artifact: null,
          finish: resolve,
        });
      });
      apiSaw = [];
      // As a container kind starts it: the plugin's wrapper, under its watchdog.
      const command = ciContainerCommand(ciBootstrapWithTools(bootstrapScript(cb, token)), 300);
      const name = `iwci-e2e-${process.pid}-${testCase.name}`;
      const child = spawn(
        DOCKER,
        ["run", "--rm", "--network", "host", "--name", name, "--memory", "2g", "--cpus", "2",
          ...(testCase.args ?? []), "--entrypoint", command[0]!, testCase.image, ...command.slice(1)],
        { stdio: "ignore" },
      ); // prettier-ignore
      try {
        const result = await done;
        const job = jobs.get(token)!;
        const of = (stream: string) =>
          job.logs.filter((l) => l.stream === stream).map((l) => l.text).join(""); // prettier-ignore
        const out = of("stdout");
        const err = of("stderr");
        const tail = (text: string) => text.split("\n").slice(-12).join("\n");
        const context = `\n--- stdout ---\n${masker(lent.secrets)(out)}\n--- stderr ---\n${masker(lent.secrets)(err)}\n--- sshd ---\n${sshds.map((s) => tail(s.log())).join("\n")}`;

        if (testCase.refused) {
          expect(result.query.get("status"), context).toBe("error");
          expect(err).toMatch(testCase.refused);
          return;
        }
        expect(result.query.get("status"), context).toBe("passed");
        expect(parseFinishBody(result.body).output).toBe("digest=42\n");

        // The repository, with its top-level directory gone.
        expect(out).toContain("repo=from the commit deep");
        const where = /who=(\d+) home=(\S+) pwd=(\S+) kube=(\S+)/.exec(out);
        expect(where, context).not.toBeNull();
        const [, , home, pwd, kube] = where!;
        expect(pwd === "/app").toBe(!testCase.ownRoot);
        expect(pwd!.endsWith("/app")).toBe(true);
        // Lent files where the job's home is, held to their modes.
        expect(kube).toBe(`${home}/.kube/production-cluster.yaml`);
        expect(out).toContain("modes=700 600 600");

        // kubectl, with the lent kubeconfig, reached the cluster as the token.
        expect(out).toMatch(/Client Version: v\d+\.\d+/);
        expect(out).toContain("namespace/iwci-fixture");
        expect(apiSaw).toContain("GET /api/v1/namespaces");

        if (testCase.noSsh) {
          expect(out).toMatch(/No user exists for uid 12345|ssh-said=/);
        } else {
          if (testCase.oldSsh) {
            // It cannot check the pinned key, so it refuses the host, and
            // only that: the file still reads, and the lent key still works.
            expect(out).toContain("Host key verification failed");
            expect(out).toContain("old-ssh-refused=255");
            expect(out).not.toContain("iwci-ssh-ok:web-1");
          } else {
            expect(out).toContain("iwci-ssh-ok:web-1");
            // Through the jump host: the bastion forwarded to db-1's port.
            expect(out).toContain("iwci-ssh-ok:db-1");
            expect(sshds[2]!.log()).toContain(`port ${sshds[1]!.port}`);
          }
          // The lent key, offered to a host no connection names.
          expect(out).toContain("iwci-ssh-ok:key");
          expect(out).toContain("wrong-host-refused");
        }

        // The job printed its kubeconfig and two private keys. The bytes
        // that came back are the bytes that were lent, so the runner's
        // masker, which knows only those, leaves none of them.
        expect(out).toContain(KUBE_TOKEN);
        const masked = masker(lent.secrets)(out + err);
        expect(masked).not.toContain(KUBE_TOKEN);
        for (const secret of lent.secrets) {
          for (const line of secret.split("\n").filter((l) => l.trim().length >= 3)) {
            expect(masked).not.toContain(line.trim());
          }
        }
        expect(masked).toContain("apiVersion: v1");
        expect(masked).toContain("***");

        // Its artifact, relative to the root it ran in.
        expect(job.artifact).not.toBeNull();
        expect(execFileSync("tar", ["-tf", "-"], { input: job.artifact! }).toString()).toContain(
          "app/out/a.txt",
        );
      } finally {
        child.kill();
        try {
          execFileSync(DOCKER, ["rm", "-f", name], { stdio: "ignore" });
        } catch {
          // Already gone with `--rm`.
        }
      }
    },
    420_000,
  );
});
