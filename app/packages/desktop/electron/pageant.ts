import { exec } from "node:child_process";

const CACHE_TTL_MS = 5_000;
let cached: { value: boolean; expiresAt: number } | null = null;

export async function isPageantRunning(): Promise<boolean> {
  if (process.platform !== "win32") return false;

  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.value;

  const running = await new Promise<boolean>((resolve) => {
    exec(
      'tasklist /FI "IMAGENAME eq pageant.exe" /NH /FO CSV',
      { timeout: 2000, windowsHide: true },
      (err, stdout) => {
        if (err) {
          resolve(false);
          return;
        }
        resolve(stdout.toLowerCase().includes("pageant.exe"));
      },
    );
  });

  cached = { value: running, expiresAt: now + CACHE_TTL_MS };
  return running;
}
