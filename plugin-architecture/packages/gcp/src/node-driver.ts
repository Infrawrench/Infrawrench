/**
 * GCP Node.js-side driver: runs in the Electron main process.
 * Owns all GCS-specific download logic so the host stays provider-agnostic.
 */
import { attemptFn } from "@infrawrench/plugin-base/effect";
import { defineNodeDrivers } from "@infrawrench/plugin-base";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import type { StorageNodeDriver } from "@infrawrench/plugin-base";

function downloadFile(
  bucket: string,
  key: string,
  accessToken: string,
  destPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(key)}?alt=media`;
    const req = https.get(
      url,
      { headers: { Authorization: `Bearer ${accessToken}` } },
      (res: import("http").IncomingMessage) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode ?? "?"}`));
          return;
        }
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        const out = fs.createWriteStream(destPath);
        res.pipe(out);
        out.on("finish", () => {
          out.close();
          resolve();
        });
        out.on("error", (e: Error) => {
          fs.unlink(destPath, () => {});
          reject(e);
        });
      },
    );
    req.on("error", reject);
  });
}

export const nodeDriver = {
  pluginId: "gcp",
  downloadFile: attemptFn(downloadFile),
} satisfies StorageNodeDriver;

/**
 * What this plugin contributes to each kind of host. See `PluginNodeDrivers`.
 */
export const nodeDrivers = defineNodeDrivers({
  desktop: { storage: nodeDriver },
  server: { storage: nodeDriver },
});
