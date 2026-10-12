import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { parseDesktopDeepLink } from "@infrawrench/client-core";
import { toast, useUIStore, vulnerabilitiesTabTarget } from "@infrawrench/ui";
import { invoke } from "../lib/invoke";
import {
  incidentsTabTarget,
  navigateToWorkspaceTarget,
  resourceTabTarget,
  servicesTabTarget,
} from "@/lib/workspace-tabs";

/**
 * Opens `infrawrench://open/…` links (from the VS Code and Raycast
 * extensions) as workspace tabs. Main forwards the raw URL; parsing happens
 * here with the same client-core function that builds the links.
 *
 * A link names its org. The desktop opens it only when that is the cloud org
 * it is showing: a resource id from another org would resolve to nothing, and
 * switching orgs under someone because a link was clicked is a surprise.
 */
export function DeepLinkHost() {
  const navigate = useNavigate();
  const gt = useGT();

  useEffect(() => {
    const open = (url: unknown) => {
      if (typeof url !== "string") return;
      const link = parseDesktopDeepLink(url);
      if (!link) {
        toast.error(gt("That Infrawrench link isn't one this version can open."));
        return;
      }
      const activeOrgId = useUIStore.getState().activeCloudOrgId;
      if (!activeOrgId) {
        toast.error(gt("Sign in to Infrawrench Cloud to open links from other apps."));
        return;
      }
      if (activeOrgId !== link.orgId) {
        toast.error(
          gt("That link is for another organization. Switch to it, then open the link again."),
        );
        return;
      }
      const target =
        link.kind === "resource"
          ? resourceTabTarget(link.accountId, link.resourceId, link.pluginId, link.resourceTypeId)
          : link.kind === "incident"
            ? incidentsTabTarget(link.incidentId)
            : link.kind === "vulnerabilities"
              ? vulnerabilitiesTabTarget()
              : servicesTabTarget(link.serviceId);
      void navigateToWorkspaceTarget(navigate, target, { mode: "pin" });
    };
    window.electronAPI.on("deep_link_open", (...args: unknown[]) => open(args[0]));
    void invoke<string | null>("deep_link_take_pending")
      .then(open)
      .catch(() => {});
    return () => window.electronAPI.offAll("deep_link_open");
  }, [navigate, gt]);

  return null;
}
