import { t } from "gt-react";
import type { ProviderOAuthResult } from "@infrawrench/ui";
import { apiGet, apiPost, apiPut } from "./api";

/**
 * Web half of provider OAuth ("Connect with X"). The server runs the flow as
 * a confidential client: `authorize` returns the provider's consent URL, the
 * provider redirects to the server's callback, and that page posts the result
 * back to this window (`window.opener.postMessage`) before closing itself.
 */

/** `type` of the callback page's message; also the BroadcastChannel name. */
export const PROVIDER_OAUTH_MESSAGE_TYPE = "infrawrench:provider-oauth";

const POPUP_NAME = "infrawrench-provider-oauth";
const POPUP_WIDTH = 600;
const POPUP_HEIGHT = 720;
/** How long a consent may take before the wait gives up. */
const TIMEOUT_MS = 10 * 60 * 1000;
/**
 * After the popup reports closed, how long to keep listening before treating
 * it as a cancel: the callback page posts and then closes itself, and the
 * message can land a beat after `closed` flips.
 */
const CLOSED_GRACE_MS = 1500;

interface CallbackPayload {
  type: typeof PROVIDER_OAUTH_MESSAGE_TYPE;
  ok: boolean;
  pluginId: string;
  credentials?: Record<string, string>;
  accountName?: string;
  error?: string;
}

function isCallbackPayload(data: unknown, pluginId: string): data is CallbackPayload {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { type?: unknown }).type === PROVIDER_OAUTH_MESSAGE_TYPE &&
    (data as { pluginId?: unknown }).pluginId === pluginId
  );
}

function abortError(message: string): Error {
  const e = new Error(message);
  e.name = "AbortError";
  return e;
}

/** Open the popup centred over this window. Must run inside the user's click. */
function openPopup(): Window | null {
  const left = Math.max(0, window.screenX + (window.outerWidth - POPUP_WIDTH) / 2);
  const top = Math.max(0, window.screenY + (window.outerHeight - POPUP_HEIGHT) / 2);
  return window.open(
    "about:blank",
    POPUP_NAME,
    `popup=yes,width=${POPUP_WIDTH},height=${POPUP_HEIGHT},left=${Math.round(left)},top=${Math.round(top)}`,
  );
}

let active: { cancel: () => void } | null = null;

/**
 * Run the provider consent in a popup and resolve with the credentials to
 * save (token field, the sealed `__oauth` grant, and any identity fields the
 * plugin pre-filled). Pass `accountId` to reconnect an existing account.
 *
 * The popup opens synchronously, before the `authorize` request, so it counts
 * as a direct result of the click and is not blocked; it is pointed at the
 * consent URL once the server returns it. Rejects with an `AbortError` when the
 * user closes the window or cancels.
 */
export function connectProviderOAuth(
  orgId: string,
  pluginId: string,
  opts: { accountId?: string } = {},
): Promise<ProviderOAuthResult> {
  active?.cancel();
  const popup = openPopup();
  if (!popup) {
    return Promise.reject(
      new Error(
        t("Your browser blocked the sign-in window. Allow pop-ups for this site, then try again."),
      ),
    );
  }

  return new Promise<ProviderOAuthResult>((resolve, reject) => {
    let settled = false;
    let closedTimer: ReturnType<typeof setTimeout> | undefined;
    // The callback page posts to its opener; the channel is a second path for
    // when the provider's pages cut the opener link (a strict
    // Cross-Origin-Opener-Policy), should the page also broadcast.
    const channel =
      typeof BroadcastChannel === "undefined"
        ? null
        : new BroadcastChannel(PROVIDER_OAUTH_MESSAGE_TYPE);

    const handle = {
      cancel: () => {
        if (settled) return;
        finish();
        closePopup();
        reject(abortError("Cancelled"));
      },
    };
    active = handle;

    function closePopup() {
      try {
        popup!.close();
      } catch {
        // Already gone, or no longer ours to close.
      }
    }

    function finish() {
      settled = true;
      window.removeEventListener("message", onMessage);
      channel?.close();
      clearInterval(poll);
      clearTimeout(timeout);
      if (closedTimer) clearTimeout(closedTimer);
      if (active === handle) active = null;
    }

    function accept(data: unknown) {
      if (settled || !isCallbackPayload(data, pluginId)) return;
      finish();
      closePopup();
      if (data.ok && data.credentials && typeof data.credentials === "object") {
        resolve({
          credentials: data.credentials,
          ...(data.accountName ? { accountName: data.accountName } : {}),
        });
      } else {
        reject(new Error(data.error || t("The provider did not complete the connection.")));
      }
    }

    function onMessage(event: MessageEvent) {
      // Only the server's callback page, served from this app's own origin,
      // may hand back credentials.
      if (event.origin !== window.location.origin) return;
      accept(event.data);
    }

    window.addEventListener("message", onMessage);
    if (channel) channel.onmessage = (event: MessageEvent) => accept(event.data);

    const poll = setInterval(() => {
      if (settled || closedTimer || !popup.closed) return;
      closedTimer = setTimeout(() => {
        if (settled) return;
        finish();
        reject(abortError("The sign-in window was closed"));
      }, CLOSED_GRACE_MS);
    }, 500);

    const timeout = setTimeout(() => {
      if (settled) return;
      finish();
      closePopup();
      reject(new Error(t("Timed out waiting for the provider. Try connecting again.")));
    }, TIMEOUT_MS);

    apiPost<{ url: string }>(
      `/api/org/${orgId}/provider-oauth/${encodeURIComponent(pluginId)}/authorize`,
      { returnTo: "web", ...(opts.accountId ? { accountId: opts.accountId } : {}) },
    )
      .then(({ url }) => {
        if (settled) return;
        popup.location.href = url;
      })
      .catch((e: unknown) => {
        if (settled) return;
        finish();
        closePopup();
        reject(e instanceof Error ? e : new Error(String(e)));
      });
  });
}

/** Abandon the in-flight connection, if any (closes its popup). */
export function cancelProviderOAuth(): void {
  active?.cancel();
}

/**
 * Reconnect an account whose grant was revoked or expired, outside the
 * credentials modal (sidebar badge, account banner): run the consent, then
 * save the result over the stored credentials through the usual PUT, so
 * pickers and other fields the user set survive.
 *
 * The consent starts before anything is awaited, keeping the popup inside the
 * click that asked for it.
 */
export async function reconnectProviderAccount(
  orgId: string,
  accountId: string,
  pluginId: string,
): Promise<void> {
  const result = await connectProviderOAuth(orgId, pluginId, { accountId });
  const current = await apiGet<Record<string, string>>(
    `/api/org/${orgId}/accounts/${accountId}/credentials`,
  );
  await apiPut(`/api/org/${orgId}/accounts/${accountId}/credentials`, {
    credentials: { ...current, ...result.credentials },
  });
}
