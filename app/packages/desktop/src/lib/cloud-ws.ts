import { DesktopRpcClient, runRpc } from "./rpc/client";

let cachedHttpUrl: string | null = null;

async function getCloudHttpUrl(): Promise<string> {
  if (cachedHttpUrl) return cachedHttpUrl;
  cachedHttpUrl = await runRpc(DesktopRpcClient.use((rpc) => rpc.CloudUrl()));
  return cachedHttpUrl;
}

/**
 * Returns the `ws://` (dev) or `wss://` (prod) URL origin for the cloud
 * WebSocket endpoint, without a trailing slash. The renderer has to cross
 * to the main process to learn it (the URL is declared in `env.ts` on the
 * electron side).
 */
export async function getCloudWsUrl(): Promise<string> {
  const http = await getCloudHttpUrl();
  return http.replace(/^http/, "ws");
}
