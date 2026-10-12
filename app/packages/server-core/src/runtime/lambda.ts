/**
 * What every AWS Lambda entry point (the web gateway, the poller) does that a
 * long-lived Node process does not need to.
 *
 * Lambda runs ordinary Node, so the server code is unchanged there: real
 * socket drivers, ssh2, the workflow isolate. Four things differ from a pod:
 *
 * - **Configuration.** `app_env` is far past the 4 KB Lambda allows for
 *   environment variables, so terraform (`infra/terraform/lambda.tf`) writes it
 *   to one Secrets Manager secret and {@link prepareLambdaProcess} copies it
 *   into `process.env` during the init phase, before any server module that
 *   reads its configuration at import time is loaded.
 * - **Connections.** An execution environment serves one invocation at a time
 *   and is frozen between them; a socket left idle across a freeze is often
 *   dead on thaw (NAT and Neon both time idle connections out). So the pool is
 *   small and recycles quickly.
 * - **Snapshots.** The web function runs on SnapStart (`lambda-runtime.ts`), so
 *   its init happens once per deploy and is copied into every environment;
 *   init must not keep randomness or open sockets (`lambda-snapshot.ts`).
 * - **Fire-and-forget work.** From Node 24 Lambda no longer waits for pending
 *   promises once the handler resolves, and on any version the environment can
 *   be frozen with them mid-flight. {@link lambdaInvocation} gives each
 *   invocation the same `waitUntil` scope the edge has, so `keepAlive` work
 *   (audit writes, Slack replies, notifications) is awaited after the response
 *   has been sent and before the handler returns.
 */
import { setProcessDbOptions } from "../db/client";
import { withInitRandomnessAllowed } from "./lambda-snapshot";
import { runInRequestScope, type RequestScope } from "./request-scope";

/** The secret terraform writes `app_env` into; set on the function by `lambda.tf`. */
const APP_ENV_SECRET_VAR = "INFRAWRENCH_APP_ENV_SECRET_ARN";

let prepared: Promise<void> | null = null;

async function loadAppEnv(secretId: string): Promise<void> {
  // Loaded here rather than at the top: only Lambda entry points reach this
  // module, and nothing else should pay for the SDK client.
  const { SecretsManagerClient, GetSecretValueCommand } =
    await import("@aws-sdk/client-secrets-manager");
  const client = new SecretsManagerClient({});
  // The SDK names the request with a UUID and jitters its retries; both are
  // spent once the call returns, so a SnapStart snapshot may follow it.
  // Destroying the client closes its socket, which would be dead after a
  // restore anyway.
  const out = await withInitRandomnessAllowed("Secrets Manager app_env load", () =>
    client.send(new GetSecretValueCommand({ SecretId: secretId })),
  ).finally(() => client.destroy());
  if (!out.SecretString) throw new Error(`Secret ${secretId} has no string value`);
  const values = JSON.parse(out.SecretString) as Record<string, unknown>;
  for (const [key, value] of Object.entries(values)) {
    // The function's own environment wins, so a knob set on one function
    // (POLLER_SCOPE on a test deployment, say) can override the shared map.
    if (process.env[key] === undefined && typeof value === "string") process.env[key] = value;
  }
}

/**
 * Load configuration and size the database pool. Call once, at the top of a
 * Lambda entry, before importing the server code. Without
 * `INFRAWRENCH_APP_ENV_SECRET_ARN` the environment is used as it is, which is
 * what a local run of the handler wants.
 */
export function prepareLambdaProcess(): Promise<void> {
  prepared ??= (async () => {
    const secretId = process.env[APP_ENV_SECRET_VAR];
    if (secretId) await loadAppEnv(secretId);
    setProcessDbOptions({
      // One invocation at a time per environment; the second connection is
      // for the occasional transaction running beside a plain query.
      max: 2,
      // Seconds. Short enough that a socket idle across a freeze is closed
      // and reopened rather than written to after the NAT forgot it.
      idle_timeout: 20,
      max_lifetime: 300,
    });
  })();
  return prepared;
}

export interface LambdaInvocationOptions {
  /** Hand bastion traffic and other process-local work to the session gateway. */
  sessionHandoff?: boolean;
}

export interface LambdaInvocation {
  /** Run `fn` inside the invocation's request scope. */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Wait for every promise handed to `keepAlive` in the scope, including late ones. */
  drain(): Promise<void>;
}

export function lambdaInvocation(options: LambdaInvocationOptions = {}): LambdaInvocation {
  const pending: Promise<unknown>[] = [];
  const scope: RequestScope = {
    gatewayOnly: {},
    dbWrites: { count: 0 },
    waitUntil: (promise) => {
      pending.push(promise);
    },
    ...(options.sessionHandoff ? { sessionHandoff: true } : {}),
  };
  return {
    run: (fn) => runInRequestScope(scope, fn),
    async drain() {
      let settled = 0;
      while (settled < pending.length) {
        const batch = pending.slice(settled);
        settled = pending.length;
        await Promise.allSettled(batch);
      }
    },
  };
}
