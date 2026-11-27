/** The mock's profile edits refuse what the API refuses, with its sentences. */
import { describe, expect, it } from "vitest";
import { parseAvatarPath } from "@infrawrench/git-contract";
import { ApiError } from "../../api/client";
import { imageSrc, setOwnImageResolver } from "../../lib/safe-url";
import ci from "../handlers/ci";
import namespaces from "../handlers/namespaces";
import { mockAvatar } from "../profile-data";

const N = namespaces.namespaces!;

const u32 = (value: number): number[] => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
];
const text = (value: string): number[] => [...value].map((char) => char.charCodeAt(0));
const png = (side: number): string =>
  btoa(
    String.fromCharCode(
      ...[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      ...u32(13),
      ...text("IHDR"),
      ...u32(side),
      ...u32(side),
      ...[8, 2, 0, 0, 0],
      ...u32(0),
      ...u32(0),
      ...text("IDAT"),
      ...u32(0),
    ),
  );

async function failure(run: () => unknown): Promise<ApiError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("Expected a refusal");
}

describe("an organisation's picture in the mock", () => {
  it("is stored under the path the Worker would serve, and shown from there", async () => {
    const saved = await N.setAvatar!({
      params: { namespace: "acme" },
      payload: { image: png(64) },
    });
    expect(parseAvatarPath(saved.avatarUrl ?? "")).toMatchObject({ namespaceId: "ns_acme" });
    setOwnImageResolver(mockAvatar);
    expect(imageSrc(saved.avatarUrl)).toMatch(/^data:image\/png;base64,/);
    const removed = await N.removeAvatar!({ params: { namespace: "acme" } });
    expect(removed.avatarUrl).toBeNull();
    expect(mockAvatar(saved.avatarUrl ?? "")).toBeNull();
  });

  it("is refused for a person, and for a file that is no picture", async () => {
    const person = await failure(() =>
      N.setAvatar!({ params: { namespace: "mara" }, payload: { image: png(64) } }),
    );
    expect(person.status).toBe(400);
    expect(person.message).toMatch(/Infrawrench account/);
    const page = await failure(() =>
      N.setAvatar!({ params: { namespace: "acme" }, payload: { image: btoa("<svg/>") } }),
    );
    expect(page.message).toBe("The picture must be a PNG, JPEG or WebP image");
    const other = await failure(() =>
      N.setAvatar!({ params: { namespace: "jonas" }, payload: { image: png(64) } }),
    );
    expect(other.status).toBe(403);
  });
});

describe("a commit's checks in the mock", () => {
  it("name the run each came from", async () => {
    const combined = await ci.statuses!.forRef!({
      params: { owner: "acme", repo: "infra" },
      query: { ref: "main" },
    });
    expect(combined.statuses.length).toBeGreaterThan(0);
    for (const status of combined.statuses) {
      expect(status.runId).toEqual(expect.any(String));
      expect(status.targetUrl).toBe(`/acme/infra/ci/runs/${status.runId}`);
    }
  });
});
