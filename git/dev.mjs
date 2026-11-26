#!/usr/bin/env node
// The whole forge on this machine, in one command (git/README.md, "Local
// development"):
//
//   node git/dev.mjs            the Worker, the UI and the WorkOS emulator
//   node git/dev.mjs --migrate  apply the app's migrations to the database first
//
//   http://localhost:5174       the UI (Vite), which proxies the API, sign-in
//                               and the Git paths to the Worker
//   http://localhost:8787       the Worker under `wrangler dev`: local R2,
//                               Durable Objects and queues in .wrangler/state
//   localhost:8788              Git over SSH (the Worker's `connect` port)
//   http://localhost:4100       the WorkOS emulator the app's dev stack uses
//                               (dev@infrawrench.local / devpassword1!)
//
// The database is the one thing it does not start: DATABASE_URL, or the dev
// stack's Postgres on port 5433 (docker-compose.dev.yml). Nothing here
// touches Cloudflare, WorkOS or any other account.
//
// Flags: --migrate, --no-emulator (WorkOS is already running, or
// WORKOS_API_HOSTNAME in .dev.vars points somewhere else), --no-ui (only the
// Worker, serving whatever `vite build` last wrote).
import { spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKER = join(ROOT, "git/packages/worker");
const WEB = join(ROOT, "git/packages/web");
const DEV_VARS = join(WORKER, ".dev.vars");
const SEED = join(ROOT, "infra/docker/workos-emulate/seed.yaml");

const PORTS = { ui: 5174, worker: 8787, ssh: 8788, workos: 4100 };
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://infrawrench:infrawrench@localhost:5433/infrawrench";
// Wrangler refuses a local Hyperdrive connection string without one, before anything connects.
if (new URL(DATABASE_URL).password === "") {
  console.error(
    "[forge] DATABASE_URL needs a password (postgres://user:password@host:port/database): wrangler refuses a Hyperdrive connection string without one, even where the server asks for none.",
  );
  process.exit(2);
}

const flags = new Set(process.argv.slice(2));
/** Where the browser is: Vite, or the Worker itself when the UI is not started. */
const SITE = `http://localhost:${flags.has("--no-ui") ? PORTS.worker : PORTS.ui}`;
for (const flag of flags) {
  if (!["--migrate", "--no-emulator", "--no-ui"].includes(flag)) {
    console.error(`unknown flag ${flag} (--migrate, --no-emulator, --no-ui)`);
    process.exit(2);
  }
}

const say = (line) => console.log(`[forge] ${line}`);
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function run(command, args, options = {}) {
  const done = spawnSync(command, args, { cwd: ROOT, stdio: "inherit", ...options });
  if (done.status !== 0) {
    console.error(`[forge] ${command} ${args.join(" ")} failed`);
    process.exit(done.status ?? 1);
  }
}

// ---------------------------------------------------------------------------
// The Worker's secrets for local development: made once, kept in .dev.vars
// (gitignored), and never anything a real environment uses.
// ---------------------------------------------------------------------------

function ensureDevVars() {
  if (existsSync(DEV_VARS)) return;
  const dir = mkdtempSync(join(tmpdir(), "iw-git-dev-"));
  let hostKey;
  try {
    const made = spawnSync(
      "ssh-keygen",
      ["-q", "-t", "ed25519", "-N", "", "-C", "git-dev", "-f", join(dir, "host")],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    if (made.status !== 0) {
      console.error("[forge] ssh-keygen failed: OpenSSH is needed to make the SSH host key");
      process.exit(1);
    }
    hostKey = readFileSync(join(dir, "host"), "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const random = () => randomBytes(48).toString("base64");
  const lines = [
    "# Local development only, written by git/dev.mjs. Delete the file to start over.",
    "# The WorkOS emulator: its built-in key, and it does not check client ids.",
    "WORKOS_API_KEY=sk_test_default",
    "WORKOS_CLIENT_ID=client_dev_emulator",
    `WORKOS_COOKIE_PASSWORD=${random()}`,
    `GIT_JOB_TOKEN_KEY=${random()}`,
    "# docker-compose.dev.yml's fixed dev key, so `iwk_` API keys made in the local app verify here.",
    "ENCRYPTION_MASTER_KEY=uRW8wQXfjwBUcLFwQnmNnO3VvY4x/Nd8E2VVQF9nnvo=",
    `SSH_HOST_KEY="${hostKey.trim().replaceAll("\n", "\\n")}\\n"`,
    "# Review agents call Claude through Cloudflare AI Gateway and spend its credits.",
    "# To run them here, set all three (app/packages/web/.env.example says where they come from):",
    "# CLOUDFLARE_ACCOUNT_ID=",
    "# AI_GATEWAY_ID=default",
    "# AI_GATEWAY_TOKEN=",
    "",
  ];
  writeFileSync(DEV_VARS, lines.join("\n"), { mode: 0o600 });
  say(`wrote ${DEV_VARS}`);
}

// ---------------------------------------------------------------------------
// Children: started in their own process groups, all stopped together.
// ---------------------------------------------------------------------------

const children = [];
let stopping = false;

function start(name, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    ...options,
    env: { ...process.env, FORCE_COLOR: "1", ...options.env },
  });
  const prefix = `[${name}] `;
  for (const stream of [child.stdout, child.stderr]) {
    let rest = "";
    stream.on("data", (chunk) => {
      const lines = (rest + chunk).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) console.log(prefix + line);
    });
  }
  child.on("exit", (code) => {
    if (stopping) return;
    say(`${name} exited (${code ?? "signal"}); stopping the rest`);
    stop(code ?? 1);
  });
  children.push(child);
  return child;
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    try {
      // The whole group: wrangler leaves workerd behind when only it is signalled.
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
  setTimeout(() => process.exit(code), 500);
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

async function answers(url) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

async function waitFor(name, url, seconds) {
  for (let i = 0; i < seconds * 2; i++) {
    if (await answers(url)) return;
    await new Promise((done) => setTimeout(done, 500));
  }
  say(`${name} did not answer at ${url} within ${seconds} s`);
  stop(1);
}

// ---------------------------------------------------------------------------

ensureDevVars();

// The libraries the Worker and the UI load built output from (cached by turbo).
run(pnpm, [
  "exec",
  "turbo",
  "run",
  "build",
  "--filter=@infrawrench/git-web^...",
  "--filter=@infrawrench/client-core",
  "--output-logs=errors-only",
]);
// `wrangler dev` wants the assets directory to exist; the UI comes from Vite here.
mkdirSync(join(WEB, "dist"), { recursive: true });

if (flags.has("--migrate")) {
  say("applying the app's migrations");
  run(pnpm, ["--filter", "@infrawrench/web", "db:migrate"], {
    env: { ...process.env, DATABASE_URL },
  });
}

if (!flags.has("--no-emulator")) {
  if (await answers(`http://127.0.0.1:${PORTS.workos}/health`)) {
    say(`the WorkOS emulator is already running on ${PORTS.workos}`);
  } else {
    // A signing key that outlives a restart, so a session made before one still verifies.
    const keyPath = join(WORKER, ".wrangler/workos-signing-key.pem");
    if (!existsSync(keyPath)) {
      mkdirSync(dirname(keyPath), { recursive: true });
      const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
      writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    }
    // The version infra/docker/workos-emulate/Dockerfile installs.
    start("workos", "npx", [
      "--yes",
      "@workos/emulate@^0.5.0",
      "--port",
      String(PORTS.workos),
      "--interactive",
      "--seed",
      SEED,
      "--signing-key",
      keyPath,
      "--kid",
      "dev_key",
    ]);
    await waitFor("the WorkOS emulator", `http://127.0.0.1:${PORTS.workos}/health`, 120);
  }
}

start(
  "worker",
  pnpm,
  [
    "exec",
    "wrangler",
    "dev",
    "--port",
    String(PORTS.worker),
    "--show-interactive-dev-session=false",
    // The browser talks to Vite, so that is the site: the WorkOS redirect
    // comes back to it and the session cookie is its.
    "--var",
    `SITE_ORIGIN:${SITE}`,
    "--var",
    "APP_ORIGIN:http://localhost:3000",
    "--var",
    `WORKOS_API_HOSTNAME:localhost:${PORTS.workos}`,
    "--var",
    `SSH_HOST:localhost:${PORTS.ssh}`,
  ],
  {
    cwd: WORKER,
    env: {
      // What the Hyperdrive binding connects to under `wrangler dev`.
      CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: DATABASE_URL,
      WRANGLER_SEND_METRICS: "false",
    },
  },
);
await waitFor("the Worker", `http://127.0.0.1:${PORTS.worker}/api/session`, 120);

if (!flags.has("--no-ui")) {
  start("ui", pnpm, ["exec", "vite", "--port", String(PORTS.ui), "--strictPort"], { cwd: WEB });
  await waitFor("the UI", `http://localhost:${PORTS.ui}/`, 60);
}

if (!stopping) {
  say("");
  say(`the forge is at ${SITE}`);
  say("sign in as dev@infrawrench.local / devpassword1! (the WorkOS emulator's seeded user)");
  say(`Git over SSH: ssh://git@localhost:${PORTS.ssh}/<owner>/<repository>.git`);
  say("Ctrl-C stops everything");
}
