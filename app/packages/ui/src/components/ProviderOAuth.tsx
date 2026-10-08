import { useCallback, useEffect, useRef, useState } from "react";
import { useGT } from "gt-react";
import type { AccountOAuthStatus } from "@infrawrench/client-core";
import { formatErrorMessage } from "../utils.js";
import { useDataString } from "../i18n/data-strings.js";
import { ExternalLinkIcon, WarningIcon } from "./icons/ChromeIcons.js";

/**
 * What a host can do with a plugin's provider OAuth ("Connect with X"),
 * carried on `PluginInfo.oauth`. Present only when this host can actually run
 * the flow (a client id is configured for it), so its presence alone decides
 * whether the Connect button shows.
 */
export interface ProviderOAuthInfo {
  /** What the granted token can do. `full` gets a note before consent. */
  access: "read-only" | "read-write" | "full";
  refresh: "rotating" | "reusable" | "none";
  /** Provider page explaining the consent, linked next to the button. */
  docsUrl?: string;
  /**
   * Credential field that receives the access token. Optional so an older
   * server listing still type-checks; the UI then falls back to the first
   * sensitive field.
   */
  tokenField?: string;
  /** Clients the server can run, when the listing reports them. Informational. */
  clients?: Array<"server" | "desktop">;
}

/** What a completed connection hands back to the form. */
export interface ProviderOAuthResult {
  /** Token field, the host-owned `__oauth` grant, and any identity fields the plugin pre-filled. */
  credentials: Record<string, string>;
  /** Suggested account display name. */
  accountName?: string;
}

/**
 * Host callback that runs the provider consent flow (a popup on web, the
 * system browser on desktop) and resolves with the credentials to save.
 *
 * Reject with an error named `AbortError` when the user cancelled (closed the
 * window, pressed Cancel): the form then goes quietly back to idle instead of
 * showing an error.
 */
export type ConnectProviderOAuth = (
  pluginId: string,
  opts: { accountId?: string },
) => Promise<ProviderOAuthResult>;

/** True for a rejection that means "the user cancelled", not a failure. */
export function isProviderOAuthCancelled(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { name?: unknown }).name === "AbortError";
}

/**
 * Field that carries the OAuth access token: the declared `tokenField`, or the
 * first sensitive field when the listing predates it.
 */
export function oauthTokenFieldKey(plugin: {
  oauth?: ProviderOAuthInfo | null | undefined;
  credentialFields: Array<{ key: string; sensitive?: boolean }>;
}): string | undefined {
  return plugin.oauth?.tokenField ?? plugin.credentialFields.find((f) => f.sensitive)?.key;
}

/**
 * Pending/error bookkeeping around a host's `connectOAuth`. `connect` calls the
 * host synchronously, inside the click that triggered it, so a web host can
 * open its popup without tripping the browser's popup blocker. A result that
 * lands after `cancel()` or unmount is dropped.
 */
export function useProviderOAuthConnect(
  connectOAuth: ConnectProviderOAuth | undefined,
  cancelOAuth?: () => void,
) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const pendingRef = useRef(false);
  const cancelRef = useRef(cancelOAuth);
  useEffect(() => {
    cancelRef.current = cancelOAuth;
  }, [cancelOAuth]);

  // Closing the form mid-flow abandons the flow (closes the popup).
  useEffect(
    () => () => {
      generation.current += 1;
      if (pendingRef.current) cancelRef.current?.();
    },
    [],
  );

  const connect = useCallback(
    async (pluginId: string, opts: { accountId?: string } = {}) => {
      if (!connectOAuth) return null;
      const run = ++generation.current;
      pendingRef.current = true;
      setPending(true);
      setError(null);
      try {
        const result = await connectOAuth(pluginId, opts);
        if (run !== generation.current) return null;
        return result;
      } catch (e) {
        if (run === generation.current && !isProviderOAuthCancelled(e)) {
          setError(formatErrorMessage(e));
        }
        return null;
      } finally {
        if (run === generation.current) {
          pendingRef.current = false;
          setPending(false);
        }
      }
    },
    [connectOAuth],
  );

  const cancel = useCallback(() => {
    generation.current += 1;
    pendingRef.current = false;
    setPending(false);
    cancelOAuth?.();
  }, [cancelOAuth]);

  return { pending, error, setError, connect, cancel };
}

function CheckIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function DocsLink({
  url,
  label,
  onOpenExternal,
}: {
  url: string;
  label: string;
  onOpenExternal?: ((url: string) => void) | undefined;
}) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={
        onOpenExternal
          ? (e) => {
              e.preventDefault();
              onOpenExternal(url);
            }
          : undefined
      }
      className="inline-flex items-center gap-1 text-xs text-info hover:text-info-strong"
    >
      {label}
      <ExternalLinkIcon size={12} />
    </a>
  );
}

/** The "full access" caveat shown before consent. */
function FullAccessNote({ provider }: { provider: string }) {
  const gt = useGT();
  return (
    <div className="rounded-lg bg-amber-500/10 border border-amber-500/40 px-3 py-2 flex gap-2">
      <WarningIcon size={14} className="text-warning flex-shrink-0 mt-px" />
      <p className="text-xs text-warning leading-relaxed">
        {gt("{provider} only offers full-access tokens. Infrawrench only reads unless you act.", {
          provider,
        })}
      </p>
    </div>
  );
}

interface ConnectPanelProps {
  plugin: { id: string; displayName: string; logoSvg: string; oauth: ProviderOAuthInfo };
  pending: boolean;
  error: string | null;
  onConnect: () => void;
  onCancel?: (() => void) | undefined;
  onOpenExternal?: ((url: string) => void) | undefined;
  /** `reconnect` relabels the button for an existing account. */
  mode?: "connect" | "reconnect";
}

/**
 * The prominent "Connect with {provider}" block that sits above the manual
 * credential form: the provider-branded button, the full-access caveat when it
 * applies, the provider's consent docs, and a Cancel while the flow is open.
 */
export function ProviderOAuthConnectPanel({
  plugin,
  pending,
  error,
  onConnect,
  onCancel,
  onOpenExternal,
  mode = "connect",
}: ConnectPanelProps) {
  const gt = useGT();
  const gtData = useDataString();
  const provider = gtData(plugin.displayName);
  const label =
    mode === "reconnect"
      ? gt("Reconnect with {provider}", { provider })
      : gt("Connect with {provider}", { provider });

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={onConnect}
        disabled={pending}
        aria-busy={pending}
        className="w-full flex items-center justify-center gap-2 px-3 py-2.5 text-sm font-medium text-on-surface-secondary bg-surface-overlay border border-border-strong rounded-lg hover:bg-surface-raised hover:text-on-surface disabled:opacity-60 transition-colors"
      >
        <span
          className="size-5 flex-shrink-0"
          aria-hidden="true"
          dangerouslySetInnerHTML={{ __html: plugin.logoSvg }}
        />
        <span>{pending ? gt("Waiting for {provider}…", { provider }) : label}</span>
      </button>
      {pending && (
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-on-surface-faint" role="status">
            {gt("Finish signing in to {provider} in the window that opened.", { provider })}
          </p>
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="text-xs text-on-surface-tertiary hover:text-on-surface-secondary flex-shrink-0"
            >
              {gt("Cancel")}
            </button>
          )}
        </div>
      )}
      {plugin.oauth.access === "full" && <FullAccessNote provider={provider} />}
      {plugin.oauth.docsUrl && (
        <DocsLink
          url={plugin.oauth.docsUrl}
          label={gt("What {provider} asks you to grant", { provider })}
          onOpenExternal={onOpenExternal}
        />
      )}
      {error && (
        <p className="text-xs text-danger" role="alert">
          {gt("Couldn't connect {provider}: {message}", { provider, message: error })}
        </p>
      )}
    </div>
  );
}

/** "or enter credentials manually" rule between the Connect button and the form. */
export function ProviderOAuthDivider() {
  const gt = useGT();
  return (
    <div className="flex items-center gap-3" role="separator">
      <div className="h-px flex-1 bg-border" />
      <span className="text-xs text-on-surface-faint">{gt("or enter credentials manually")}</span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

interface ConnectedChipProps {
  /** Provider display name (translated through the data-string lookup here). */
  providerName: string;
  /** Field label, for the accessible group name. */
  fieldLabel: string;
  /** `reconnect_required` renders the chip as a warning. */
  status?: AccountOAuthStatus | "pending-save";
  onUseToken: () => void;
  onReconnect?: (() => void) | undefined;
  reconnecting?: boolean;
}

/**
 * Stands in for the token input on an OAuth-connected credential: a chip that
 * says the token comes from the provider connection, with Reconnect (when the
 * host can run the flow) and "Use a token instead" (back to a pasted token).
 */
export function ProviderOAuthConnectedChip({
  providerName,
  fieldLabel,
  status = "connected",
  onUseToken,
  onReconnect,
  reconnecting = false,
}: ConnectedChipProps) {
  const gt = useGT();
  const gtData = useDataString();
  const broken = status === "reconnect_required";
  const text =
    status === "pending-save"
      ? gt("Connected to {provider}", { provider: gtData(providerName) })
      : broken
        ? gt("Reconnect needed")
        : gt("Connected via OAuth");
  return (
    <div
      role="group"
      aria-label={fieldLabel}
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5"
    >
      <span
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${
          broken
            ? "border-amber-500/40 bg-amber-500/10 text-warning"
            : "border-emerald-500/40 bg-emerald-500/10 text-success"
        }`}
      >
        {broken ? <WarningIcon size={12} /> : <CheckIcon size={12} />}
        {text}
      </span>
      {onReconnect && (
        <button
          type="button"
          onClick={onReconnect}
          disabled={reconnecting}
          className="text-xs text-info hover:text-info-strong disabled:opacity-60"
        >
          {reconnecting ? gt("Reconnecting…") : gt("Reconnect")}
        </button>
      )}
      <button
        type="button"
        onClick={onUseToken}
        className="text-xs text-on-surface-tertiary hover:text-on-surface-secondary"
      >
        {gt("Use a token instead")}
      </button>
    </div>
  );
}

interface ReconnectBannerProps {
  /** Provider display name (translated through the data-string lookup here). */
  providerName: string;
  /** Runs the reconnect flow. Omitted when this host cannot run it. */
  onReconnect?: (() => void) | undefined;
  reconnecting?: boolean;
  /** Fallback when the host cannot reconnect: open the credentials editor. */
  onUpdateCredentials?: (() => void) | undefined;
  className?: string;
}

/**
 * Account-level banner for `oauthStatus === "reconnect_required"`: the
 * provider revoked or expired the grant, syncs fail until the user reconnects.
 */
export function ProviderOAuthReconnectBanner({
  providerName,
  onReconnect,
  reconnecting = false,
  onUpdateCredentials,
  className = "",
}: ReconnectBannerProps) {
  const gt = useGT();
  const gtData = useDataString();
  const provider = gtData(providerName);
  return (
    <div
      role="status"
      className={`rounded-lg bg-amber-500/10 border border-amber-500/40 px-3 py-2.5 flex items-start gap-2 ${className}`}
    >
      <WarningIcon size={14} className="text-warning flex-shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-warning">
          {gt("Reconnect {provider}", { provider })}
        </p>
        <p className="text-xs text-warning/90 leading-relaxed">
          {onReconnect
            ? gt(
                "The connection was revoked or expired, so this account can't sync until you reconnect it.",
              )
            : gt(
                "The connection was revoked or expired. Update the credentials with a token to keep this account syncing.",
              )}
        </p>
      </div>
      {onReconnect ? (
        <button
          type="button"
          onClick={onReconnect}
          disabled={reconnecting}
          className="flex-shrink-0 px-2.5 py-1 text-xs font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-md transition-colors"
        >
          {reconnecting ? gt("Reconnecting…") : gt("Reconnect")}
        </button>
      ) : onUpdateCredentials ? (
        <button
          type="button"
          onClick={onUpdateCredentials}
          className="flex-shrink-0 px-2.5 py-1 text-xs font-medium border border-border-strong text-on-surface-secondary hover:bg-surface-overlay rounded-md transition-colors"
        >
          {gt("Update credentials")}
        </button>
      ) : null}
    </div>
  );
}

interface ReconnectBadgeProps {
  /** Account name, for the accessible label. */
  accountName: string;
  onReconnect?: (() => void) | undefined;
  reconnecting?: boolean;
}

/**
 * Compact reconnect-needed marker for list rows (sidebars). A small warning
 * button when the host can reconnect, otherwise a static label.
 */
export function ProviderOAuthReconnectBadge({
  accountName,
  onReconnect,
  reconnecting = false,
}: ReconnectBadgeProps) {
  const gt = useGT();
  const className =
    "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium leading-none text-warning bg-amber-500/10 border border-amber-500/40 flex-shrink-0";
  if (!onReconnect) {
    return (
      <span className={className} title={gt("Reconnect needed")}>
        <WarningIcon size={10} />
        {gt("Reconnect")}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onReconnect();
      }}
      disabled={reconnecting}
      aria-label={gt("Reconnect {account}", { account: accountName })}
      className={`${className} hover:bg-amber-500/20 disabled:opacity-60`}
    >
      <WarningIcon size={10} />
      {reconnecting ? gt("Reconnecting…") : gt("Reconnect")}
    </button>
  );
}
