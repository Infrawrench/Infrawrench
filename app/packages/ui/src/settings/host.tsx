import { createContext, useContext, type ReactNode } from "react";
import type { ApprovalsClient } from "../workflows/types.js";

/**
 * Transport the settings sections use for every API call. Paths are the same
 * `/api/...` strings the web app fetches; the desktop host proxies them over
 * a single allowlisted IPC channel to the cloud with the org's tokens.
 */
export interface SettingsApi {
  get<T>(path: string): Promise<T>;
  post<T = unknown>(path: string, body?: unknown): Promise<T>;
  put<T = unknown>(path: string, body?: unknown): Promise<T>;
  patch<T = unknown>(path: string, body?: unknown): Promise<T>;
  delete<T = unknown>(path: string): Promise<T>;
}

/**
 * Everything platform-specific the settings sections need, injected by the
 * host app. Web backs this with cookie-authenticated fetch and its
 * permissions context; desktop with the `cloud_settings_request` IPC proxy.
 */
export interface SettingsHostValue {
  orgId: string;
  api: SettingsApi;
  has(permission: string): boolean;
  hasAny(...permissions: string[]): boolean;
  /** True while the caller's role/permissions are still being fetched. */
  permissionsLoading: boolean;
  /** Re-fetch the caller's role/permissions (after role edits). */
  refreshPermissions(): Promise<void>;
  /**
   * Jump to another workspace surface — approvals link to the workflow run,
   * the drift/expiry cards link to the Changes and Expiring screens.
   */
  openWorkspace(surface: "workflows" | "changes" | "expiring"): void;
  /** Jump to another settings section (e.g. the team page's upgrade link). */
  openSection(section: string): void;
  /**
   * Open a URL outside the app shell — new tab on web, system browser on
   * desktop. Used for Stripe checkout/portal and password-reset links.
   * `sameTab` asks the web host to navigate the current tab instead (Stripe
   * checkout returns to the app); the desktop host ignores it — the system
   * browser is the only place those pages can go.
   */
  openExternal(url: string, options?: { sameTab?: boolean }): void;
  /** The account was deleted server-side; drop the session and leave. */
  onAccountDeleted(): void;
  /** Approvals inbox transport for the Approvals section. */
  approvals: ApprovalsClient;
  /** Change freezes were edited — hosts with a freeze banner refresh it. */
  onChangeFreezesChanged?: (() => void) | undefined;
  /**
   * The cloud origin (`https://app.infrawrench.com`) when the app shell is not
   * served from it — the desktop host sets this so copy-paste snippets (the
   * bastion agent's websocket URL) point at the cloud, not the app shell.
   * Web leaves it unset and the sections derive from `window.location`.
   */
  cloudOrigin?: string | undefined;
}

const SettingsHostContext = createContext<SettingsHostValue | null>(null);

export function SettingsHostProvider({
  value,
  children,
}: {
  value: SettingsHostValue;
  children: ReactNode;
}) {
  return <SettingsHostContext.Provider value={value}>{children}</SettingsHostContext.Provider>;
}

export function useSettingsHost(): SettingsHostValue {
  const ctx = useContext(SettingsHostContext);
  if (!ctx) {
    throw new Error("useSettingsHost must be used within a <SettingsHostProvider>");
  }
  return ctx;
}

/**
 * Conditionally render `children` only when the current user has the given
 * permission (or any of the listed `any` permissions). Same contract as the
 * web app's `<Can>`, but reading the injected settings host.
 */
export function SettingsCan({
  permission,
  any,
  fallback = null,
  children,
}: {
  permission?: string;
  any?: string[];
  fallback?: ReactNode;
  children: ReactNode;
}) {
  const { has, hasAny } = useSettingsHost();
  const allowed = permission ? has(permission) : any ? hasAny(...any) : true;
  return <>{allowed ? children : fallback}</>;
}
