import { useUIStore } from "@infrawrench/ui";
import type { EnvFilesClient } from "@infrawrench/ui/env-files/types";
import {
  commitCloudEnvFile,
  createCloudEnvFileSecret,
  describeCloudEnvFile,
  listCloudEnvFileRepos,
  listCloudEnvFileSecrets,
  listCloudEnvFileSources,
  readCloudEnvFile,
  resolveCloudEnvFile,
} from "./cloud-env-files";
import { createDesktopSettingsApi } from "./settings-client";

/**
 * Environment files are cloud-only. The active org is resolved at call time
 * rather than closed over, matching `heartbeats-client.ts`: the org can change
 * under a mounted panel.
 */
function requireOrgId(): string {
  const orgId = useUIStore.getState().activeCloudOrgId;
  if (!orgId) throw new Error("Environment files require cloud mode: sign in to sync.");
  return orgId;
}

export function createDesktopEnvFilesClient(): EnvFilesClient {
  // The branch picker reads the GitHub issues branch list, a settings route
  // the cloud transport already allows (`SETTINGS_RULES`).
  const settings = createDesktopSettingsApi();
  return {
    describe: (source) => describeCloudEnvFile(requireOrgId(), source),
    resolve: (input) => resolveCloudEnvFile(requireOrgId(), input),
    listSources: (query) => listCloudEnvFileSources(requireOrgId(), query),
    listRepos: () => listCloudEnvFileRepos(requireOrgId()),
    listBranches: (installationId, repo) =>
      settings.get<string[]>(
        `/api/org/${encodeURIComponent(requireOrgId())}/github-issues/branches?${new URLSearchParams(
          { installationId: String(installationId), repo },
        ).toString()}`,
      ),
    readFile: (query) => readCloudEnvFile(requireOrgId(), query),
    commit: (input) => commitCloudEnvFile(requireOrgId(), input),
    listSecrets: () => listCloudEnvFileSecrets(requireOrgId()),
    createSecret: (name, value) => createCloudEnvFileSecret(requireOrgId(), name, value),
  };
}
