import { invoke } from "./invoke";

let cachedHttpUrl: string | null = null;

async function getCloudHttpUrl(): Promise<string> {
  if (cachedHttpUrl) return cachedHttpUrl;
  cachedHttpUrl = await invoke<string>("cloud_get_url");
  return cachedHttpUrl;
}

/**
 * Returns the `ws://` (dev) or `wss://` (prod) URL origin for the cloud
 * WebSocket endpoint, without a trailing slash. The renderer has to cross
 * the IPC boundary to learn it (the URL is declared in `env.ts` on the
 * electron side).
 */
export async function getCloudWsUrl(): Promise<string> {
  const http = await getCloudHttpUrl();
  return http.replace(/^http/, "ws");
}
