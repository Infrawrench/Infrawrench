import { getAccessToken, forceRefreshAccessToken } from "../cloud-tokens";
import { CLOUD_URL } from "../../env";

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
