/**
 * GCP Node.js-side driver — runs in the Electron main process.
 * Owns all GCS-specific download logic so the host stays provider-agnostic.
 */
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import type { StorageNodeDriver } from "@infrawrench/plugin-base";

function downloadFile(bucket: string, key: string, accessToken: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(key)}?alt=media`;
    const req = https.get(url, { headers: { Authorization: `Bearer ${accessToken}` } }, (res: import("http").IncomingMessage) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode ?? "?"}`));
        return;
      }
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      const out = fs.createWriteStream(destPath);
      res.pipe(out);
      out.on("finish", () => { out.close(); resolve(); });
      out.on("error", (e: Error) => { fs.unlink(destPath, () => {}); reject(e); });
    });
    req.on("error", reject);
  });
}

export const nodeDriver = {
  pluginId: "gcp",
  downloadFile,
} satisfies StorageNodeDriver;
