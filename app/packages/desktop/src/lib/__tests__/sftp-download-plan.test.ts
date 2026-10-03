import { describe, expect, it } from "vitest";
import { planSftpDownloads } from "../sftp-download-plan";

describe("planSftpDownloads", () => {
  it("keeps the layout beneath the base folder", () => {
    expect(planSftpDownloads(["/srv/a.txt", "/srv/logs/2026/b.log"], "/srv")).toEqual({
      downloads: [
        { remotePath: "/srv/a.txt", relativePath: "a.txt" },
        { remotePath: "/srv/logs/2026/b.log", relativePath: "logs/2026/b.log" },
      ],
      skipped: [],
    });
  });

  it("falls back to the basename outside the base folder", () => {
    expect(planSftpDownloads(["/other/c.txt"], "/srv/").downloads).toEqual([
      { remotePath: "/other/c.txt", relativePath: "c.txt" },
    ]);
  });

  it("skips names a hostile server could use to escape the destination", () => {
    const keys = [
      "/srv/ok.txt",
      "/srv/../../home/u/.bashrc",
      "/srv/..\\AppData\\Roaming\\x.bat",
      "/srv/C:x",
      "/srv/dir/..",
    ];
    const plan = planSftpDownloads(keys, "/srv");
    expect(plan.downloads).toEqual([{ remotePath: "/srv/ok.txt", relativePath: "ok.txt" }]);
    expect(plan.skipped).toEqual(keys.slice(1));
  });
});
