import { useMemo, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { readRevnuMeasurement } from "@infrawrench/analytics";
import {
  SettingsHostProvider,
  type MountPlaybackTerminal,
  type SettingsHostValue,
} from "@infrawrench/ui";
import { apiGet, apiGetText, apiPost, apiPut, apiPatch, apiDelete } from "@/lib/api";
import { usePermissions } from "@/auth/permissions-context";
import { createWebApprovalsClient } from "@/lib/approvals-client";
import { dispatchChangeFreezeChanged } from "@/lib/change-freeze-events";

/**
 * xterm (about 290 KB) loads with the first recording opened, not with the
 * app: the recording player is its only user outside the terminal tabs, which
 * import it on demand already.
 */
const mountPlaybackTerminal: MountPlaybackTerminal = (container, geometry) =>
  import("@/lib/playback-terminal").then((m) => m.mountPlaybackTerminal(container, geometry));

/**
 * Web implementation of the settings host contract: cookie-auth fetch, the
 * org permissions context, and router navigation. The desktop app provides
 * its own host over the `cloud_settings_request` IPC proxy.
 */
export function WebSettingsHost({ orgId, children }: { orgId: string; children: ReactNode }) {
  const navigate = useNavigate();
  const { has, hasAny, loading, refresh } = usePermissions();

  const value = useMemo<SettingsHostValue>(
    () => ({
      orgId,
      api: {
        get: apiGet,
        post: apiPost,
        put: apiPut,
        patch: apiPatch,
        delete: apiDelete,
      },
      fetchText: apiGetText,
      readCheckoutMeasurement: readRevnuMeasurement,
      has,
      hasAny,
      permissionsLoading: loading,
      refreshPermissions: refresh,
      openExternal: (url, options) => {
        if (options?.sameTab) {
          window.location.href = url;
        } else {
          window.open(url, "_blank", "noopener,noreferrer");
        }
      },
      onAccountDeleted: () => {
        // Every session was revoked server-side and the cookie is cleared, so
        // the root route bounces to sign-in on its own.
        window.location.href = "/";
      },
      approvals: createWebApprovalsClient(orgId),
      openWorkspace: (surface) => {
        void navigate({ to: `/org/${orgId}/${surface}` });
      },
      openSection: (section) => {
        void navigate({ to: `/org/${orgId}/settings${section ? `/${section}` : ""}` });
      },
      onChangeFreezesChanged: dispatchChangeFreezeChanged,
      mountPlaybackTerminal,
    }),
    [orgId, has, hasAny, loading, refresh, navigate],
  );

  return <SettingsHostProvider value={value}>{children}</SettingsHostProvider>;
}
