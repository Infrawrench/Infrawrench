// Coding-agent VM setup pipeline, extracted from ssh-host.ts: plan a setup
// (runtime/package-manager detection), sync repo + agent config files to the
// VM over SFTP, and reconcile the agent's branch back via git bundles. The
// IPC registrations that call into this module live in ssh-host.ts.
import { dialog } from "electron";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { workflowSshExec } from "./ssh-tunnel";
import { sftpUpload, sftpDownloadToBuffer } from "./sftp";
import { sanitizeGitConfigForAgentVm } from "./agent-gitconfig";
import { getDb, isDialogBlessedPath } from "./main-utils";
import { z } from "zod";
// The agent IPC protocol types are canonical in @infrawrench/ui (the renderer
// side imports them from there); type-only import keeps main/renderer in sync.
import type {
  AgentRepoConfig,
  AgentRuntimeLanguage,
  AgentRuntimePlan,
  AgentRuntimeVersionSource,
  AgentSetupPlan,
  AgentTool,
} from "@infrawrench/ui/agents" with { "resolution-mode": "import" };

export type { AgentTool };

export type WorkflowSshConfig = {
  sshHost: string;
  sshPort: number;
  sshUser: string;
  privateKey: string;
};

export type SftpCfg = { host: string; port: number; username: string; privateKey: string };

interface RuntimeCandidate {
  language: AgentRuntimeLanguage;
  versionRaw?: string;
  versionSource?: string;
  reasons: string[];
}

/**
 * Pull the agent's branch from the VM into the local repository. The VM has
 * no credentials for the repo's origin, so the transport is a git bundle:
 * build an incremental bundle on the VM (using local tips the remote already
 * has as the basis), download it over SFTP, and `git fetch` from it locally.
 */
export async function reconcileAgentBranch({
  config,
  workspaceName,
  branchName,
  repoPath,
}: {
  config: WorkflowSshConfig;
  workspaceName: string;
  branchName: string;
  repoPath: string;
}): Promise<{ message: string }> {
  const localRepoPath = path.resolve(expandHomePath(repoPath));
  await ensureAgentRepoPathAllowed(localRepoPath);
  if (!fs.existsSync(localRepoPath) || !fs.statSync(localRepoPath).isDirectory()) {
    throw new Error(`Local repository path does not exist: ${localRepoPath}`);
  }
  ensureGitIsAvailable();
  ensureGitWorkTree(localRepoPath);

  const localGit = (...args: string[]): string =>
    execFileSync("git", ["-C", localRepoPath, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const tryLocalGit = (...args: string[]): string | null => {
    try {
      return localGit(...args);
    } catch {
      return null;
    }
  };

  // Tips the remote likely shares with us — lets the VM build a small
  // incremental bundle instead of shipping the repo's full history.
  const negatives = [
    tryLocalGit("rev-parse", "--verify", "--quiet", "HEAD"),
    tryLocalGit("rev-parse", "--verify", "--quiet", branchName),
  ]
    .filter((sha): sha is string => Boolean(sha))
    .filter((sha, i, all) => all.indexOf(sha) === i);

  const remoteBundle = `/tmp/infrawrench-reconcile-${Date.now()}-${Math.random().toString(36).slice(2)}.bundle`;
  const remoteScript = [
    `WSNAME=${shellQuote(workspaceName)}`,
    `WS="$HOME/$WSNAME"`,
    `BR=${shellQuote(branchName)}`,
    `BUNDLE=${shellQuote(remoteBundle)}`,
    `if [ ! -d "$WS/.git" ]; then echo "RECONCILE:NO_REPO"; exit 0; fi`,
    `cd "$WS"`,
    `if ! git rev-parse --verify --quiet "refs/heads/$BR" >/dev/null; then echo "RECONCILE:NO_BRANCH"; exit 0; fi`,
    `NEG=""`,
    `for sha in ${negatives.map(shellQuote).join(" ")}; do if git cat-file -e "$sha" 2>/dev/null; then NEG="$NEG $sha"; fi; done`,
    `if [ -n "$NEG" ] && [ "$(git rev-list --count "refs/heads/$BR" --not $NEG)" = "0" ]; then echo "RECONCILE:UP_TO_DATE"; exit 0; fi`,
    `if [ -n "$NEG" ]; then git bundle create "$BUNDLE" "refs/heads/$BR" --not $NEG >/dev/null; else git bundle create "$BUNDLE" "refs/heads/$BR" >/dev/null; fi`,
    `echo "RECONCILE:BUNDLED"`,
  ].join("\n");
  const result = await workflowSshExec(config, `bash -lc ${shellQuote(remoteScript)}`, true);
  const stdout = Buffer.from(result.stdoutBase64, "base64").toString("utf8");
  const stderr = Buffer.from(result.stderrBase64, "base64").toString("utf8");
  if (result.code !== 0) {
    throw new Error(
      `Could not prepare the agent branch on the VM: ${stderr.trim() || stdout.trim() || `exit ${result.code}`}`,
    );
  }
  const marker = /RECONCILE:(\w+)/.exec(stdout)?.[1];
  if (marker === "NO_REPO") {
    throw new Error(`The agent workspace ~/${workspaceName} is not a git repository.`);
  }
  if (marker === "NO_BRANCH") {
    return { message: `The agent hasn't created ${branchName} yet — nothing to reconcile.` };
  }
  if (marker === "UP_TO_DATE") {
    return { message: `${branchName} is already up to date locally.` };
  }
  if (marker !== "BUNDLED") {
    throw new Error(`Unexpected reconcile output from the VM: ${stdout.trim().slice(0, 200)}`);
  }

  const bundleBytes = await sftpDownloadToBuffer(workflowToSftpConfig(config), remoteBundle);
  void workflowSshExec(config, `rm -f ${shellQuote(remoteBundle)}`, true).catch(() => undefined);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "infrawrench-reconcile-"));
  const bundlePath = path.join(tempDir, "agent.bundle");
  try {
    fs.writeFileSync(bundlePath, bundleBytes);
    const oldTip = tryLocalGit("rev-parse", "--verify", "--quiet", branchName);
    const currentBranch = tryLocalGit("rev-parse", "--abbrev-ref", "HEAD");
    if (currentBranch === branchName) {
      // git refuses to fetch into the checked-out branch; fast-forward it.
      localGit("fetch", "--no-tags", bundlePath, branchName);
      localGit("merge", "--ff-only", "FETCH_HEAD");
    } else {
      // + (force): the agent owns this branch; it may have rebased.
      localGit(
        "fetch",
        "--no-tags",
        bundlePath,
        `+refs/heads/${branchName}:refs/heads/${branchName}`,
      );
    }
    const newTip = localGit("rev-parse", "--verify", branchName);
    const newCommits = oldTip
      ? (tryLocalGit("rev-list", "--count", `${oldTip}..${newTip}`) ?? "?")
      : localGit("rev-list", "--count", newTip);
    return {
      message: `Fetched ${newCommits} new commit${newCommits === "1" ? "" : "s"} on ${branchName} into ${localRepoPath}.`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/ff-only|not possible to fast-forward/i.test(message)) {
      throw new Error(
        `${branchName} is checked out locally and has diverged from the agent's copy — commit or stash local changes, then merge FETCH_HEAD manually.`,
      );
    }
    throw error;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

interface LocalFileEntry {
  absolutePath: string;
  relativePath: string;
  size: number;
}

interface FileListResult {
  files: LocalFileEntry[];
  warnings: string[];
}

export async function planAgentSetup({
  repoPath,
  tool,
  workspaceName,
}: {
  repoPath: string;
  tool: AgentTool;
  workspaceName: string;
}): Promise<AgentSetupPlan> {
  const localRepoPath = path.resolve(expandHomePath(repoPath));
  await ensureLocalPathAllowed(localRepoPath, "inspect the local agent repository");
  if (!fs.existsSync(localRepoPath) || !fs.statSync(localRepoPath).isDirectory()) {
    throw new Error(`Local agent folder does not exist: ${localRepoPath}`);
  }

  ensureGitIsAvailable();
  ensureGitWorkTree(localRepoPath);

  const detected = detectProjectRuntimeCandidates(localRepoPath);
  if (detected.length === 0) {
    throw new Error(
      [
        `Could not determine a supported project runtime for ${localRepoPath}.`,
        "Add package.json/.nvmrc, composer.json/.php-version, Gemfile/.ruby-version, go.mod, or .tool-versions.",
        "Supported runtimes are Node, PHP, Ruby, and Go.",
      ].join(" "),
    );
  }

  const candidates = [...detected];
  const nodeCandidate = candidates.find((candidate) => candidate.language === "node");
  if (nodeCandidate) {
    nodeCandidate.reasons = uniqueStrings([
      ...nodeCandidate.reasons,
      `${agentToolLabel(tool)} requires Node for its CLI package`,
    ]);
  } else {
    candidates.push({
      language: "node",
      reasons: [`${agentToolLabel(tool)} requires Node for its CLI package`],
    });
  }

  const runtimes: AgentRuntimePlan[] = [];
  for (const candidate of candidates) {
    runtimes.push(await resolveRuntimePlan(candidate));
  }

  const configSources = agentConfigSources(tool, "/").map((source) => ({
    label: source.label,
    localPath: source.localPath,
    exists: fs.existsSync(source.localPath),
  }));

  // Never set initialCloneUrl for local folders: the origin remote is often
  // private (or an SSH URL) that the VM has no credentials for, so a remote
  // clone silently produces an empty workspace. Local folders always sync via
  // the archive upload, which carries the working tree including .git.
  const repoConfig = readAgentRepoConfig(localRepoPath);
  return {
    source: "local-folder",
    workspaceName,
    runtimes,
    packageManagers: detectPackageManagers(localRepoPath),
    configSources,
    warnings: [
      ...configSources
        .filter((source) => !source.exists)
        .map((source) => `No local ${source.label} config found at ${source.localPath}`),
      ...repoConfig.warnings,
    ],
    ...(repoConfig.config ? { repoConfig: repoConfig.config } : {}),
  };
}

const agentRepoConfigSchema = z
  .object({
    env: z.record(z.string()).optional(),
    resources: z
      .array(
        z
          .object({
            pluginId: z.string().min(1),
            resourceTypeId: z.string().min(1),
            account: z.string().min(1).optional(),
            name: z.string().min(1).optional(),
            fields: z.record(z.string()).optional(),
            env: z.record(z.string()).optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

/**
 * Read and validate the repo's optional `.infrawrench/agent.json`. Invalid
 * config is surfaced as a plan warning instead of failing planning — the
 * session still works, just without the repo's env/resources.
 */
function readAgentRepoConfig(localRepoPath: string): {
  config?: AgentRepoConfig;
  warnings: string[];
} {
  const configPath = path.join(localRepoPath, ".infrawrench", "agent.json");
  if (!fs.existsSync(configPath)) return { warnings: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    return {
      warnings: [
        `.infrawrench/agent.json is not valid JSON and was ignored: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
  const parsed = agentRepoConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      warnings: [
        `.infrawrench/agent.json is invalid and was ignored: ${issue ? `${issue.path.join(".") || "(root)"}: ${issue.message}` : "schema mismatch"}`,
      ],
    };
  }
  // zod's .optional() infers `| undefined`, which exactOptionalPropertyTypes
  // rejects against the shared type — the shapes are otherwise identical.
  return { config: parsed.data as AgentRepoConfig, warnings: [] };
}

function ensureGitIsAvailable(): void {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
  } catch {
    throw new Error("Git is required to create an agent from a local folder.");
  }
}

function ensureGitWorkTree(root: string): void {
  try {
    const inside = execFileSync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .toLowerCase();
    if (inside !== "true") {
      throw new Error("not a work tree");
    }
  } catch {
    throw new Error(`Local agent folder must be a Git repository: ${root}`);
  }
}

/** Expand a leading `~`/`~/` to the user's home directory in typed paths. */
function expandHomePath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

function detectProjectRuntimeCandidates(root: string): RuntimeCandidate[] {
  const candidates = new Map<AgentRuntimeLanguage, RuntimeCandidate>();
  const add = (
    language: AgentRuntimeLanguage,
    reason: string,
    versionRaw?: string,
    versionSource?: string,
  ) => {
    const existing = candidates.get(language);
    if (!existing) {
      candidates.set(language, {
        language,
        ...(versionRaw ? { versionRaw } : {}),
        ...(versionSource ? { versionSource } : {}),
        reasons: [reason],
      });
      return;
    }
    existing.reasons = uniqueStrings([...existing.reasons, reason]);
    if (shouldPreferVersion(versionRaw, existing.versionRaw, language)) {
      existing.versionRaw = versionRaw!;
      if (versionSource) {
        existing.versionSource = versionSource;
      } else {
        delete existing.versionSource;
      }
    }
  };

  for (const entry of parseToolVersions(readTextIfExists(path.join(root, ".tool-versions")))) {
    add(entry.language, ".tool-versions declares this runtime", entry.version, ".tool-versions");
  }
  for (const entry of parseMiseTools(readTextIfExists(path.join(root, ".mise.toml")))) {
    add(entry.language, ".mise.toml declares this runtime", entry.version, ".mise.toml");
  }

  const nvmrc = readFirstLine(path.join(root, ".nvmrc"));
  if (nvmrc) add("node", ".nvmrc exists", nvmrc, ".nvmrc");
  const nodeVersion = readFirstLine(path.join(root, ".node-version"));
  if (nodeVersion) add("node", ".node-version exists", nodeVersion, ".node-version");

  const packageJson = readJsonIfExists(path.join(root, "package.json"));
  if (packageJson) {
    const packageVersion = stringAt(packageJson, ["volta", "node"]);
    const engineVersion = stringAt(packageJson, ["engines", "node"]);
    add(
      "node",
      "package.json exists",
      packageVersion ?? engineVersion,
      packageVersion
        ? "package.json volta.node"
        : engineVersion
          ? "package.json engines.node"
          : undefined,
    );
  }

  const goMod = readTextIfExists(path.join(root, "go.mod"));
  if (goMod) {
    const toolchainVersion = goMod.match(/^toolchain\s+go([0-9][^\s]*)/m)?.[1];
    const goVersion = goMod.match(/^go\s+([0-9][^\s]*)/m)?.[1];
    add(
      "go",
      "go.mod exists",
      toolchainVersion ?? goVersion,
      toolchainVersion ? "go.mod toolchain" : goVersion ? "go.mod go" : undefined,
    );
  }

  const rubyVersion = readFirstLine(path.join(root, ".ruby-version"));
  if (rubyVersion) add("ruby", ".ruby-version exists", rubyVersion, ".ruby-version");
  const gemfile = readTextIfExists(path.join(root, "Gemfile"));
  if (gemfile) {
    const version = gemfile.match(/^\s*ruby\s+["']([^"']+)["']/m)?.[1];
    add("ruby", "Gemfile exists", version, version ? "Gemfile ruby" : undefined);
  }
  if (hasRootFileMatching(root, /\.gemspec$/)) {
    add("ruby", "gemspec exists");
  }

  const phpVersion = readFirstLine(path.join(root, ".php-version"));
  if (phpVersion) add("php", ".php-version exists", phpVersion, ".php-version");
  const composerJson = readJsonIfExists(path.join(root, "composer.json"));
  if (composerJson) {
    const platformVersion = stringAt(composerJson, ["config", "platform", "php"]);
    const requireVersion = stringAt(composerJson, ["require", "php"]);
    add(
      "php",
      "composer.json exists",
      platformVersion ?? requireVersion,
      platformVersion
        ? "composer.json config.platform.php"
        : requireVersion
          ? "composer.json require.php"
          : undefined,
    );
  }
  if (hasRootFileMatching(root, /\.php$/)) {
    add("php", "PHP files exist");
  }

  return Array.from(candidates.values());
}

function shouldPreferVersion(
  next: string | undefined,
  current: string | undefined,
  language: AgentRuntimeLanguage,
): boolean {
  if (!next) return false;
  if (!current) return true;
  const nextExact = normalizeRuntimeVersion(next, language);
  const currentExact = normalizeRuntimeVersion(current, language);
  return Boolean(nextExact && !currentExact);
}

async function resolveRuntimePlan(candidate: RuntimeCandidate): Promise<AgentRuntimePlan> {
  const projectVersion = normalizeRuntimeVersion(candidate.versionRaw, candidate.language);
  if (projectVersion) {
    return {
      language: candidate.language,
      version: projectVersion,
      versionSource: "project",
      source: candidate.versionSource ?? "project runtime file",
      reasons: uniqueStrings(candidate.reasons),
    };
  }

  const latest = await fetchLatestRuntimeVersion(candidate.language);
  const projectConstraint = candidate.versionRaw?.trim();
  return {
    language: candidate.language,
    version: latest.version,
    versionSource: "latest",
    source: projectConstraint
      ? `${latest.source}; project constraint ${candidate.versionSource ?? "project"}=${projectConstraint}`
      : latest.source,
    reasons: uniqueStrings(candidate.reasons),
  };
}

function normalizeRuntimeVersion(
  raw: string | undefined,
  language: AgentRuntimeLanguage,
): string | null {
  const value = raw
    ?.trim()
    .replace(/^["']|["']$/g, "")
    .replace(/^v/i, "")
    .replace(language === "go" ? /^go/i : /^$/, "")
    .replace(/^ruby-/i, "");
  if (!value) return null;
  const firstToken = value.split(/\s+/)[0] ?? "";
  if (/^\d+(?:\.\d+){0,2}$/.test(firstToken)) return firstToken;
  return null;
}

async function fetchLatestRuntimeVersion(
  language: AgentRuntimeLanguage,
): Promise<{ version: string; source: string }> {
  if (language === "node") {
    const releases = await fetchJson<Array<Record<string, unknown>>>(
      "https://nodejs.org/download/release/index.json",
    );
    const release = releases.find((item) => {
      const version = typeof item.version === "string" ? item.version : "";
      return version && !version.includes("-") && Array.isArray(item.files);
    });
    const version = typeof release?.version === "string" ? release.version.replace(/^v/, "") : "";
    if (version) return { version, source: "nodejs.org release index" };
  }

  if (language === "go") {
    const releases = await fetchJson<Array<Record<string, unknown>>>(
      "https://go.dev/dl/?mode=json",
    );
    const release = releases.find(
      (item) => item.stable === true && typeof item.version === "string",
    );
    const version = typeof release?.version === "string" ? release.version.replace(/^go/, "") : "";
    if (version) return { version, source: "go.dev downloads JSON" };
  }

  if (language === "php") {
    const releases = await fetchJson<Record<string, Record<string, unknown>>>(
      "https://www.php.net/releases/?json",
    );
    const version = maxVersion(
      Object.values(releases)
        .map((item) => (typeof item.version === "string" ? item.version : ""))
        .filter(Boolean),
    );
    if (version) return { version, source: "php.net releases JSON" };
  }

  if (language === "ruby") {
    const index = await fetchText("https://cache.ruby-lang.org/pub/ruby/index.txt");
    const versions = uniqueStrings(
      index
        .split(/\r?\n/)
        .map((line) => line.match(/^ruby-([0-9]+(?:\.[0-9]+){2})\t/)?.[1] ?? "")
        .filter(Boolean),
    );
    const version = maxVersion(versions);
    if (version) return { version, source: "cache.ruby-lang.org release index" };
  }

  throw new Error(
    `Could not determine the latest ${language} version from the official release feed.`,
  );
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return (await response.json()) as T;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.text();
}

function parseToolVersions(raw: string | null): Array<{
  language: AgentRuntimeLanguage;
  version: string;
}> {
  if (!raw) return [];
  const runtimes: Array<{ language: AgentRuntimeLanguage; version: string }> = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.replace(/\s+#.*$/g, "").trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [tool, version] = trimmed.split(/\s+/);
    const language = toolVersionLanguage(tool);
    if (language && version) runtimes.push({ language, version });
  }
  return runtimes;
}

function parseMiseTools(raw: string | null): Array<{
  language: AgentRuntimeLanguage;
  version: string;
}> {
  if (!raw) return [];
  const runtimes: Array<{ language: AgentRuntimeLanguage; version: string }> = [];
  for (const language of ["node", "php", "ruby", "go"] satisfies AgentRuntimeLanguage[]) {
    const aliases =
      language === "node" ? ["node", "nodejs"] : language === "go" ? ["go", "golang"] : [language];
    for (const alias of aliases) {
      const match = raw.match(new RegExp(`^\\s*${alias}\\s*=\\s*["']?([^"',\\]\\s]+)`, "m"));
      if (match?.[1]) runtimes.push({ language, version: match[1] });
    }
  }
  return runtimes;
}

function toolVersionLanguage(tool: string | undefined): AgentRuntimeLanguage | null {
  if (tool === "node" || tool === "nodejs") return "node";
  if (tool === "php") return "php";
  if (tool === "ruby") return "ruby";
  if (tool === "go" || tool === "golang") return "go";
  return null;
}

function detectPackageManagers(root: string): string[] {
  const found = new Map<string, string>();
  const add = (value: string) => {
    const normalized = normalizePackageManagerSpec(value);
    if (!normalized) return;
    const name = packageManagerName(normalized);
    const existing = found.get(name);
    if (!existing || normalized.includes("@")) {
      found.set(name, normalized);
    }
  };
  const packageJson = readJsonIfExists(path.join(root, "package.json"));
  const packageManager =
    typeof packageJson?.packageManager === "string" ? packageJson.packageManager : "";
  if (packageManager) add(packageManager);
  if (fs.existsSync(path.join(root, "pnpm-lock.yaml"))) add("pnpm");
  if (fs.existsSync(path.join(root, "yarn.lock"))) add("yarn");
  if (fs.existsSync(path.join(root, "package-lock.json"))) add("npm");
  if (fs.existsSync(path.join(root, "bun.lock")) || fs.existsSync(path.join(root, "bun.lockb"))) {
    add("bun");
  }
  if (
    fs.existsSync(path.join(root, "composer.lock")) ||
    fs.existsSync(path.join(root, "composer.json"))
  ) {
    add("composer");
  }
  if (fs.existsSync(path.join(root, "Gemfile.lock")) || fs.existsSync(path.join(root, "Gemfile"))) {
    add("bundler");
  }
  if (fs.existsSync(path.join(root, "go.sum")) || fs.existsSync(path.join(root, "go.mod"))) {
    add("go");
  }
  return Array.from(found.values()).sort((a, b) =>
    packageManagerName(a).localeCompare(packageManagerName(b)),
  );
}

function normalizePackageManagerSpec(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const withoutHash = trimmed.split("+")[0] ?? trimmed;
  const name = packageManagerName(withoutHash);
  if (!["npm", "pnpm", "yarn", "bun", "composer", "bundler", "go"].includes(name)) return null;
  return withoutHash;
}

function packageManagerName(value: string): string {
  return value.split("@")[0] || value;
}

function readJsonIfExists(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readTextIfExists(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function readFirstLine(filePath: string): string | undefined {
  return readTextIfExists(filePath)
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

function stringAt(value: Record<string, unknown>, pathParts: string[]): string | undefined {
  let current: unknown = value;
  for (const part of pathParts) {
    if (!current || typeof current !== "object" || !(part in current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "string" ? current : undefined;
}

function hasRootFileMatching(root: string, pattern: RegExp): boolean {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .some((entry) => entry.isFile() && pattern.test(entry.name));
  } catch {
    return false;
  }
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function maxVersion(versions: string[]): string | null {
  return versions.sort(compareVersions).at(-1) ?? null;
}

function compareVersions(a: string, b: string): number {
  const left = a.split(".").map((part) => Number(part));
  const right = b.split(".").map((part) => Number(part));
  for (let i = 0; i < Math.max(left.length, right.length, 3); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function agentToolLabel(tool: AgentTool): string {
  return tool === "claude-code" ? "Claude Code" : "Codex";
}

export async function syncAgentFiles({
  config,
  tool,
  remoteHome,
  projectDir,
  repoPath,
}: {
  config: WorkflowSshConfig;
  tool: "codex" | "claude-code";
  remoteHome: string;
  projectDir: string;
  repoPath?: string;
}): Promise<{ repoFiles: number; configFiles: number; warnings: string[] }> {
  const sftpConfig = workflowToSftpConfig(config);
  const warnings: string[] = [];
  let repoFiles = 0;
  let configFiles = 0;

  const configSources = agentConfigSources(tool, remoteHome);
  for (const source of configSources) {
    if (!fs.existsSync(source.localPath)) {
      warnings.push(`No local ${source.label} config found at ${source.localPath}`);
      continue;
    }
    const stat = fs.lstatSync(source.localPath);
    if (stat.isDirectory()) {
      const listed = listAgentConfigFiles(source.localPath, tool);
      warnings.push(...listed.warnings);
      // One archive upload + remote extract — uploading file-by-file opens a
      // fresh SSH connection per file, which takes forever for a populated
      // plugins directory (thousands of files).
      await uploadDirectoryArchive(
        config,
        sftpConfig,
        source.remotePath,
        source.localPath,
        listed.files,
      );
      configFiles += listed.files.length;
    } else if (stat.isFile()) {
      await ensureRemoteDirs(config, [path.posix.dirname(source.remotePath)]);
      const raw = fs.readFileSync(source.localPath);
      const data = source.transform
        ? Buffer.from(source.transform(raw.toString("utf8")), "utf8")
        : raw;
      await sftpUpload(sftpConfig, source.remotePath, data, {
        skipHostKeyCheck: true,
      });
      configFiles += 1;
    }
  }

  // Claude Code stores its OAuth login in the macOS Keychain (service
  // "Claude Code-credentials"), not under ~/.claude, so the directory sync
  // above never carries the login. Resolve it (credentials file on Linux,
  // Keychain on macOS) and upload it explicitly. Must run after the directory
  // sync: that step clears the remote ~/.claude first.
  if (tool === "claude-code") {
    const credentials = loadClaudeCredentials();
    if (credentials) {
      const remoteCredentialsPath = joinRemote(remoteHome, ".claude/.credentials.json");
      await ensureRemoteDirs(config, [path.posix.dirname(remoteCredentialsPath)]);
      await sftpUpload(sftpConfig, remoteCredentialsPath, Buffer.from(credentials, "utf8"), {
        skipHostKeyCheck: true,
      });
      await runAgentRemoteCommand(config, `chmod 600 ${shellQuote(remoteCredentialsPath)}`);
      configFiles += 1;
    } else {
      warnings.push(
        "No Claude Code login found locally (checked ~/.claude/.credentials.json and the macOS Keychain). Run `claude` on the VM and log in manually.",
      );
    }
  }

  if (repoPath?.trim()) {
    const localRepoPath = path.resolve(expandHomePath(repoPath));
    await ensureAgentRepoPathAllowed(localRepoPath);
    if (!fs.existsSync(localRepoPath) || !fs.statSync(localRepoPath).isDirectory()) {
      warnings.push(`Local repository path does not exist: ${localRepoPath}`);
    } else {
      const listed = listRepoFiles(localRepoPath);
      warnings.push(...listed.warnings);
      await uploadDirectoryArchive(config, sftpConfig, projectDir, localRepoPath, listed.files);
      repoFiles = listed.files.length;
    }
  }

  return { repoFiles, configFiles, warnings };
}

function workflowToSftpConfig(config: WorkflowSshConfig): SftpCfg {
  return {
    host: config.sshHost,
    port: config.sshPort,
    username: config.sshUser,
    privateKey: config.privateKey,
  };
}

/**
 * Resolve the local Claude Code OAuth credentials. Linux keeps them at
 * ~/.claude/.credentials.json; macOS keeps them in the login Keychain under
 * the "Claude Code-credentials" generic-password item. Returns null when the
 * user has never logged in (or Keychain access was denied).
 */
function loadClaudeCredentials(): string | null {
  const credentialsFile = path.join(os.homedir(), ".claude", ".credentials.json");
  try {
    if (fs.existsSync(credentialsFile)) {
      const content = fs.readFileSync(credentialsFile, "utf8").trim();
      if (content) return content;
    }
  } catch {
    /* fall through to the Keychain */
  }
  if (process.platform !== "darwin") return null;
  try {
    const content = execFileSync(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    return content || null;
  } catch {
    return null;
  }
}

interface AgentConfigSource {
  label: string;
  localPath: string;
  remotePath: string;
  /** Optional content rewrite applied before upload (file sources only). */
  transform?: (content: string) => string;
}

function agentConfigSources(
  tool: "codex" | "claude-code",
  remoteHome: string,
): AgentConfigSource[] {
  const home = os.homedir();
  // The agent commits on the VM, so it needs the user's git identity (plus
  // aliases, URL rewrites, …). Signing/credential-helper settings are
  // stripped — the keys and helpers they reference don't exist on the VM.
  const gitConfig: AgentConfigSource = {
    label: "Git",
    localPath: path.join(home, ".gitconfig"),
    remotePath: joinRemote(remoteHome, ".gitconfig"),
    transform: sanitizeGitConfigForAgentVm,
  };
  if (tool === "claude-code") {
    return [
      {
        label: "Claude Code",
        localPath: path.join(home, ".claude"),
        remotePath: joinRemote(remoteHome, ".claude"),
      },
      {
        label: "Claude Code",
        localPath: path.join(home, ".claude.json"),
        remotePath: joinRemote(remoteHome, ".claude.json"),
      },
      gitConfig,
    ];
  }
  return [
    {
      label: "Codex",
      localPath: path.join(home, ".codex"),
      remotePath: joinRemote(remoteHome, ".codex"),
    },
    gitConfig,
  ];
}

function listAgentConfigFiles(root: string, tool: "codex" | "claude-code"): FileListResult {
  const allow = agentConfigAllowlist(tool);
  const listed = listDirectoryFiles(root, {
    mode: "config",
    shouldInclude: (relativePath, isDir) => {
      const first = relativePath.split("/")[0] ?? "";
      if (!first) return false;
      if (isDir) return allow.directories.has(first);
      return allow.files.has(relativePath) || allow.directories.has(first);
    },
  });
  return {
    files: listed.files,
    warnings: [
      ...listed.warnings,
      `${agentToolLabel(tool)} config sync copied credentials/settings only and skipped local sessions, logs, caches, temp files, and downloaded packages.`,
    ],
  };
}

function agentConfigAllowlist(tool: "codex" | "claude-code"): {
  files: Set<string>;
  directories: Set<string>;
} {
  if (tool === "claude-code") {
    return {
      files: new Set(["settings.json", "mcp-needs-auth-cache.json"]),
      directories: new Set(["plugins"]),
    };
  }
  return {
    files: new Set([
      "auth.json",
      "config.toml",
      "installation_id",
      "models_cache.json",
      "version.json",
      ".codex-global-state.json",
    ]),
    directories: new Set(["skills"]),
  };
}

function listRepoFiles(root: string): FileListResult {
  const gitListed = listGitRepoFiles(root);
  if (gitListed) return gitListed;
  return listDirectoryFiles(root, { mode: "repo" });
}

function listGitRepoFiles(root: string): FileListResult | null {
  try {
    const raw = execFileSync(
      "git",
      ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { maxBuffer: 200 * 1024 * 1024 },
    );
    const warnings: string[] = [];
    const seen = new Set<string>();
    const files: LocalFileEntry[] = [];
    for (const rel of raw.toString("utf8").split("\0")) {
      if (!rel || seen.has(rel) || !isSafeRelativePath(rel)) continue;
      seen.add(rel);
      const absolutePath = path.join(root, rel);
      if (!fs.existsSync(absolutePath)) continue;
      const stat = fs.lstatSync(absolutePath);
      if (stat.isSymbolicLink()) {
        warnings.push(`Skipped symlink ${rel}`);
        continue;
      }
      if (!stat.isFile()) continue;
      files.push({ absolutePath, relativePath: rel, size: stat.size });
    }
    const metadata = listGitMetadataFiles(root);
    files.push(...metadata.files);
    warnings.push(...metadata.warnings);
    return { files, warnings };
  } catch {
    return null;
  }
}

function listGitMetadataFiles(root: string): FileListResult {
  const dotGitPath = path.join(root, ".git");
  if (!fs.existsSync(dotGitPath)) return { files: [], warnings: [] };
  const stat = fs.lstatSync(dotGitPath);
  if (!stat.isDirectory()) {
    return {
      files: [],
      warnings: ["Skipped Git metadata because .git is not a directory"],
    };
  }
  const listed = listDirectoryFiles(dotGitPath, { mode: "config" });
  return {
    files: listed.files.map((file) => ({
      ...file,
      relativePath: path.posix.join(".git", file.relativePath),
    })),
    warnings: listed.warnings,
  };
}

function listDirectoryFiles(
  root: string,
  opts: {
    mode: "repo" | "config";
    shouldInclude?: (relativePath: string, isDir: boolean) => boolean;
  },
): FileListResult {
  const warnings: string[] = [];
  const files: LocalFileEntry[] = [];
  const gitignore = opts.mode === "repo" ? loadSimpleGitignore(root) : [];
  const skipDirNames =
    opts.mode === "config"
      ? new Set([".git", "node_modules", "Cache", "cache", "logs", "tmp"])
      : new Set([".git"]);

  function walk(dir: string) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolutePath = path.join(dir, item.name);
      const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
      if (!relativePath || !isSafeRelativePath(relativePath)) continue;
      if (item.isDirectory()) {
        if (opts.shouldInclude && !opts.shouldInclude(relativePath, true)) continue;
        if (skipDirNames.has(item.name) || isSimpleIgnored(relativePath, true, gitignore)) continue;
        walk(absolutePath);
        continue;
      }
      if (item.isSymbolicLink()) {
        warnings.push(`Skipped symlink ${relativePath}`);
        continue;
      }
      if (!item.isFile()) continue;
      if (opts.shouldInclude && !opts.shouldInclude(relativePath, false)) continue;
      if (isSimpleIgnored(relativePath, false, gitignore)) continue;
      const stat = fs.statSync(absolutePath);
      files.push({ absolutePath, relativePath, size: stat.size });
    }
  }

  walk(root);
  if (opts.mode === "repo" && gitignore.length > 0) {
    warnings.push("Used built-in .gitignore fallback because Git did not list the directory");
  }
  return { files, warnings };
}

function loadSimpleGitignore(root: string): string[] {
  const gitignorePath = path.join(root, ".gitignore");
  if (!fs.existsSync(gitignorePath)) return [];
  return fs
    .readFileSync(gitignorePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("!"));
}

function isSimpleIgnored(relativePath: string, isDir: boolean, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const dirOnly = pattern.endsWith("/");
    const normalized = dirOnly ? pattern.slice(0, -1) : pattern;
    if (dirOnly && !isDir && !relativePath.startsWith(`${normalized}/`)) return false;
    if (!normalized.includes("/")) {
      return (
        relativePath.split("/").includes(normalized) ||
        gitignorePatternMatches(normalized, path.posix.basename(relativePath))
      );
    }
    return (
      relativePath === normalized ||
      relativePath.startsWith(`${normalized}/`) ||
      gitignorePatternMatches(normalized, relativePath)
    );
  });
}

function gitignorePatternMatches(pattern: string, value: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`).test(value);
}

function isSafeRelativePath(relativePath: string): boolean {
  if (path.isAbsolute(relativePath)) return false;
  const parts = relativePath.split(/[\\/]+/);
  return parts.every((part) => part && part !== "." && part !== "..");
}

async function cleanRemoteDir(config: WorkflowSshConfig, remoteDir: string): Promise<void> {
  await runAgentRemoteCommand(
    config,
    `REMOTE_DIR=${shellQuote(remoteDir)}; mkdir -p "$REMOTE_DIR"; find "$REMOTE_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +`,
  );
}

async function ensureRemoteDirs(config: WorkflowSshConfig, dirs: string[]): Promise<void> {
  const uniqueDirs = Array.from(new Set(dirs.filter(Boolean)));
  for (let i = 0; i < uniqueDirs.length; i += 50) {
    const chunk = uniqueDirs.slice(i, i + 50);
    if (chunk.length === 0) continue;
    await runAgentRemoteCommand(config, `mkdir -p -- ${chunk.map(shellQuote).join(" ")}`);
  }
}

/**
 * Replace the contents of `remoteDir` with `files` from `localRoot` using a
 * single tar.gz upload and a remote extract. Never upload file-by-file: each
 * sftpUpload opens its own SSH connection, so per-file sync of a large tree
 * takes hours.
 */
async function uploadDirectoryArchive(
  config: WorkflowSshConfig,
  sftpConfig: SftpCfg,
  remoteDir: string,
  localRoot: string,
  files: LocalFileEntry[],
): Promise<void> {
  if (files.length === 0) {
    await cleanRemoteDir(config, remoteDir);
    return;
  }

  const archive = createLocalRepoArchive(localRoot, files);
  const remoteArchive = joinRemote(
    path.posix.dirname(remoteDir),
    `.infrawrench-agent-sync-${Date.now()}-${Math.random().toString(36).slice(2)}.tar.gz`,
  );

  try {
    await sftpUpload(sftpConfig, remoteArchive, fs.readFileSync(archive.archivePath), {
      skipHostKeyCheck: true,
    });
    await runAgentRemoteCommand(
      config,
      [
        `ARCHIVE=${shellQuote(remoteArchive)}`,
        `TARGET_DIR=${shellQuote(remoteDir)}`,
        `trap 'rm -f "$ARCHIVE"' EXIT`,
        `mkdir -p "$TARGET_DIR"`,
        // Clear contents but keep the directory inode so a concurrent screen session's
        // cwd inside the workspace is not deleted out from under it.
        `find "$TARGET_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +`,
        `tar -xzf "$ARCHIVE" -C "$TARGET_DIR"`,
      ].join("; "),
    );
  } finally {
    fs.rmSync(archive.tempDir, { recursive: true, force: true });
  }
}

function createLocalRepoArchive(
  localRepoPath: string,
  files: LocalFileEntry[],
): { archivePath: string; tempDir: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "infrawrench-agent-sync-"));
  const manifestPath = path.join(tempDir, "files.txt");
  const archivePath = path.join(tempDir, "workspace.tar.gz");
  const manifest = files.map((file) => `./${file.relativePath}\0`).join("");
  fs.writeFileSync(manifestPath, manifest);
  try {
    execFileSync("tar", ["-czf", archivePath, "-C", localRepoPath, "--null", "-T", manifestPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
  return { archivePath, tempDir };
}

async function runAgentRemoteCommand(config: WorkflowSshConfig, command: string): Promise<void> {
  const result = await workflowSshExec(config, command, true);
  if (result.code !== 0) {
    const stderr = Buffer.from(result.stderrBase64, "base64").toString("utf8").trim();
    const stdout = Buffer.from(result.stdoutBase64, "base64").toString("utf8").trim();
    throw new Error(`Remote command failed (${result.code}): ${stderr || stdout || command}`);
  }
}

function joinRemote(...parts: string[]): string {
  const absolute = parts[0]?.startsWith("/") ?? false;
  const joined = path.posix.join(...parts.flatMap((part) => part.split(/[\\/]+/).filter(Boolean)));
  return absolute ? `/${joined}` : joined;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export async function ensureLocalPathAllowed(
  localPath: string,
  description: string,
): Promise<void> {
  if (isDialogBlessedPath(localPath)) return;
  const choice = await dialog.showMessageBox({
    type: "warning",
    title: "Confirm local file access",
    message: `Infrawrench wants to ${description}.`,
    detail: localPath,
    buttons: ["Allow", "Cancel"],
    defaultId: 1,
    cancelId: 1,
  });
  if (choice.response !== 0) {
    throw new Error(`Local file access denied for ${localPath}`);
  }
}

async function ensureAgentRepoPathAllowed(localPath: string): Promise<void> {
  if (isDialogBlessedPath(localPath)) return;
  const resolved = path.resolve(expandHomePath(localPath));
  const db = await getDb();
  const rows = await db.select<Array<{ repo: string }>>("SELECT repo FROM agent_sessions");
  const isSessionRepo = rows.some((row) => path.resolve(expandHomePath(row.repo)) === resolved);
  if (!isSessionRepo) {
    throw new Error(`Local agent repository is not associated with an agent session: ${localPath}`);
  }
}
