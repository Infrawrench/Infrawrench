import { isWorkspaceName } from "../roots/discover.js";
import { Literal, renderYaml, type YamlValue } from "./yaml.js";

/**
 * The Infrawrench CI pipeline a Terraform workspace runs.
 *
 * It is never committed to the repository. Whoever dispatches a workspace's
 * run (server-core, on a pull request or a push that touches the root) sends
 * this text as the runner request's `pipeline`, with the job token among its
 * `secrets` and the workspace's accounts as lent `connections`.
 *
 * **How Terraform runs.** A job is a WebAssembly isolate unless it says
 * otherwise, and Terraform is a native program, so these are `platform:
 * linux` jobs: a micro VM per job. Its image has no Terraform (the runner's
 * README lists it as left out), and there is no `builtin:terraform`, so the
 * script downloads the release it is told to, checks it against a pinned
 * SHA-256, and keeps it in a job cache. NOTES.md says what would replace that.
 *
 * **Nothing from the workspace is written into the script.** Every value
 * reaches it through `env:`, so a workspace name or a URL can never become
 * shell. The script itself is one of two constants.
 *
 * **State.** The script adds an override file that sets `backend "http" {}`,
 * whatever backend the root declares, and the `TF_HTTP_*` variables point it
 * at the forge. The password is the run's job token, which is good for this
 * workspace's state and this run's plan and for nothing of the repository: a
 * plan's reads the state and takes the lock, an apply's writes it too.
 */

export type TerraformProduct = "terraform" | "opentofu";

export interface TerraformRelease {
  readonly product: TerraformProduct;
  /** An exact release, `1.9.8`. */
  readonly version: string;
  /**
   * SHA-256 of the release's Linux zip, per architecture, from the
   * publisher's signed checksum list. A run on an architecture with no pin
   * fails before it downloads anything.
   */
  readonly sha256: { readonly amd64?: string; readonly arm64?: string };
}

export interface WorkspacePipelineInput {
  /** `plan` for a pull request, `apply` for the default branch. */
  readonly kind: "plan" | "apply";
  readonly workspace: {
    readonly name: string;
    /** The root directory, relative to the repository; `""` for its top. */
    readonly rootPath: string;
  };
  /** `https://git.infrawrench.com/<owner>/<repo>/terraform/<workspace>/state` */
  readonly stateUrl: string;
  /**
   * Where the job posts the plan's `terraform show -json` output:
   * `https://git.infrawrench.com/<owner>/<repo>/terraform/<workspace>/runs/<run id>/plan`.
   */
  readonly planUrl: string;
  readonly release: TerraformRelease;
  /** The repository's default branch: the only one an apply runs on. */
  readonly defaultBranch: string;
  /**
   * Names of the connections lent to the job, as the app shows them: the
   * workspace's linked accounts. Each sets what its provider's CLI and
   * Terraform provider read (`AWS_*`, `GOOGLE_OAUTH_ACCESS_TOKEN`, `ARM_*`).
   */
  readonly connections?: readonly string[];
  /** Terraform input variables that are not secret, as `TF_VAR_<name>`. */
  readonly variables?: Readonly<Record<string, string>>;
  /** Terraform input variables read from the repository's CI secrets: variable to secret name. */
  readonly secretVariables?: Readonly<Record<string, string>>;
  /** The CI secret holding the job token. Default `IW_GIT_JOB_TOKEN`. */
  readonly tokenSecret?: string;
  /** How long a run waits for another to release the state. Default `10m`. */
  readonly lockTimeout?: string;
  /** The job's `timeout:`. Default `60m`. */
  readonly timeout?: string;
  /** The job's `memory:`, which is the machine's. Default `4GiB`. */
  readonly memory?: string;
}

export class PipelineInputError extends Error {
  override readonly name = "PipelineInputError";
  constructor(readonly problems: readonly string[]) {
    super(problems.join(" "));
  }
}

/** The username the backend sees with a job token. The token alone decides access. */
export const JOB_TOKEN_USERNAME = "infrawrench-ci";
export const DEFAULT_TOKEN_SECRET = "IW_GIT_JOB_TOKEN";
/**
 * What the app's own job token is minted for when it reads a workspace's
 * state to link it, or a plan to price it. The forge lets a token with this
 * purpose read and nothing else: it is no run's.
 */
export const SERVICE_TOKEN_PURPOSE = "terraform-link";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DURATION = /^[1-9][0-9]*[smh]$/;

function httpsUrl(value: string): boolean {
  if (/[\s"'`$\\]/.test(value)) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

function validRootPath(path: string): boolean {
  if (path === "") return true;
  return (
    /^[A-Za-z0-9._/-]+$/.test(path) &&
    !path.startsWith("/") &&
    !path.endsWith("/") &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function validate(input: WorkspacePipelineInput): void {
  const problems: string[] = [];
  if (!isWorkspaceName(input.workspace.name)) problems.push("The workspace name is not valid.");
  if (!validRootPath(input.workspace.rootPath)) problems.push("The root path is not valid.");
  if (!httpsUrl(input.stateUrl)) problems.push("The state URL is not a plain http(s) URL.");
  if (!httpsUrl(input.planUrl)) problems.push("The plan URL is not a plain http(s) URL.");
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.]+)?$/.test(input.release.version)) {
    problems.push("The release version is not an exact version.");
  }
  const pins = Object.values(input.release.sha256);
  if (pins.length === 0) problems.push("The release has no SHA-256 pin.");
  if (pins.some((pin) => !/^[0-9a-f]{64}$/.test(pin))) {
    problems.push("A release SHA-256 is not 64 lowercase hex characters.");
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(input.defaultBranch) || input.defaultBranch.startsWith("-")) {
    problems.push("The default branch name is not valid.");
  }
  for (const name of input.connections ?? []) {
    if (name === "" || name.length > 256 || /[\n\r]/.test(name) || name.includes("${{")) {
      problems.push(`The connection name ${JSON.stringify(name)} is not valid.`);
    }
  }
  if ((input.connections ?? []).length > 16) problems.push("A job is lent at most 16 connections.");
  for (const [name, value] of Object.entries(input.variables ?? {})) {
    if (!NAME.test(name)) problems.push(`The variable name ${JSON.stringify(name)} is not valid.`);
    // A value is data: an expression in it would be read by the runner.
    if (value.includes("${{")) problems.push(`The variable ${name} holds an expression.`);
  }
  for (const [name, secret] of Object.entries(input.secretVariables ?? {})) {
    if (!NAME.test(name)) problems.push(`The variable name ${JSON.stringify(name)} is not valid.`);
    if (!NAME.test(secret))
      problems.push(`The secret name ${JSON.stringify(secret)} is not valid.`);
  }
  if (!NAME.test(input.tokenSecret ?? DEFAULT_TOKEN_SECRET)) {
    problems.push("The token secret's name is not valid.");
  }
  for (const [label, value] of [
    ["lock timeout", input.lockTimeout],
    ["timeout", input.timeout],
  ] as const) {
    if (value !== undefined && !DURATION.test(value)) problems.push(`The ${label} is not valid.`);
  }
  if (input.memory !== undefined && !/^[1-9][0-9]*(MiB|GiB)$/.test(input.memory)) {
    problems.push("The memory is not valid.");
  }
  if (problems.length > 0) throw new PipelineInputError(problems);
}

/**
 * What Terraform's `http` backend reads from the environment to use a
 * workspace's state on the forge, without the credential. Locking goes to
 * `<state>/lock` with `POST` and `DELETE`: the backend's default `LOCK` and
 * `UNLOCK` methods are served too, but not every proxy passes them on.
 */
export function backendEnvironment(stateUrl: string): Record<string, string> {
  return {
    TF_HTTP_ADDRESS: stateUrl,
    TF_HTTP_LOCK_ADDRESS: `${stateUrl}/lock`,
    TF_HTTP_UNLOCK_ADDRESS: `${stateUrl}/lock`,
    TF_HTTP_LOCK_METHOD: "POST",
    TF_HTTP_UNLOCK_METHOD: "DELETE",
  };
}

/**
 * The `backend "http"` block for someone running Terraform on their own
 * machine: an administrator of the repository, with a personal access token
 * that has `repo:write`.
 */
export function backendConfiguration(stateUrl: string, username: string): string {
  const q = (value: string) => JSON.stringify(value);
  return [
    "terraform {",
    '  backend "http" {',
    `    address        = ${q(stateUrl)}`,
    `    lock_address   = ${q(`${stateUrl}/lock`)}`,
    `    unlock_address = ${q(`${stateUrl}/lock`)}`,
    '    lock_method    = "POST"',
    '    unlock_method  = "DELETE"',
    `    username       = ${q(username)}`,
    "    # password: a personal access token, in TF_HTTP_PASSWORD",
    "  }",
    "}",
    "",
  ].join("\n");
}

/** The override file a job writes so the root uses the forge's state whatever it declares. */
export const BACKEND_OVERRIDE_FILE = "infrawrench_backend_override.tf";
export const BACKEND_OVERRIDE = 'terraform {\n  backend "http" {}\n}\n';

/**
 * Installs the release and puts it on `PATH`. Reads `IW_TF_*`; nothing is
 * substituted into it.
 *
 * The cache holds the release's archive and nothing that is run. Every job
 * checks the archive against the pinned SHA-256 and unpacks the program from
 * it into its own temporary directory, so whatever wrote the cache before
 * can change what is downloaded again and never what runs.
 */
const INSTALL = `case "$(uname -m)" in
  x86_64) arch=amd64; sha256="$IW_TF_SHA256_AMD64" ;;
  aarch64 | arm64) arch=arm64; sha256="$IW_TF_SHA256_ARM64" ;;
  *) echo "There is no $IW_TF_PRODUCT build for $(uname -m)." >&2; exit 1 ;;
esac
if [ -z "$sha256" ]; then
  echo "$IW_TF_PRODUCT $IW_TF_VERSION has no pinned checksum for $arch." >&2
  exit 1
fi
if [ "$IW_TF_PRODUCT" = opentofu ]; then
  tf=tofu
  url="https://github.com/opentofu/opentofu/releases/download/v$IW_TF_VERSION/tofu_\${IW_TF_VERSION}_linux_$arch.zip"
else
  tf=terraform
  url="https://releases.hashicorp.com/terraform/$IW_TF_VERSION/terraform_\${IW_TF_VERSION}_linux_$arch.zip"
fi
zip="$IW_TF_CACHE/$IW_TF_PRODUCT-$IW_TF_VERSION-$arch.zip"
if ! echo "$sha256  $zip" | sha256sum --check --status 2>/dev/null; then
  rm -rf "$zip"
  mkdir -p "$IW_TF_CACHE"
  curl --fail --silent --show-error --location --retry 3 --output "$zip" "$url"
  echo "$sha256  $zip" | sha256sum --check --status || {
    echo "The download of $url does not match its pinned SHA-256." >&2
    exit 1
  }
fi
out="$(mktemp -d)"
mkdir "$out/bin"
unzip -q -o "$zip" "$tf" -d "$out/bin"
export PATH="$out/bin:$PATH"

printf 'terraform {\\n  backend "http" {}\\n}\\n' > ${BACKEND_OVERRIDE_FILE}
"$tf" init -input=false -no-color`;

/** Plans, and posts the plan's JSON to the forge, which keeps only its summary. */
const PLAN = `"$tf" plan -input=false -no-color -lock-timeout="$IW_TF_LOCK_TIMEOUT" -out="$out/tfplan"
"$tf" show -json "$out/tfplan" > "$out/plan.json"
curl --fail-with-body --silent --show-error --retry 3 \\
  --user "$TF_HTTP_USERNAME:$TF_HTTP_PASSWORD" \\
  --header "content-type: application/json" \\
  --data-binary "@$out/plan.json" \\
  "$IW_TF_PLAN_URL"`;

/** Applies exactly the plan that was just posted. */
const APPLY = `"$tf" apply -input=false -no-color -lock-timeout="$IW_TF_LOCK_TIMEOUT" "$out/tfplan"`;

const CLEANUP = `rm -rf "$out"`;

/** The pipeline as data: what {@link workspacePipelineYaml} renders. */
export function workspacePipeline(input: WorkspacePipelineInput): { [key: string]: YamlValue } {
  validate(input);
  const { kind, workspace, release } = input;
  const tokenSecret = input.tokenSecret ?? DEFAULT_TOKEN_SECRET;

  const env: Record<string, string> = {
    ...backendEnvironment(input.stateUrl),
    TF_HTTP_USERNAME: JOB_TOKEN_USERNAME,
    TF_HTTP_PASSWORD: `\${{ secrets.${tokenSecret} }}`,
    TF_IN_AUTOMATION: "1",
    TF_INPUT: "0",
    CHECKPOINT_DISABLE: "1",
    IW_TF_PRODUCT: release.product,
    IW_TF_VERSION: release.version,
    IW_TF_SHA256_AMD64: release.sha256.amd64 ?? "",
    IW_TF_SHA256_ARM64: release.sha256.arm64 ?? "",
    IW_TF_CACHE: "/root/.cache/infrawrench-terraform",
    IW_TF_PLAN_URL: input.planUrl,
    IW_TF_LOCK_TIMEOUT: input.lockTimeout ?? "10m",
  };
  for (const [name, value] of Object.entries(input.variables ?? {})) env[`TF_VAR_${name}`] = value;
  for (const [name, secret] of Object.entries(input.secretVariables ?? {})) {
    env[`TF_VAR_${name}`] = `\${{ secrets.${secret} }}`;
  }

  const job: { [key: string]: YamlValue } = {
    name: `${kind === "plan" ? "Plan" : "Apply"} ${workspace.name}`,
    platform: "linux",
    cwd: workspace.rootPath === "" ? "/app" : `/app/${workspace.rootPath}`,
    timeout: input.timeout ?? "60m",
    memory: input.memory ?? "4GiB",
  };
  if (input.connections && input.connections.length > 0) job["connections"] = input.connections;
  job["env"] = env;
  job["cache"] = {
    key: `infrawrench-terraform-${release.product}-${release.version}`,
    paths: ["/root/.cache/infrawrench-terraform"],
  };
  job["run"] = new Literal(
    [INSTALL, PLAN, ...(kind === "apply" ? [APPLY] : []), CLEANUP].join("\n\n"),
  );

  return {
    name: `Terraform ${kind}: ${workspace.name}`,
    // `manual` is how a person starts one by hand: a plan of a branch, or an
    // apply someone approved. The app only lets `ci:approve` start those.
    on:
      kind === "plan"
        ? { "pull-request": {}, manual: {} }
        : { push: { branches: [input.defaultBranch] }, manual: {} },
    // One apply per workspace at a time, in order, never cancelled half way.
    // A newer commit's plan replaces the pull request's older one.
    concurrency:
      kind === "plan"
        ? {
            group: `terraform-${workspace.name}-plan-\${{ pull-request.number }}-\${{ commit.branch }}`,
            "cancel-in-progress": true,
          }
        : { group: `terraform-${workspace.name}-apply`, "cancel-in-progress": false },
    jobs: { [kind]: job },
  };
}

export function workspacePipelineYaml(input: WorkspacePipelineInput): string {
  return renderYaml(workspacePipeline(input));
}
