import { useUIStore } from "@infrawrench/ui";
import type { CiClient } from "@infrawrench/ui/ci";
import { Effect, Stream } from "effect";
import {
  ciLogEvent,
  type CiAccessOverview,
  type CiConnectionAccess,
  type CiResourceGrant,
  type CiResourceOutputs,
  type SearchResult,
  type CiAccount,
  type CiCacheCleared,
  type CiCaches,
  type CiDownloadLink,
  type CiLogEvent,
  type CiRun,
  type CiRunDetail,
  type CiSchedules,
  type CiStatus,
  type CiUsage,
  type CiValues,
} from "@infrawrench/client-core";
import { cloudClient } from "./cloud-client";
import { getCloudGithubInstallUrl } from "./cloud-workflows";
import { DesktopRpcClient, forkRpc, runRpc } from "./rpc/client";

/**
 * A running run's live log, over the `CloudCiRunLogs` RPC stream (the main
 * process holds the SSE fetch, as it does for the chat turn), adapted into
 * the AsyncIterable the shared CI panel reads. A log that never started
 * throws its error; `signal` aborting, or the consumer leaving early,
 * interrupts the stream, which cancels the fetch.
 */
async function* streamRunLogs(
  orgId: string,
  runId: string,
  signal: AbortSignal,
): AsyncIterable<CiLogEvent> {
  const queue: CiLogEvent[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  let failure: Error | null = null;
  const notify = () => wake?.();

  const stop = forkRpc(
    Effect.gen(function* () {
      const rpc = yield* DesktopRpcClient;
      yield* Stream.runForEach(rpc.CloudCiRunLogs({ orgId, runId }), (frame) =>
        Effect.sync(() => {
          const event = ciLogEvent(frame);
          if (event) {
            queue.push(event);
            notify();
          }
        }),
      );
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          failure = new Error(error.message);
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          done = true;
          notify();
        }),
      ),
    ),
  );
  const abort = () => {
    stop();
    done = true;
    notify();
  };
  signal.addEventListener("abort", abort, { once: true });

  try {
    while (true) {
      while (queue.length > 0) yield queue.shift()!;
      if (done) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = null;
    }
    if (failure && !signal.aborted) throw failure;
  } finally {
    signal.removeEventListener("abort", abort);
    if (!done) stop();
  }
}

const ci = () => cloudClient("ci").ci;
const github = () => cloudClient("github").github;
const search = () => cloudClient("search").search;

const scope = (installationId: number, repo: string | null) => ({
  installationId: String(installationId),
  ...(repo ? { repo } : {}),
});

/**
 * CI is cloud-only: the runs come from the GitHub App's webhooks. The active
 * org is resolved at call time rather than closed over, matching
 * `dora-client.ts`.
 */
function requireOrgId(): string {
  const orgId = useUIStore.getState().activeCloudOrgId;
  if (!orgId) throw new Error("CI requires cloud mode: sign in to sync.");
  return orgId;
}

export function createDesktopCiClient(): CiClient {
  return {
    status: (): Promise<CiStatus> => runRpc(ci().status({ params: { orgId: requireOrgId() } })),
    setAccount: (installationId, enabled): Promise<CiAccount> =>
      runRpc(
        ci().setAccount({
          params: { orgId: requireOrgId(), installationId },
          payload: { enabled },
        }),
      ),
    installUrl: () => getCloudGithubInstallUrl(requireOrgId(), "ci"),
    listRuns: async (status): Promise<CiRun[]> => {
      const { runs } = await runRpc(
        ci().listRuns({
          params: { orgId: requireOrgId() },
          query: status ? { status } : {},
        }),
      );
      return [...runs];
    },
    getRun: (runId): Promise<CiRunDetail> =>
      runRpc(ci().getRun({ params: { orgId: requireOrgId(), runId } })),
    streamRunLogs: (runId, signal) => streamRunLogs(requireOrgId(), runId, signal),
    downloadLink: (runId, job, path): Promise<CiDownloadLink> =>
      runRpc(ci().downloadLink({ params: { orgId: requireOrgId(), runId }, query: { job, path } })),
    approveRun: async (runId) => {
      await runRpc(ci().approveRun({ params: { orgId: requireOrgId(), runId } }));
    },
    rejectRun: async (runId) => {
      await runRpc(ci().rejectRun({ params: { orgId: requireOrgId(), runId } }));
    },
    retryRun: (runId, { noTaskCache }): Promise<CiRun> =>
      runRpc(ci().retryRun({ params: { orgId: requireOrgId(), runId }, payload: { noTaskCache } })),
    cancelRun: (runId): Promise<CiRun> =>
      runRpc(ci().cancelRun({ params: { orgId: requireOrgId(), runId } })),
    listCaches: async (): Promise<CiCaches> => {
      const { accounts } = await runRpc(ci().listCaches({ params: { orgId: requireOrgId() } }));
      return { accounts: accounts.map((a) => ({ ...a, repos: [...a.repos] })) };
    },
    listSchedules: async (): Promise<CiSchedules> => {
      const { schedules } = await runRpc(ci().listSchedules({ params: { orgId: requireOrgId() } }));
      return {
        schedules: schedules.map((s) => ({
          ...s,
          pipelines: s.pipelines.map((p) => ({ ...p, cron: [...p.cron] })),
        })),
      };
    },
    clearCache: (installationId, repo): Promise<CiCacheCleared> =>
      runRpc(ci().clearCache({ params: { orgId: requireOrgId(), installationId, repo } })),
    usage: (): Promise<CiUsage> =>
      runRpc(ci().usage({ params: { orgId: requireOrgId() }, query: {} })),
    listRepos: async (installationId) => {
      const { repos } = await runRpc(github().repos({ params: { orgId: requireOrgId() } }));
      return repos
        .filter((r) => r.installationId === installationId)
        .map((r) => r.fullName.split("/")[1] ?? r.fullName);
    },
    listValues: (installationId, repo): Promise<CiValues> =>
      runRpc(
        ci().listValues({ params: { orgId: requireOrgId() }, query: scope(installationId, repo) }),
      ),
    setValue: async (installationId, repo, kind, name, value) => {
      await runRpc(
        ci().setValue({
          params: { orgId: requireOrgId(), kind, name },
          query: scope(installationId, repo),
          payload: { value },
        }),
      );
    },
    deleteValue: async (installationId, repo, kind, name) => {
      await runRpc(
        ci().deleteValue({
          params: { orgId: requireOrgId(), kind, name },
          query: scope(installationId, repo),
        }),
      );
    },
    // The contract's answers are readonly arrays; the shared types are the
    // same shapes, mutable.
    access: async (): Promise<CiAccessOverview> =>
      (await runRpc(
        ci().access({ params: { orgId: requireOrgId() } }),
      )) as unknown as CiAccessOverview,
    setConnectionAccess: async (accountId, settings): Promise<CiConnectionAccess> =>
      (await runRpc(
        ci().setConnectionAccess({
          params: { orgId: requireOrgId(), accountId },
          payload: settings,
        }),
      )) as unknown as CiConnectionAccess,
    preflightConnection: async (accountId, kind): Promise<CiConnectionAccess> =>
      (await runRpc(
        ci().preflightConnection({
          params: { orgId: requireOrgId(), accountId },
          payload: { kind },
        }),
      )) as unknown as CiConnectionAccess,
    searchResources: async (query): Promise<SearchResult[]> => [
      ...(await runRpc(
        search().search({
          params: { orgId: requireOrgId() },
          query: { q: query, kinds: "resource" },
        }),
      )),
    ],
    resourceOutputs: async (resourceId): Promise<CiResourceOutputs> =>
      (await runRpc(
        ci().resourceOutputs({ params: { orgId: requireOrgId() }, query: { resourceId } }),
      )) as unknown as CiResourceOutputs,
    createGrant: async (input): Promise<CiResourceGrant> =>
      (await runRpc(
        ci().createGrant({ params: { orgId: requireOrgId() }, payload: input }),
      )) as unknown as CiResourceGrant,
    updateGrant: async (grantId, input): Promise<CiResourceGrant> =>
      (await runRpc(
        ci().updateGrant({ params: { orgId: requireOrgId(), grantId }, payload: input }),
      )) as unknown as CiResourceGrant,
    deleteGrant: async (grantId) => {
      await runRpc(ci().deleteGrant({ params: { orgId: requireOrgId(), grantId } }));
    },
    revokeSshKeyLending: async (sshKeyId) => {
      await runRpc(ci().revokeSshKeyLending({ params: { orgId: requireOrgId(), sshKeyId } }));
    },
    listAllRepos: async () => {
      const orgId = requireOrgId();
      const [{ repos }, status] = await Promise.all([
        runRpc(github().repos({ params: { orgId } })),
        runRpc(ci().status({ params: { orgId } })),
      ]);
      const enabled = new Set(
        status.accounts.filter((a) => a.ciEnabled).map((a) => a.installationId),
      );
      return repos.filter((r) => enabled.has(r.installationId)).map((r) => r.fullName);
    },
    // The renderer's own plugin manifests: no cloud round trip for artwork.
    pluginLogos: async () => {
      const { loadPlugins } = await import("../plugins/loader");
      return Object.fromEntries(
        (await loadPlugins()).map((p) => [p.plugin.manifest.id, p.plugin.manifest.logoSvg]),
      );
    },
  };
}
