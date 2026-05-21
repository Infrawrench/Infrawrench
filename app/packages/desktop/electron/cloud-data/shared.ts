import { getAccessToken, forceRefreshAccessToken } from "../cloud-auth";
import { CLOUD_URL } from "../../env";
import { promptHostKeyDecision } from "../ssh-host-key-prompt";

interface HostKeyTrustRequiredBody {
  error: "ssh_host_key_trust_required";
  message?: string;
  kind: "unknown" | "mismatch";
  host: string;
  port: number;
  presentedFingerprint: string;
  storedFingerprint?: string | null;
}

function isHostKeyTrustRequired(body: unknown): body is HostKeyTrustRequiredBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  return (
    b.error === "ssh_host_key_trust_required" &&
    typeof b.host === "string" &&
    typeof b.port === "number" &&
    typeof b.presentedFingerprint === "string" &&
    (b.kind === "unknown" || b.kind === "mismatch")
  );
}

// On 409 ssh_host_key_trust_required: prompt the user, POST /trust on accept,
// then retry once. `buildInit` is a factory so FormData (a one-shot stream) is
// rebuilt for the retry.
export async function fetchWithHostKeyPrompt(
  orgId: string,
  url: string,
  buildInit: () => RequestInit | Promise<RequestInit>,
  token: string,
): Promise<Response> {
  const init = await buildInit();
  const res = await fetch(url, init);
  if (res.status !== 409) return res;

  // Clone first so we can return the original response if this isn't a host-key 409.
  const cloned = res.clone();
  let body: unknown;
  try {
    body = await cloned.json();
  } catch {
    return res;
  }
  if (!isHostKeyTrustRequired(body)) return res;

  const promptKind = body.kind === "unknown" ? "first-connect" : "mismatch";
  const accepted = await promptHostKeyDecision({
    host: body.host,
    port: body.port,
    kind: promptKind,
    presentedFingerprint: body.presentedFingerprint,
    ...(body.storedFingerprint ? { storedFingerprint: body.storedFingerprint } : {}),
  });
  if (!accepted) return res;

  const trustRes = await fetch(
    `${CLOUD_URL}/api/org/${encodeURIComponent(orgId)}/ssh-host-keys/trust`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        host: body.host,
        port: body.port,
        fingerprint: body.presentedFingerprint,
        ...(body.storedFingerprint ? { previousFingerprint: body.storedFingerprint } : {}),
      }),
    },
  );
  if (!trustRes.ok) {
    // If /trust raced and 409'd again, surface that instead of looping.
    return trustRes;
  }

  const retryInit = await buildInit();
  return fetch(url, retryInit);
}

export async function cloudFetch<T>(
  orgId: string,
  path: string,
  init: RequestInit = {},
): Promise<T | null> {
  let token = await getAccessToken();
  if (!token) throw new Error("Not authenticated to Infrawrench Cloud");
  const url = `${CLOUD_URL}/api/org/${encodeURIComponent(orgId)}${path}`;
  const buildInit = (t: string): RequestInit => ({
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${t}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  let res = await fetch(url, buildInit(token));
  if (res.status === 401) {
    const refreshed = await forceRefreshAccessToken();
    if (!refreshed) throw new Error("Authentication expired; please sign in again");
    token = refreshed;
    res = await fetch(url, buildInit(token));
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Cloud request failed: ${res.status} ${path} ${text}`);
  }
  if (res.status === 204) return null;
  return (await res.json()) as T;
}
