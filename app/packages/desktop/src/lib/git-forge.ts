import { useCallback } from "react";
import { useGitForgeLinkFrom, useUIStore, type GitForgeLink } from "@infrawrench/ui";
import { cloudClient } from "./cloud-client";
import { runRpc } from "./rpc/client";

/**
 * Where the Git entry opens: the active cloud organisation's namespace on
 * git.infrawrench.com. Local mode has no organisation and so no entry.
 * Follows a claim or rename made in Settings > Git without a reload; see
 * `useGitForgeLinkFrom`.
 */
export function useGitForgeLink(): GitForgeLink {
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const load = useCallback(
    () =>
      runRpc(cloudClient("git").gitForge.overview({ params: { orgId: activeCloudOrgId ?? "" } })),
    [activeCloudOrgId],
  );
  return useGitForgeLinkFrom(activeCloudOrgId, load);
}
