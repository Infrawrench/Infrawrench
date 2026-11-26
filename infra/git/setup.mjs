#!/usr/bin/env node
// Provisions what git.infrawrench.com needs on Cloudflare that a deploy does
// not make: the R2 bucket, the event queue and its dead letter queue, the
// Worker's own two secrets (the SSH host key among them) and the Spectrum
// application that brings port 22 to the Worker. infra/README.md
// ("git.infrawrench.com") is the runbook and says in what order.
//
//   node infra/git/setup.mjs --dry-run            print every request, send none
//   node infra/git/setup.mjs                      everything a first deploy needs
//   node infra/git/setup.mjs --only spectrum      one step (after the first deploy)
//   node infra/git/setup.mjs --ssh-host ssh.git.infrawrench.com --only spectrum
//
// Steps, in order: bucket, queues, hyperdrive, secrets, domain, workos,
// spectrum. Each reads what is there first and changes nothing that is
// already right, so the script can be run again at any point.
//
// The Worker's Rate Limiting bindings (`ratelimits` in wrangler.jsonc) have
// no step: a binding's `namespace_id` is a number the configuration chooses,
// and the deploy is what makes it count.
//
// Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment
// (never as arguments, which a process list shows). The token: Workers
// Scripts, Workers R2 Storage and Queues (edit), Hyperdrive (read), and on
// the zone Zone (read) and Zone Settings (edit), which is what Spectrum's API
// asks for. `secrets` also needs `ssh-keygen` and the repository's wrangler.
//
// Nothing here prints a secret: a request's headers are never shown, the two
// generated values go to wrangler on its standard input, and the host key's
// private half is deleted as soon as it is stored. What is printed of the
// host key is its public half and fingerprint, which are public by design.
//
// The names (Worker, bucket, queues, hosts, the Hyperdrive id) are read from
// git/packages/worker/wrangler.jsonc, so this cannot provision one thing
// while the Worker binds another.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WORKER_DIR = join(ROOT, "git/packages/worker");
const STEPS = ["bucket", "queues", "hyperdrive", "secrets", "domain", "workos", "spectrum"];
/** The Worker's own secrets. The rest are the app's, uploaded by each deploy. */
const OWN_SECRETS = ["WORKOS_COOKIE_PASSWORD", "SSH_HOST_KEY"];

// ---------------------------------------------------------------------------
// Arguments and configuration
// ---------------------------------------------------------------------------

function usage(problem) {
  if (problem) console.error(`error: ${problem}\n`);
  console.error(
    [
      "usage: node infra/git/setup.mjs [--dry-run] [--only <step>[,<step>...]] [--ssh-host <host>]",
      "                                [--zone <name>] [--location <hint>]",
      "",
      `steps: ${STEPS.join(", ")}`,
      "  --dry-run    print the requests a first run would send; send nothing",
      "  --ssh-host   where Git over SSH answers (default: SSH_HOST in wrangler.jsonc)",
      "  --zone       the zone the hosts are in (default: infrawrench.com)",
      "  --location   the bucket's location hint: apac, eeur, enam, weur, wnam, oc (default: enam)",
    ].join("\n"),
  );
  process.exit(problem ? 2 : 0);
}

const options = {
  dryRun: false,
  only: null,
  sshHost: null,
  zone: "infrawrench.com",
  location: "enam",
};
for (let args = process.argv.slice(2); args.length > 0;) {
  const arg = args.shift();
  const value = () => args.shift() ?? usage(`${arg} needs a value`);
  if (arg === "--dry-run") options.dryRun = true;
  else if (arg === "--only") options.only = value().split(",");
  else if (arg === "--ssh-host") options.sshHost = value();
  else if (arg === "--zone") options.zone = value();
  else if (arg === "--location") options.location = value();
  else if (arg === "--help" || arg === "-h") usage();
  else usage(`unknown argument ${arg}`);
}
for (const step of options.only ?? []) {
  if (!STEPS.includes(step)) usage(`unknown step ${step}`);
}

/** JSONC to JSON: drop comments outside strings, then trailing commas. */
function parseJsonc(text) {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i];
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

const wrangler = parseJsonc(readFileSync(join(WORKER_DIR, "wrangler.jsonc"), "utf8"));
const consumer = wrangler.queues.consumers[0];
const config = {
  worker: wrangler.name,
  bucket: wrangler.r2_buckets[0].bucket_name,
  queue: wrangler.queues.producers[0].queue,
  deadLetterQueue: consumer.dead_letter_queue,
  hyperdrive: wrangler.hyperdrive[0].id,
  siteHost: new URL(wrangler.vars.SITE_ORIGIN).hostname,
  siteOrigin: wrangler.vars.SITE_ORIGIN,
  sshHost: options.sshHost ?? wrangler.vars.SSH_HOST,
};
if (!config.sshHost || /[:/]/.test(config.sshHost)) {
  usage(`the SSH host must be a bare host name, got ${JSON.stringify(config.sshHost)}`);
}

const API = (process.env.CLOUDFLARE_API_BASE_URL ?? "https://api.cloudflare.com/client/v4").replace(
  /\/$/,
  "",
);
const token = process.env.CLOUDFLARE_API_TOKEN;
const account =
  process.env.CLOUDFLARE_ACCOUNT_ID ?? (options.dryRun ? "$CLOUDFLARE_ACCOUNT_ID" : "");
if (!options.dryRun && (!token || !account)) {
  usage(
    "set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment (or pass --dry-run)",
  );
}

// ---------------------------------------------------------------------------
// The API
// ---------------------------------------------------------------------------

const log = (line = "") => console.log(line);
const note = (line) => console.log(`  ${line}`);
/** "created", or what a dry run can honestly say instead. */
const did = (verb) => (options.dryRun ? `would be ${verb}` : verb);

class ApiError extends Error {
  constructor(method, path, status, errors) {
    const detail = errors.map((e) => `${e.code ?? ""} ${e.message ?? ""}`.trim()).join("; ");
    super(`${method} ${path} answered ${status}${detail ? `: ${detail}` : ""}`);
    this.status = status;
    this.codes = errors.map((e) => e.code);
  }
}

/**
 * One request. A read (`GET`) is sent, except in a dry run, where it answers
 * `undefined`: a dry run touches nothing and so assumes nothing exists. A
 * write is printed and, outside a dry run, sent.
 */
async function api(method, path, body) {
  const write = method !== "GET";
  if (write || options.dryRun) {
    log(`  ${options.dryRun ? "would send" : "sending"}: ${method} ${API}${path}`);
    if (body !== undefined) {
      for (const line of JSON.stringify(body, null, 2).split("\n")) log(`    ${line}`);
    }
  }
  if (options.dryRun) return undefined;
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON: an error page from something in front of the API.
  }
  if (!response.ok || parsed?.success === false) {
    throw new ApiError(method, path, response.status, parsed?.errors ?? []);
  }
  return parsed?.result;
}

/** A read that answers null where the thing is not there. */
async function find(path) {
  try {
    return (await api("GET", path)) ?? null;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/** Every page of a list. */
async function list(path) {
  if (options.dryRun) {
    await api("GET", path);
    return [];
  }
  const all = [];
  for (let page = 1; page <= 50; page++) {
    const batch = await api(
      "GET",
      `${path}${path.includes("?") ? "&" : "?"}page=${page}&per_page=100`,
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    // A list that does not page answers every page with the whole of it.
    if (page > 1 && JSON.stringify(batch[0]) === JSON.stringify(all[0])) break;
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

let zoneId;
async function zone() {
  if (zoneId !== undefined) return zoneId;
  if (options.dryRun) {
    await api("GET", `/zones?name=${encodeURIComponent(options.zone)}`);
    return (zoneId = "$ZONE_ID");
  }
  const zones = await api("GET", `/zones?name=${encodeURIComponent(options.zone)}`);
  if (!zones?.[0]?.id) throw new Error(`No zone named ${options.zone} is visible to this token.`);
  return (zoneId = zones[0].id);
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

const steps = {
  /** Packs and Terraform state. Keys are by repository id; nothing is public. */
  async bucket() {
    const path = `/accounts/${account}/r2/buckets`;
    if (await find(`${path}/${config.bucket}`)) return note(`bucket ${config.bucket} exists`);
    await api("POST", path, { name: config.bucket, locationHint: options.location });
    note(`bucket ${config.bucket} ${did("created")}`);
  },

  /**
   * The push event queue and where a message goes after its retries. The
   * consumer (batch size, retries, the dead letter queue) is the Worker's
   * wrangler.jsonc, attached by `wrangler deploy`; both queues only have to
   * exist by then.
   */
  async queues() {
    const path = `/accounts/${account}/queues`;
    const existing = new Set((await list(path)).map((queue) => queue.queue_name));
    for (const name of [config.queue, config.deadLetterQueue]) {
      if (existing.has(name)) {
        note(`queue ${name} exists`);
        continue;
      }
      await api("POST", path, { queue_name: name });
      note(`queue ${name} ${did("created")}`);
    }
  },

  /** The app's Hyperdrive, reused: the forge's tables are in the app's database. */
  async hyperdrive() {
    const found = await find(`/accounts/${account}/hyperdrive/configs/${config.hyperdrive}`);
    if (options.dryRun) return note(`expects Hyperdrive ${config.hyperdrive} (the app's) to exist`);
    if (!found) {
      throw new Error(
        `Hyperdrive ${config.hyperdrive} (wrangler.jsonc) does not exist in this account. It is the app's (infra/README.md, "Cloudflare edge"); nothing is created here.`,
      );
    }
    note(`Hyperdrive ${found.name ?? config.hyperdrive} exists and is reused`);
  },

  /**
   * WORKOS_COOKIE_PASSWORD and SSH_HOST_KEY, each made once and never
   * replaced: a new cookie password signs everyone out, and a new host key
   * makes every client that has cloned over SSH refuse to connect.
   */
  async secrets() {
    const listed = await find(`/accounts/${account}/workers/scripts/${config.worker}/secrets`);
    const have = new Set((listed ?? []).map((secret) => secret.name));
    for (const name of OWN_SECRETS) {
      if (have.has(name)) {
        note(`secret ${name} is set (left as it is)`);
        continue;
      }
      if (options.dryRun) {
        note(
          name === "SSH_HOST_KEY"
            ? `would run: ssh-keygen -t ed25519 -N "" -C ${config.sshHost}, then wrangler secret put SSH_HOST_KEY (value on standard input)`
            : `would run: wrangler secret put ${name} (48 random bytes, on standard input)`,
        );
        continue;
      }
      if (name === "SSH_HOST_KEY") putSecret(name, generateHostKey());
      else putSecret(name, randomBytes(48).toString("base64"));
      note(`secret ${name} set`);
    }
  },

  /** `wrangler deploy` makes the custom domain from `routes`; this only says whether it is there. */
  async domain() {
    const path = `/accounts/${account}/workers/domains?hostname=${encodeURIComponent(config.siteHost)}`;
    const found = (await find(path)) ?? [];
    if (options.dryRun) return note(`${config.siteHost} is attached by the first wrangler deploy`);
    const attached = found.find((domain) => domain.hostname === config.siteHost);
    if (!attached)
      return note(`${config.siteHost} is not attached yet: the first deploy attaches it`);
    if (attached.service !== config.worker) {
      throw new Error(
        `${config.siteHost} is attached to the Worker ${attached.service}, not ${config.worker}.`,
      );
    }
    note(`${config.siteHost} is attached to ${config.worker}`);
  },

  /** Not Cloudflare's, and not something an API token of ours can do: said, not done. */
  async workos() {
    note("in the WorkOS dashboard (production environment), under Redirects, add:");
    note(`  redirect URI:      ${config.siteOrigin}/auth/callback`);
    note(`  sign-out redirect: ${config.siteOrigin}/`);
  },

  /**
   * Port 22 to the Worker's `connect()` handler. Worker origins are a public
   * beta: one application per zone on Pro and Business, TCP on one port, no
   * Proxy Protocol. The request carries only what such an application takes.
   */
  async spectrum() {
    const scripts = await list(`/accounts/${account}/workers/scripts`);
    const script = scripts.find((s) => s.id === config.worker);
    if (!options.dryRun && !script?.tag) {
      throw new Error(
        `The Worker ${config.worker} is not deployed yet, and Spectrum needs its tag. Deploy it, then run: node infra/git/setup.mjs --only spectrum`,
      );
    }
    const tag = script?.tag ?? "<the Worker's 32-character tag>";
    const path = `/zones/${await zone()}/spectrum/apps`;
    const body = {
      dns: { type: "CNAME", name: config.sshHost },
      protocol: "tcp/22",
      traffic_type: "worker",
      origin_worker_id: tag,
    };
    const apps = await list(path);
    const existing = apps.find(
      (app) => app.dns?.name === config.sshHost && app.protocol === "tcp/22",
    );
    if (existing && existing.traffic_type === "worker" && existing.origin_worker_id === tag) {
      return note(
        `Spectrum application for ${config.sshHost}:22 exists and points at ${config.worker}`,
      );
    }
    if (existing) {
      await api("PUT", `${path}/${existing.id}`, body);
      return note(`Spectrum application for ${config.sshHost}:22 now points at ${config.worker}`);
    }
    const other = apps.find((app) => app.traffic_type === "worker");
    if (other) {
      throw new Error(
        `The zone already has a Worker-origin Spectrum application (${other.dns?.name} ${other.protocol}), and Pro and Business zones get one. Remove it or move this one to it.`,
      );
    }
    try {
      await api("POST", path, body);
    } catch (error) {
      if (config.sshHost === config.siteHost) {
        console.error(
          `\n${config.sshHost} also carries the Worker's custom domain, and whether one name can have both is not documented. If that is what was refused, set "SSH_HOST": "ssh.${config.siteHost}" in git/packages/worker/wrangler.jsonc, deploy, and run this step again.`,
        );
      }
      throw error;
    }
    note(`Spectrum application for ${config.sshHost}:22 ${did("created")}`);
    if (config.sshHost !== wrangler.vars.SSH_HOST) {
      note(
        `wrangler.jsonc says SSH_HOST is ${wrangler.vars.SSH_HOST}: change it to ${config.sshHost} and deploy, or clone URLs name the wrong host`,
      );
    }
  },
};

/** An ed25519 key pair in a directory of its own, gone again before this returns. */
function generateHostKey() {
  const dir = mkdtempSync(join(tmpdir(), "iw-git-host-key-"));
  try {
    const path = join(dir, "host");
    const made = spawnSync(
      "ssh-keygen",
      ["-q", "-t", "ed25519", "-N", "", "-C", config.sshHost, "-f", path],
      {
        stdio: ["ignore", "ignore", "inherit"],
      },
    );
    if (made.status !== 0) throw new Error("ssh-keygen failed (is OpenSSH installed?)");
    const fingerprint = spawnSync("ssh-keygen", ["-lf", `${path}.pub`], { encoding: "utf8" });
    note(`host key: ${readFileSync(`${path}.pub`, "utf8").trim()}`);
    note(`fingerprint: ${fingerprint.stdout.trim()}`);
    return readFileSync(path, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * `wrangler secret put`, the value on standard input. Wrangler rather than the
 * API because it also makes the Worker when it does not exist yet (a draft
 * with no code), which is the state a first deploy starts from.
 */
function putSecret(name, value) {
  const put = spawnSync(
    process.execPath,
    [join(WORKER_DIR, "node_modules/wrangler/bin/wrangler.js"), "secret", "put", name],
    {
      cwd: WORKER_DIR,
      input: value,
      stdio: ["pipe", "ignore", "inherit"],
      env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
    },
  );
  if (put.status !== 0) throw new Error(`wrangler secret put ${name} failed`);
}

// ---------------------------------------------------------------------------

const selected = STEPS.filter((step) =>
  options.only
    ? options.only.includes(step)
    : // Spectrum needs the deployed Worker's tag, so a plain run leaves it for after the deploy.
      step !== "spectrum" || options.dryRun,
);
log(
  `${options.dryRun ? "Dry run: nothing is sent. " : ""}Worker ${config.worker}, site ${config.siteHost}, SSH ${config.sshHost}`,
);
try {
  for (const step of selected) {
    log(`\n${step}`);
    await steps[step]();
  }
} catch (error) {
  console.error(`\nerror: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
if (!options.only && !options.dryRun) {
  log("\nNext: deploy the Worker, then: node infra/git/setup.mjs --only spectrum");
}
