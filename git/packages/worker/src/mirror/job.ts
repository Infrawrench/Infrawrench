/**
 * A push mirror's run, as the jobs queue starts it (`jobs/consumer.ts`):
 * take the mirror, open its credential, run `syncMirror`, write down what
 * happened.
 *
 * **Ordering.** Only the holder of the lease pushes, it reads the
 * repository's refs after it has the lease, and it renews the lease before
 * every push, stopping if it is no longer the holder. So of two pushes to
 * the repository, the run that mirrors the later one always starts after the
 * run that mirrored the earlier one has ended, and the target cannot be left
 * at the earlier state. A message that finds the mirror held does nothing:
 * the holder sees the raised generation when it finishes and asks for
 * another run itself.
 *
 * **Retries.** A failure sets when the sweep tries again (a minute, then
 * twice as long each time, up to an hour) and a push or **Sync now** tries
 * at once. The last result is on the row for Settings > Mirrors.
 *
 * **What is logged**: the mirror's id and the kind of outcome. Never the
 * address, the credential, a ref or anything the target said.
 */
import type { Env } from "../env";
import { siteOrigin } from "../env";
import type { JobOutcome } from "../jobs/consumer";
import { repoClient } from "../repo/do/client";
import { basicAuthorization, mirrorAddress } from "./address";
import {
  type MirrorRow,
  claimMirror,
  finishMirrorRun,
  openCredential,
  releaseLease,
  renewLease,
} from "./store";
import { type MirrorSource, type MirrorSyncLimits, syncMirror } from "./sync";

/** A run stops starting pushes after this long, inside a queue consumer's fifteen minutes. */
export const MIRROR_RUN_MS = 10 * 60 * 1000;
/** One request to the target may take this long: a large pack on a slow link. */
const REQUEST_TIMEOUT_MS = 13 * 60 * 1000;

export interface MirrorJobDeps {
  /** The repository's objects and refs: its Durable Object. */
  readonly source: (repositoryId: string) => MirrorSource;
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly now: () => number;
  readonly limits?: Partial<MirrorSyncLimits>;
  /** Tests only: let a mirror push to a Git host on this machine (`address.ts`). */
  readonly allowLocal?: boolean;
  readonly runMs?: number;
}

const defaultDeps = (env: Env): MirrorJobDeps => ({
  source: (repositoryId) => repoClient(env, repositoryId),
  fetch: (url, init) => fetch(url, init),
  now: Date.now,
});

export const runMirrorJob = async (
  env: Env,
  mirrorId: string,
  overrides: Partial<MirrorJobDeps> = {},
): Promise<JobOutcome> => {
  const deps = { ...defaultDeps(env), ...overrides };
  const token = crypto.randomUUID();
  const claimed = await claimMirror(mirrorId, token);
  if (claimed === null) return {};

  const finish = async (
    record: Parameters<typeof finishMirrorRun>[2],
    kind: string,
  ): Promise<JobOutcome> => {
    const finished = await finishMirrorRun(claimed, token, record);
    if (record.status === "error") console.warn(`[git] mirror ${mirrorId} failed: ${kind}`);
    return finished?.owed ? { again: 0 } : {};
  };

  const address = addressOf(env, claimed, deps.allowLocal === true);
  if (address === null) {
    return finish(
      { status: "error", error: "The address is not one a mirror may push to", result: null },
      "address",
    );
  }
  const credential = await openCredential(claimed);
  if (credential === null) {
    return finish(
      {
        status: "error",
        error: "The stored credential could not be read: enter it again",
        result: null,
      },
      "credential",
    );
  }

  const outcome = await syncMirror(
    deps.source(claimed.repositoryId),
    {
      url: address,
      authorization: basicAuthorization(claimed.username, credential),
      exclude: claimed.exclude,
      force: claimed.force,
    },
    {
      fetch: deps.fetch,
      now: deps.now,
      deadline: deps.now() + (deps.runMs ?? MIRROR_RUN_MS),
      stillMine: () => renewLease(claimed, token),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...(deps.limits ? { limits: deps.limits } : {}),
    },
  );
  // The mirror was changed, turned off or removed while this ran. What it
  // is now gets a run of its own (a change asks for one), from a clean lease.
  if (outcome.status === "superseded") {
    return (await releaseLease(mirrorId, token)) ? { again: 0 } : {};
  }
  return finish({ status: outcome.status, error: outcome.error, result: outcome.result }, "sync");
};

/** The row's address, checked again: a rule added since it was saved applies to it too. */
const addressOf = (env: Env, row: MirrorRow, allowLocal: boolean): string | null => {
  const checked = mirrorAddress(row.url, {
    siteHosts: [new URL(siteOrigin(env)).hostname],
    allowLocal,
  });
  return checked.ok ? checked.url : null;
};
