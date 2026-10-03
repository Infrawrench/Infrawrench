import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => os.tmpdir() },
  safeStorage: { isEncryptionAvailable: () => false },
}));

import {
  registerDialogBlessedPath,
  resolveBeneathFolder,
  resolveBlessedDownloadPath,
} from "../main-utils";

const picked = fs.mkdtempSync(path.join(os.tmpdir(), "iw-download-dest-"));
registerDialogBlessedPath(picked);

afterAll(() => fs.rmSync(picked, { recursive: true, force: true }));

describe("resolveBeneathFolder", () => {
  it("joins segments under the folder", () => {
    expect(resolveBeneathFolder(picked, ["a", "b.txt"])).toBe(path.join(picked, "a", "b.txt"));
  });

  it("rejects results outside or equal to the folder", () => {
    expect(resolveBeneathFolder(picked, ["..", "x"])).toBeNull();
    expect(resolveBeneathFolder(picked, ["a", "..", ".."])).toBeNull();
    expect(resolveBeneathFolder(picked, ["."])).toBeNull();
    expect(resolveBeneathFolder(picked, [path.resolve("/etc/passwd")])).toBeNull();
  });
});

describe("resolveBlessedDownloadPath", () => {
  it("resolves nested paths beneath a dialog-picked folder", async () => {
    await expect(resolveBlessedDownloadPath(picked, "logs/app.log")).resolves.toBe(
      path.join(picked, "logs", "app.log"),
    );
  });

  it("refuses a destination that did not come from a dialog", async () => {
    await expect(resolveBlessedDownloadPath(os.homedir(), "x.txt")).rejects.toThrow(
      /system dialog/,
    );
  });

  it("refuses traversal, Windows separators and drives in the relative path", async () => {
    for (const rel of ["../x", "a/../../x", "..\\Startup\\x.bat", "C:x", "/etc/passwd", "a\0b"]) {
      await expect(resolveBlessedDownloadPath(picked, rel)).rejects.toThrow(/unsafe/);
    }
  });
});
