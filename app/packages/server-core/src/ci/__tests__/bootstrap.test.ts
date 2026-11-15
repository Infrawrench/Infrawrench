import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootstrapScript, jobScript, parseFinishBody, shq } from "../bootstrap";

/**
 * The scripts run for real here, with the machine's own `sh`, `bash`, `curl`
 * and `tar`. Where Node itself is WebAssembly (Infrawrench CI's runner)
 * there are no such programs to run, so those cases only run on a real host.
 */
function hasTools(): boolean {
  if ((process.platform as string) === "wasi") return false;
  try {
    execFileSync("sh", ["-c", "command -v bash && command -v curl && command -v tar"], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}
const realShell = hasTools();

const TOKEN = "a".repeat(64);
const base = {
  callbackUrl: "https://app.example.test/api/ci-jobs",
  token: TOKEN,
  proxyUrl: "https://ci-proxy.example.test/",
  name: "image",
  script: "echo hi",
  cwd: "/app",
  cloneInto: "/app",
  timeoutSecs: 600,
  changes: "ignore" as const,
  env: { CI: "true" },
  files: [],
  inputsUrl: null,
  artifacts: null,
};

describe("the scripts", () => {
  it.skipIf(!realShell)("parse as shell", () => {
    const dir = mkdtempSync(join(tmpdir(), "iwci-sh-"));
    try {
      writeFileSync(join(dir, "boot.sh"), bootstrapScript(base.callbackUrl, TOKEN));
      writeFileSync(
        join(dir, "job.sh"),
        jobScript({
          ...base,
          changes: "fail",
          env: { CI: "true", "BAD KEY": "x", TOKEN: "it's $(secret)" },
          files: [{ path: "/root/.kube/a b.yaml", mode: "600", content: "x: 'y'\n" }],
          inputsUrl: "/v1/runs/r.1/jobs/image/inputs?claim=deadbeef",
          artifacts: {
            url: "/v1/runs/r.1/jobs/image/artifacts?claim=deadbeef",
            paths: ["/app/out"],
          },
        }),
      );
      execFileSync("sh", ["-n", join(dir, "boot.sh")]);
      execFileSync("bash", ["-n", join(dir, "job.sh")]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sends the token in a header, never in a URL", () => {
    const boot = bootstrapScript(base.callbackUrl, TOKEN);
    expect(boot).toContain(`-H "X-Infrawrench-Ci-Job: $IWCI_TOKEN"`);
    expect(boot).not.toMatch(/ci-jobs\/a{64}/);
    const job = jobScript(base);
    expect(job).not.toMatch(/ci-jobs\/a{64}/);
    expect(job).toContain('-H "$IWCI_H"');
  });

  it("keeps the bootstrap free of everything but the callback", () => {
    const boot = bootstrapScript(base.callbackUrl, TOKEN);
    expect(boot).toContain(base.callbackUrl);
    expect(boot).not.toContain("claim");
  });

  it("never puts a value in the job script as plain text, nor a bad env key", () => {
    const script = jobScript({ ...base, env: { TOKEN: "super-secret-value", "BAD KEY": "x" } });
    expect(script).not.toContain("super-secret-value");
    expect(script).not.toContain("BAD KEY");
  });

  it("installs only what the machine is missing, and never on a host that outlives the job", () => {
    const boot = bootstrapScript(base.callbackUrl, TOKEN);
    expect(boot).toContain("for t in bash curl tar gzip base64");
    // The whole list would fail beside curl-minimal or coreutils-single.
    expect(boot).toContain("apt-get install -y -qq --no-install-recommends $pk");
    expect(boot).not.toMatch(/install[^\n]* bash curl/);
    const host = bootstrapScript(base.callbackUrl, TOKEN, { install: false });
    expect(host).not.toMatch(/apt-get|apk add|dnf install/);
    expect(host).toContain("install them on the host");
  });

  it("says why it gives up through curl or wget, with the token in a header", () => {
    const boot = bootstrapScript(base.callbackUrl, TOKEN);
    expect(boot).toContain('_post "finish?status=error&exit=0&timed_out=0" ""');
    expect(boot).toMatch(/wget [^\n]*--header "X-Infrawrench-Ci-Job: \$IWCI_TOKEN"/);
    // Small enough for the strictest user data limit there is, twice over.
    expect(Buffer.byteLength(boot)).toBeLessThan(4096);
  });

  it("puts a declared tool in the script only as plain words, an HTTPS URL and a SHA-256", () => {
    const sha = "a".repeat(64);
    const script = jobScript({
      ...base,
      tools: [
        { command: "ssh", packages: { apt: "openssh-client", dnf: "openssh-clients" } },
        {
          command: "kubectl",
          downloads: { x86_64: { url: "https://dl.example.test/k", sha256: sha } },
        },
        { command: "evil; rm -rf /" },
        { command: "a", packages: { apt: "x $(id)" } },
        { command: "b", downloads: { x86_64: { url: "http://dl.example.test/b", sha256: sha } } },
        {
          command: "c",
          downloads: { aarch64: { url: "https://dl.example.test/c", sha256: "nope" } },
        },
      ],
    });
    expect(script).toContain("apt-get) _pkg 'openssh-client' ;;");
    expect(script).toContain("dnf|microdnf|yum) _pkg 'openssh-clients' ;;");
    expect(script).toContain(`x86_64|amd64) _dl 'kubectl' 'https://dl.example.test/k' '${sha}' ;;`);
    expect(script).not.toContain("evil");
    expect(script).not.toContain("$(id)");
    expect(script).not.toContain("http://dl.example.test");
    expect(script).not.toContain("dl.example.test/c");
    // A reused host's packages are its owner's: only the download applies.
    const host = jobScript({
      ...base,
      isolate: true,
      tools: [{ command: "ssh", packages: { apt: "openssh-client" } }],
    });
    expect(host).not.toContain("_pkg 'openssh-client'");
    expect(host).toContain("install it on the host");
  });

  it("leaves a job that is lent nothing without any of it", () => {
    const script = jobScript(base);
    expect(script).not.toContain("_pkg");
    expect(script).not.toContain("_dl");
    expect(script).not.toContain("exec %q -F");
  });

  it("quotes for the shell", () => {
    expect(shq("it's")).toBe(`'it'\\''s'`);
  });
});

describe("parseFinishBody", () => {
  it("reads the output and the changed paths", () => {
    const body = `${Buffer.from("digest=sha256:abc\n").toString("base64")}\n?? new.txt\n M src/a.ts\n D old.txt\nR  a -> b\n`;
    expect(parseFinishBody(body)).toEqual({
      output: "digest=sha256:abc\n",
      changes: [
        { path: "new.txt", kind: "added" },
        { path: "src/a.ts", kind: "modified" },
        { path: "old.txt", kind: "deleted" },
        { path: "a", kind: "deleted" },
        { path: "b", kind: "added" },
      ],
    });
    expect(parseFinishBody("\n")).toEqual({ output: "", changes: [] });
  });
});

/**
 * The job script run for real against a fake callback and proxy on the
 * loopback: it fetches the commit, writes its files and environment, runs
 * the job, relays its output, uploads its artifacts and reports how it ended.
 */
describe.each([
  { isolate: false, work: false, label: "a job on a fresh machine" },
  { isolate: true, work: false, label: "a job on a reused host, in a root of its own" },
  { isolate: true, work: true, label: "a job on a reused host, in its executor's work directory" },
])("$label", ({ isolate, work }) => {
  if (!realShell) {
    it.skip("needs a real shell, curl and tar", () => {});
    return;
  }
  let server: Server;
  let root: string;
  let port = 0;
  const logs: Array<{ stream: string; text: string }> = [];
  let artifact: Buffer | null = null;
  let finished: ((value: { query: URLSearchParams; body: string }) => void) | null = null;
  const done = new Promise<{ query: URLSearchParams; body: string }>((resolve) => {
    finished = resolve;
  });

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "iwci-job-"));
    mkdirSync(join(root, "src", "repo-abc"), { recursive: true });
    writeFileSync(join(root, "src", "repo-abc", "hello.txt"), "from the commit\n");
    execFileSync("tar", ["-czf", join(root, "src.tgz"), "-C", join(root, "src"), "repo-abc"]);
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        // The callback answers only with the job's token, which no URL carries.
        if (url.pathname.startsWith("/cb/")) {
          if (req.headers["x-infrawrench-ci-job"] !== TOKEN || url.pathname.includes(TOKEN)) {
            res.writeHead(403).end();
            return;
          }
        }
        if (url.pathname === "/cb/script") {
          // A fresh machine writes where the claim says (here under a
          // temporary directory); a reused host keeps the claim's own
          // absolute paths (`/app`, `/root`) and moves them under its root.
          const app = isolate ? "/app" : join(root, "app");
          const kube = isolate ? "/root/.kube/x.yaml" : join(root, "home", ".kube", "x.yaml");
          res.end(
            jobScript({
              ...base,
              isolate,
              callbackUrl: `http://127.0.0.1:${port}/cb`,
              token: TOKEN,
              proxyUrl: `http://127.0.0.1:${port}/proxy`,
              cwd: app,
              cloneInto: app,
              env: {
                TOKEN: "s3cret value with 'quotes'",
                HOME: isolate ? "/root" : root,
                KUBECONFIG: kube,
              },
              files: [
                {
                  path: kube,
                  mode: "600",
                  content: "kind: Config\n",
                },
              ],
              script: [
                'echo "hello $(cat hello.txt)"',
                'echo "token=$TOKEN"',
                "echo oops >&2",
                'echo "digest=42" >> "$IWCI_OUTPUT"',
                'cat "$KUBECONFIG"',
                'echo "kube=$KUBECONFIG home=$HOME pwd=$PWD"',
                "mkdir -p out && echo built > out/a.txt",
              ].join("\n"),
              artifacts: { url: "/artifacts?claim=t", paths: [`${app}/out`] },
            }),
          );
        } else if (url.pathname === "/cb/source") {
          res.writeHead(302, { Location: `http://127.0.0.1:${port}/src.tgz` }).end();
        } else if (url.pathname === "/src.tgz") {
          // The archive link is fetched without the job's token.
          if (req.headers["x-infrawrench-ci-job"]) {
            res.writeHead(403).end();
            return;
          }
          res.end(readFileSync(join(root, "src.tgz")));
        } else if (url.pathname === "/cb/log") {
          logs.push({ stream: url.searchParams.get("stream") ?? "", text: body.toString("utf8") });
          res.writeHead(204).end();
        } else if (url.pathname === "/proxy/artifacts") {
          artifact = body;
          res.end("{}");
        } else if (url.pathname === "/cb/finish") {
          res.writeHead(204).end();
          finished?.({ query: url.searchParams, body: body.toString("utf8") });
        } else {
          res.writeHead(404).end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => {
    server?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("runs, relays and reports", async () => {
    // As the SSH host executor starts it: HOME and TMPDIR inside its work directory.
    const workDir = join(root, "work");
    if (work) {
      mkdirSync(join(workDir, "home"), { recursive: true });
      mkdirSync(join(workDir, "tmp"), { recursive: true });
    }
    const child = spawn("sh", ["-c", bootstrapScript(`http://127.0.0.1:${port}/cb`, TOKEN)], {
      stdio: "ignore",
      env: work
        ? {
            ...process.env,
            IWCI_WORK: workDir,
            HOME: join(workDir, "home"),
            TMPDIR: join(workDir, "tmp"),
          }
        : process.env,
    });
    const result = await done;
    child.kill();
    expect(result.query.get("status")).toBe("passed");
    expect(result.query.get("exit")).toBe("0");
    expect(parseFinishBody(result.body).output).toBe("digest=42\n");
    const out = logs
      .filter((l) => l.stream === "stdout")
      .map((l) => l.text)
      .join("");
    const err = logs
      .filter((l) => l.stream === "stderr")
      .map((l) => l.text)
      .join("");
    expect(out).toContain("hello from the commit");
    expect(out).toContain("token=s3cret value with 'quotes'");
    expect(out).toContain("kind: Config");
    expect(err).toContain("oops");
    expect(artifact).not.toBeNull();
    const listed = execFileSync("tar", ["-tf", "-"], { input: artifact! }).toString();
    expect(listed).toContain("out/a.txt");
    if (isolate) {
      const where = /kube=(\S+) home=(\S+) pwd=(\S+)/.exec(out);
      const [, kube, home, pwd] = where ?? [];
      const real = (p: string) => p.replace(/^\/private(?=\/)/, "").replace(/\/{2,}/g, "/");
      // Lent files under HOME, the clone under the job's root.
      expect(kube).toBe(`${home}/.kube/x.yaml`);
      expect(listed).toContain("app/out/a.txt");
      const jobRoot = real(pwd!).replace(/\/app$/, "");
      if (work) {
        expect(real(home!)).toBe(real(join(workDir, "home")));
        expect(jobRoot).toBe(real(join(workDir, "job")));
      } else {
        expect(real(home!)).toBe(`${jobRoot}/home`);
      }
      // The job's root goes right after reporting; the executor's HOME stays its own.
      for (let i = 0; i < 50 && existsSync(jobRoot); i++)
        await new Promise((r) => setTimeout(r, 100));
      expect(existsSync(jobRoot)).toBe(false);
      if (work) expect(existsSync(join(workDir, "home"))).toBe(true);
    }
  }, 30_000);
});

/** A callback on the loopback that serves `script` and keeps what the machine sends. */
async function fakeCallback(script: (port: number) => string, extra: Record<string, string> = {}) {
  const logs: Array<{ stream: string; text: string }> = [];
  let finish: (value: URLSearchParams) => void = () => {};
  const finished = new Promise<URLSearchParams>((resolve) => (finish = resolve));
  let port = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (extra[url.pathname] !== undefined) res.end(extra[url.pathname]);
      else if (req.headers["x-infrawrench-ci-job"] !== TOKEN) res.writeHead(403).end();
      else if (url.pathname === "/cb/script") res.end(script(port));
      else if (url.pathname === "/cb/log") {
        logs.push({ stream: url.searchParams.get("stream") ?? "", text: body });
        res.writeHead(204).end();
      } else if (url.pathname === "/cb/finish") {
        res.writeHead(204).end();
        finish(url.searchParams);
      } else res.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
  const text = (stream: string) =>
    logs
      .filter((l) => l.stream === stream)
      .map((l) => l.text)
      .join("");
  return { server, port, finished, text };
}

describe.skipIf(!realShell)("a machine without what the job script needs", () => {
  it("tells the callback what is missing and ends the job, rather than never calling", async () => {
    const dir = mkdtempSync(join(tmpdir(), "iwci-bare-"));
    const cb = await fakeCallback(() => "exit 0\n");
    try {
      // A PATH with everything but gzip.
      for (const tool of ["bash", "curl", "tar", "base64", "id", "mktemp", "sleep"]) {
        const real = execFileSync("sh", ["-c", `command -v ${tool}`])
          .toString()
          .trim();
        symlinkSync(real, join(dir, tool));
      }
      const child = spawn(
        "/bin/sh",
        ["-c", bootstrapScript(`http://127.0.0.1:${cb.port}/cb`, TOKEN, { install: false })],
        { stdio: "ignore", env: { PATH: dir } },
      );
      const result = await cb.finished;
      child.kill();
      expect(result.get("status")).toBe("error");
      expect(cb.text("stderr")).toContain("[infrawrench] This host has no gzip.");
    } finally {
      cb.server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe.skipIf(!realShell)("a job that is lent something, on a reused host", () => {
  it("gets its tools, and an ssh that reads the lent configuration", async () => {
    const root = mkdtempSync(join(tmpdir(), "iwci-lent-"));
    const tool = "#!/bin/sh\necho kubectl-fixture-ran\n";
    const sha = createHash("sha256").update(tool).digest("hex");
    const cb = await fakeCallback(
      (port) => {
        const download = (name: string, sha256: string) => {
          const d = { url: `https://127.0.0.1:${port}/dl/${name}`, sha256 };
          return { x86_64: d, aarch64: d };
        };
        return (
          jobScript({
            ...base,
            isolate: true,
            callbackUrl: `http://127.0.0.1:${port}/cb`,
            proxyUrl: `http://127.0.0.1:${port}/proxy`,
            cloneInto: null,
            cwd: "/app",
            env: { HOME: "/root", KUBECONFIG: "/root/.kube/prod.yaml" },
            files: [
              { path: "/root/.kube/prod.yaml", mode: "600", content: "kind: Config\n" },
              { path: "/root/.ssh/id_deploy", mode: "600", content: "not a real key\n" },
              {
                path: "/root/.ssh/config",
                mode: "600",
                content: "Host *\n  IdentityFile /root/.ssh/id_deploy\n",
              },
            ],
            tools: [
              { command: "iwci-fixture-kubectl", downloads: download("good", sha) },
              { command: "iwci-fixture-tampered", downloads: download("good", "0".repeat(64)) },
              { command: "iwci-fixture-packaged", packages: { apt: "no-such-package" } },
            ],
            script: [
              "iwci-fixture-kubectl",
              'command -v iwci-fixture-tampered || echo "tampered-not-used"',
              'echo "home=$HOME pwd=$PWD kube=$KUBECONFIG"',
              'echo "modes=$(ls -ld "$HOME/.ssh" | cut -c1-10) $(ls -l "$HOME/.ssh/id_deploy" | cut -c1-10)"',
              'cat "$HOME/.ssh/config"',
              'if command -v ssh > /dev/null; then echo "ssh-shim=$(tail -1 "$(command -v ssh)")"; fi',
            ].join("\n"),
          })
            // The fixture has no certificate: the test's downloads are plain HTTP.
            .replaceAll(`https://127.0.0.1:${port}/dl/`, `http://127.0.0.1:${port}/dl/`)
        );
      },
      { "/dl/good": tool },
    );
    try {
      const child = spawn("sh", ["-c", bootstrapScript(`http://127.0.0.1:${cb.port}/cb`, TOKEN)], {
        stdio: "ignore",
        env: { ...process.env, TMPDIR: root },
      });
      const result = await cb.finished;
      child.kill();
      const out = cb.text("stdout");
      const err = cb.text("stderr");
      expect(result.get("status"), `${out}\n${err}`).toBe("passed");
      // The pinned download ran; the one with another hash was not kept.
      expect(out).toContain("kubectl-fixture-ran");
      expect(out).toContain("tampered-not-used");
      expect(err).toContain(
        "The download of iwci-fixture-tampered was not the file Infrawrench expects",
      );
      // Nothing is installed on a host: a tool only its packages have is a note.
      expect(err).toContain("This machine has no iwci-fixture-packaged");
      expect(err).toContain("install it on the host");
      // Lent files under the job's HOME, with their modes, and paths in them moved too.
      const [, home, pwd, kube] = /home=(\S+) pwd=(\S+) kube=(\S+)/.exec(out) ?? [];
      expect(kube).toBe(`${home}/.kube/prod.yaml`);
      expect(pwd!.endsWith("/app")).toBe(true);
      expect(out).toContain("modes=drwx------ -rw-------");
      expect(out).toContain(`IdentityFile ${home}/.ssh/id_deploy`);
      // OpenSSH reads the user's own home, not HOME: the job's ssh is told where.
      if (out.includes("ssh-shim=")) {
        expect(out).toMatch(/ssh-shim=exec \S+ -F \S+\/\.ssh\/config "\$@"/);
      }
    } finally {
      cb.server.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
