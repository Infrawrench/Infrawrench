import { hostClient } from "@infrawrench/plugin-base/effect";
import { describe, expect, it } from "vitest";
import { OpenStackClient } from "../client.js";
import { APP, ok, transport } from "./harness.js";

describe("deleting a Swift folder", () => {
  const BUCKET_PATH = "/v1/AUTH_proj1/bucket";

  function folder(count: number, failOn?: string) {
    const names = Array.from({ length: count }, (_, i) => `dir/o${String(i).padStart(6, "0")}`);
    const deleted: string[] = [];
    const t = transport((r) => {
      if (r.method === "GET" && r.url.pathname === BUCKET_PATH) {
        const marker = r.url.searchParams.get("marker") ?? "";
        const limit = Number(r.url.searchParams.get("limit"));
        return ok(
          names
            .filter((n) => n > marker)
            .slice(0, limit)
            .map((name) => ({ name })),
        );
      }
      if (r.method === "DELETE" && r.url.pathname.startsWith(`${BUCKET_PATH}/`)) {
        const key = decodeURIComponent(r.url.pathname.slice(BUCKET_PATH.length + 1));
        if (key === failOn) return { status: 503 };
        deleted.push(key);
        return { status: 204 };
      }
      return undefined;
    });
    return { ...t, deleted };
  }

  it("deletes objects past the first listing page", async () => {
    const { http, deleted } = folder(10_001);
    await hostClient(new OpenStackClient(APP, { http })).deleteStorageObject("bucket", "dir/");
    expect(deleted).toHaveLength(10_002);
    expect(deleted).toContain("dir/o010000");
  });

  it("does not report success with an object left behind", async () => {
    const { http, deleted } = folder(3, "dir/o000001");
    await expect(
      hostClient(new OpenStackClient(APP, { http })).deleteStorageObject("bucket", "dir/"),
    ).rejects.toThrow("503");
    expect(deleted).not.toContain("dir/");
  });
});
