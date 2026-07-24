import { ipcMain } from "electron";
import { getAccessToken, forceRefreshAccessToken } from "../cloud-auth";
import { CLOUD_URL } from "../../env";
import { promptHostKeyDecision } from "../ssh-host-key-prompt";

interface CloudHostKeyTrustRequest {
  orgId: string;
  host: string;
  port: number;
  kind: "unknown" | "mismatch";
  presentedFingerprint: string;
  storedFingerprint?: string | null;
}

/**
 * WS-proxy SSH shells can't ride fetchWithHostKeyPrompt (the trust-required
 * signal arrives as an `ssh:error` frame, not a 409), so the renderer invokes
 * this instead: show the native host-key prompt and, on accept, record the pin
 * in the org's cloud trust store. Returns whether the key is now trusted.
 */
ipcMain.handle(
  "cloud_ssh_host_key_trust",
  async (_e, req: CloudHostKeyTrustRequest): Promise<boolean> => {
    const accepted = await promptHostKeyDecision({
      host: req.host,
      port: req.port,
      kind: req.kind === "unknown" ? "first-connect" : "mismatch",
      presentedFingerprint: req.presentedFingerprint,
      ...(req.storedFingerprint ? { storedFingerprint: req.storedFingerprint } : {}),
    });
    if (!accepted) return false;

    const url = `${CLOUD_URL}/api/org/${encodeURIComponent(req.orgId)}/ssh-host-keys/trust`;
    const post = (token: string) =>
      fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          host: req.host,
          port: req.port,
          fingerprint: req.presentedFingerprint,
          ...(req.storedFingerprint ? { previousFingerprint: req.storedFingerprint } : {}),
        }),
      });

    let token = await getAccessToken();
    if (!token) return false;
    let res = await post(token);
    if (res.status === 401) {
      token = await forceRefreshAccessToken();
      if (!token) return false;
      res = await post(token);
    }
    return res.ok;
  },
);
