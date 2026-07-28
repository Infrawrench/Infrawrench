/**
 * Generates `Infrafile.d.ts` — the ambient declarations that make an Infrafile
 * autocomplete in an editor and type-check headlessly.
 *
 * It is `infra.d.ts` plus a `defineInfra` declaration. The `infra` half is
 * produced by {@link generateInfraDts} verbatim rather than reimplemented, so
 * the two surfaces cannot drift: whatever a workflow can reach, a plan or
 * deploy stage can reach identically.
 *
 * `prompt` is typed away (an Infrafile asks via `select`, which is answerable
 * with `--set`) and `costs` is off — reporting spend belongs to a workflow, not
 * a deploy.
 */
import { generateInfraDts } from "../codegen.js";
import type { WorkflowPluginInfo } from "../types.js";

export interface GenerateInfrafileDtsInput {
  plugins: WorkflowPluginInfo[];
  /** The environments the file declares, typed as a union on the stage contexts. */
  envs?: string[];
  /** Names of the caller's Infrawrench-managed SSH keys, for `resource.ssh`. */
  sshKeyNames?: string[];
}

export function generateInfrafileDts(input: GenerateInfrafileDtsInput): string {
  const infraDts = generateInfraDts({
    plugins: input.plugins,
    metrics: [],
    // An Infrafile prompts through `select`, never `infra.prompt` — the latter
    // has no key, so it could not be answered by `--set` in CI.
    interactive: false,
    triggerKind: "manual",
    costs: false,
    ...(input.sshKeyNames ? { sshKeyNames: input.sshKeyNames } : {}),
  });

  const envs = (input.envs ?? []).filter(Boolean);
  // An open union: the declared envs autocomplete, but adding one to `envs`
  // shouldn't make the rest of the file stop type-checking mid-edit.
  const envType =
    envs.length > 0
      ? `${envs.map((e) => JSON.stringify(e)).join(" | ")} | (string & {})`
      : "string";

  return `${infraDts}
// ---------------------------------------------------------------------------
// Infrafile
// ---------------------------------------------------------------------------

/** Which environment this run targets. */
type InfraEnv = ${envType};

/** Git facts about the checkout being deployed. */
interface InfraGit {
  /** Commit being deployed. */
  sha: string;
  branch: string;
  /** \`owner/name\` when known. */
  repo?: string;
  /** True when deploying a working tree with uncommitted changes (CLI only). */
  dirty?: boolean;
}

/**
 * Ask the operator to choose one of \`items\`, returning the item itself — so
 * selecting a resource gives you back a usable resource, methods and all.
 *
 * \`key\` is what makes a deploy scriptable: \`--set <key>=<value>\` (or a saved
 * answer) resolves the choice with no prompt, which is how the same Infrafile
 * runs unattended in CI. Options are labelled by \`displayName\`, \`name\`, \`label\`
 * or \`id\`, and that label is the value \`--set\` expects.
 */
type InfraSelect = <T>(key: string, label: string, items: readonly T[]) => Promise<T>;

interface InfraPlanContext {
  env: InfraEnv;
  git: InfraGit;
  select: InfraSelect;
}

/**
 * What \`plan()\` returns. Everything is yours except two reserved keys the host
 * reads:
 *
 * - \`buildOn\` — where to build: an SSH-reachable resource, or \`"local"\` to use
 *   the Docker daemon on the machine running the deploy.
 * - \`registry\` — credentials used for \`docker login\` before a push. Never
 *   logged.
 *
 * \`tag\` and \`buildArgs\` are honoured when present.
 */
interface InfraPlanResult {
  buildOn?: WorkflowResourceBase | "local";
  registry?: { host: string; username: string; password: string };
  tag?: string;
  buildArgs?: Record<string, string | number | boolean>;
  [key: string]: unknown;
}

interface InfraDockerfileContext<P = InfraPlanResult> {
  env: InfraEnv;
  plan: P;
}

/** Options for running a command inside the built image. */
interface InfraRunOptions {
  /** Environment for the process — credentials go here, never in the command. */
  env?: Record<string, string>;
  /**
   * Binary to run the command through. Defaults to \`sh\`, so \`command\` is a
   * shell line and \`&&\`, pipes and \`npm run\` scripts all behave.
   *
   * Set explicitly rather than inherited from the image: container arguments
   * are appended to whatever \`ENTRYPOINT\` the Dockerfile declared, so an image
   * that sets one would otherwise mangle every command. Pass \`""\` to clear it.
   */
  entrypoint?: string;
  /** Working directory inside the container. Defaults to \`/workspace\`. */
  workdir?: string;
  /** Mount the project at \`/workspace\`. On by default. */
  mountSource?: boolean;
  /** Run a different image than the one just built. */
  image?: string;
  /** Resolve with the exit code instead of throwing on failure. */
  allowFailure?: boolean;
}

interface InfraDeployContext<P = InfraPlanResult> {
  env: InfraEnv;
  plan: P;
  git: InfraGit;
  /** Fully-qualified reference of the image that was just built. */
  image: string;
  digest?: string;
  /** Push the built image to its registry. Defaults to \`image\`. */
  push(image?: string, registry?: { host: string; username: string; password: string }): Promise<void>;
  /** Copy the project source onto a host, e.g. to run it without a registry. */
  copyTo(target: WorkflowResourceBase, remotePath: string): Promise<void>;
  /**
   * Run a command inside the image that was just built, with your project
   * mounted at \`/workspace\`. Resolves with the command's stdout.
   *
   * This is how you deploy something that is not a container. Have the
   * Dockerfile install a toolchain, then publish from it:
   *
   * \`\`\`
   * await run("npm run db:migrate", { env: { DATABASE_URL: url } });
   * await run("npx wrangler deploy", { env: { CLOUDFLARE_API_TOKEN: token } });
   * \`\`\`
   *
   * A non-zero exit fails the deploy unless \`allowFailure\` is set, in which
   * case the full result is returned instead of stdout. \`env\` is passed to the
   * container out of band and never written to the run log.
   */
  run(command: string, opts?: InfraRunOptions & { allowFailure?: false }): Promise<string>;
  run(
    command: string,
    opts: InfraRunOptions & { allowFailure: true },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  /** Record a deploy note. Notes are printed to the run log. */
  notes(text: string): Promise<void>;
}

interface InfraDefinition<P = InfraPlanResult> {
  /** Environments this project can be deployed to. */
  envs: readonly string[];
  /**
   * Decide what to deploy and where. Runs first, with the full \`infra\` surface
   * plus \`select\`. Whatever it returns is handed to the later stages as \`plan\`.
   */
  plan(ctx: InfraPlanContext): Promise<P> | P;
  /**
   * Render the Dockerfile for this environment. Pure — no \`await\`, no \`infra\`.
   * It receives the plan, so it can branch on anything decided above.
   */
  dockerfile(ctx: InfraDockerfileContext<P>): string;
  /**
   * Ship it. Runs after the image is built, with the full \`infra\` surface — so
   * applying Kubernetes manifests, writing DNS records or SSHing to a box are
   * all just ordinary calls.
   */
  deploy(ctx: InfraDeployContext<P>): Promise<void> | void;
}

/**
 * Declare this project's build and deploy. Call it exactly once, at the top
 * level of the \`Infrafile\` at your repository root.
 */
declare function defineInfra<P extends InfraPlanResult>(definition: InfraDefinition<P>): void;
`;
}
