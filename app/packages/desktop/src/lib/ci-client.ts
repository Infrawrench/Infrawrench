import { useUIStore } from "@infrawrench/ui";
import type { CiClient } from "@infrawrench/ui/ci";
import type {
  CiAccount,
  CiRun,
  CiRunDetail,
  CiStatus,
  CiUsage,
  CiValues,
} from "@infrawrench/client-core";
import { cloudClient } from "./cloud-client";
import { getCloudGithubInstallUrl } from "./cloud-workflows";
import { runRpc } from "./rpc/client";

const ci = () => cloudClient("ci").ci;
const github = () => cloudClient("github").github;

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
    approveRun: async (runId) => {
      await runRpc(ci().approveRun({ params: { orgId: requireOrgId(), runId } }));
    },
    rejectRun: async (runId) => {
      await runRpc(ci().rejectRun({ params: { orgId: requireOrgId(), runId } }));
    },
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
  };
}
