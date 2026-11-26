/**
 * The Worker's bindings (`wrangler.jsonc`) and secrets. Every module takes
 * what it needs from this one type, so a binding added here is a binding the
 * whole worker can name.
 *
 * Types come from `@cloudflare/workers-types/index` by import, never the
 * global flavour, which clashes with `@types/node` across the server-core
 * graph (KNOWLEDGE.md "Edge/gateway split").
 */
import type {
  DurableObjectNamespace,
  Fetcher,
  Hyperdrive,
  Queue,
  R2Bucket,
} from "@cloudflare/workers-types/index";

/**
 * What a push leaves on the `infrawrench-git-events` queue (git/README.md
 * "After a push"). The Durable Object sends it once the refs have moved; the
 * consumer updates the repository row, synchronises pull requests, closes
 * issues a commit fixes, and starts CI and Terraform plans.
 */
export interface GitPushEvent {
  readonly type: "push";
  readonly repoId: string;
  /** Who pushed, as `principalActor` describes them; null for an internal update. */
  readonly actor: GitEventActor | null;
  readonly updates: ReadonlyArray<{
    /** Full ref name (`refs/heads/main`). */
    readonly name: string;
    /** 40 zeros when the ref was created. */
    readonly oldOid: string;
    /** 40 zeros when the ref was deleted. */
    readonly newOid: string;
    /** The update was not a fast-forward. */
    readonly forced: boolean;
  }>;
  /** Milliseconds since the epoch. */
  readonly at: number;
}

export interface GitEventActor {
  readonly kind: "user" | "api-key" | "deploy-key" | "job";
  /** The person, when there is one behind the credential. */
  readonly userId: string | null;
  /** The deploy key's or API key's id, or the job's run id. */
  readonly credentialId: string | null;
}

/**
 * Measure a repository's languages: sent when a repository that was pushed
 * to before languages were measured is opened (`repositories.get`), since
 * only a push measures otherwise.
 */
export interface GitLanguagesEvent {
  readonly type: "languages";
  readonly repoId: string;
}

export type GitEvent = GitPushEvent | GitLanguagesEvent;

/** A Rate Limiting binding, as much of it as is used. */
export interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  /** Hyperdrive in front of the app's Postgres. A per-invocation client: `db/client.ts`. */
  readonly HYPERDRIVE: Hyperdrive;
  /** R2 bucket `infrawrench-git`: `repos/<repoId>/packs/...`, Terraform state versions. */
  readonly OBJECTS: R2Bucket;
  /** One Durable Object per repository, `idFromName(repoId)`. Class `RepoDO`. */
  readonly REPO: DurableObjectNamespace;
  /** One Durable Object per Terraform workspace (state lock and serial). Class `TerraformStateDO`. */
  readonly TERRAFORM_STATE: DurableObjectNamespace;
  /** Producer for `infrawrench-git-events`. */
  readonly EVENTS: Queue<GitEvent>;
  /**
   * The built UI (`../web/dist`), served for everything the Worker does not
   * route itself. Absent under tests and before the UI is built.
   */
  readonly ASSETS?: Fetcher;
  /**
   * Cloudflare Rate Limiting bindings (`ratelimits` in wrangler.jsonc,
   * `http/admission.ts`): cheap reads, heavy reads and writes, for callers
   * without a credential (by address) and for callers who authenticated (by
   * principal). Optional: without them the counts are kept in the data
   * centre's cache, which local development and the tests use.
   */
  readonly RL_READ_ANON?: RateLimit;
  readonly RL_HEAVY_ANON?: RateLimit;
  readonly RL_WRITE_ANON?: RateLimit;
  readonly RL_READ_SIGNED_IN?: RateLimit;
  readonly RL_HEAVY_SIGNED_IN?: RateLimit;
  readonly RL_WRITE_SIGNED_IN?: RateLimit;

  // Secrets (`wrangler secret put`, or the deploy's edge-env upload).
  /** WorkOS API key: the client secret of the code and refresh-token exchanges. */
  readonly WORKOS_API_KEY: string;
  readonly WORKOS_CLIENT_ID: string;
  /** Seals the session cookie. At least 32 characters; this host's own, not the app's. */
  readonly WORKOS_COOKIE_PASSWORD: string;
  /** The SSH host key, an OpenSSH private key in PEM (ed25519). */
  readonly SSH_HOST_KEY: string;
  /** HMAC key for CI job tokens. At least 32 bytes of entropy, base64 or hex. */
  readonly GIT_JOB_TOKEN_KEY: string;
  /**
   * The app's master key, base64 of 32 bytes. Only `iwk_` API keys need it:
   * their stored hash is an HMAC under a key derived from it. Server-core
   * reads it from `process.env`, which `nodejs_compat` fills from this.
   */
  readonly ENCRYPTION_MASTER_KEY: string;

  // Variables (`vars` in wrangler.jsonc).
  /**
   * WorkOS's API host, no scheme. Production uses the custom Authentication
   * API domain (`auth-api.infrawrench.com`); unset falls back to
   * `api.workos.com`.
   */
  readonly WORKOS_API_HOSTNAME?: string;
  /** This site's origin, `https://git.infrawrench.com`. The redirect URI is built from it. */
  readonly SITE_ORIGIN?: string;
  /**
   * Where Git over SSH answers, as a repository's SSH clone URL names it:
   * a host, or `host:port` when the port is not 22 (local development).
   * Unset, the site's own host.
   */
  readonly SSH_HOST?: string;
  /** The Infrawrench app's origin, for links back. */
  readonly APP_ORIGIN?: string;
}

export const DEFAULT_SITE_ORIGIN = "https://git.infrawrench.com";
export const DEFAULT_APP_ORIGIN = "https://app.infrawrench.com";

export const siteOrigin = (env: Pick<Env, "SITE_ORIGIN">): string =>
  env.SITE_ORIGIN ?? DEFAULT_SITE_ORIGIN;

/** The host (and port, when not 22) of SSH clone URLs: `SSH_HOST`, or the site's host. */
export const sshHost = (env: Pick<Env, "SSH_HOST" | "SITE_ORIGIN">): string =>
  env.SSH_HOST !== undefined && env.SSH_HOST !== ""
    ? env.SSH_HOST
    : new URL(siteOrigin(env)).hostname;

export const appOrigin = (env: Pick<Env, "APP_ORIGIN">): string =>
  env.APP_ORIGIN ?? DEFAULT_APP_ORIGIN;
