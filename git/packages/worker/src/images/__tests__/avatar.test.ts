import { describe, expect, it } from "vitest";
import { AVATAR_LIMITS, parseAvatarPath } from "@infrawrench/git-contract";
import {
  AVATAR_CONTENT_SECURITY_POLICY,
  type AvatarBucket,
  deleteStoredAvatar,
  readAvatarUpload,
  readStoredAvatar,
  serveAvatar,
  storeAvatar,
} from "../avatar";

const u32 = (value: number): number[] => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
];
const text = (value: string): number[] => [...value].map((char) => char.charCodeAt(0));

const png = (width = 256, height = 256): Uint8Array =>
  new Uint8Array([
    ...[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    ...u32(13),
    ...text("IHDR"),
    ...u32(width),
    ...u32(height),
    ...[8, 2, 0, 0, 0],
    ...u32(0),
    ...u32(0),
    ...text("IDAT"),
    ...u32(0),
  ]);

const base64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

/** The bucket as a map, with every key it was asked for. */
const bucket = () => {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string | undefined }>();
  const asked: string[] = [];
  const fake = {
    async get(key: string) {
      asked.push(key);
      const found = objects.get(key);
      if (!found) return null;
      return {
        size: found.bytes.length,
        body: new Blob([found.bytes as Uint8Array<ArrayBuffer>]).stream(),
        arrayBuffer: async () => found.bytes.buffer,
      };
    },
    async put(
      key: string,
      bytes: Uint8Array,
      options: { httpMetadata?: { contentType?: string } },
    ) {
      objects.set(key, { bytes, contentType: options.httpMetadata?.contentType });
      return null;
    },
    async delete(key: string) {
      objects.delete(key);
    },
  };
  return { objects, asked, bucket: fake as unknown as AvatarBucket };
};

const upload = (bytes: Uint8Array) => {
  const read = readAvatarUpload(base64(bytes));
  if (!read.ok) throw new Error(read.problem);
  return read;
};

describe("readAvatarUpload", () => {
  it("takes a picture by its bytes", () => {
    expect(readAvatarUpload(base64(png()))).toMatchObject({
      ok: true,
      image: { type: "image/png", width: 256, height: 256 },
    });
  });

  it("refuses what is not base64, not a picture, or past the limits", () => {
    expect(readAvatarUpload("data:image/png;base64,AAAA")).toEqual({
      ok: false,
      problem: "The picture is not valid base64",
    });
    const page = new TextEncoder().encode("<svg onload=alert(1)></svg><script>alert(1)</script>");
    expect(readAvatarUpload(base64(page))).toEqual({
      ok: false,
      problem: "The picture must be a PNG, JPEG or WebP image",
    });
    expect(readAvatarUpload(base64(png(4096, 4096)))).toMatchObject({ ok: false });
    const large = new Uint8Array(AVATAR_LIMITS.maxBytes + 1);
    large.set(png());
    let binary = "";
    for (let at = 0; at < large.length; at += 0x8000) {
      binary += String.fromCharCode(...large.subarray(at, at + 0x8000));
    }
    expect(readAvatarUpload(btoa(binary))).toMatchObject({ ok: false });
  });
});

describe("a stored picture", () => {
  it("is kept under its namespace, named by its content, as the type its bytes are", async () => {
    const { bucket: store, objects } = bucket();
    const path = await storeAvatar(store, "ns-1", upload(png()));
    const parsed = parseAvatarPath(path);
    expect(parsed?.namespaceId).toBe("ns-1");
    expect(parsed?.name).toMatch(/^[0-9a-f]{32}\.png$/);
    expect([...objects.keys()]).toEqual([`avatars/ns-1/${parsed!.name}`]);
    expect(objects.get(`avatars/ns-1/${parsed!.name}`)?.contentType).toBe("image/png");
    // The same file again is the same address; another file is another.
    expect(await storeAvatar(store, "ns-1", upload(png()))).toBe(path);
    expect(await storeAvatar(store, "ns-1", upload(png(128, 128)))).not.toBe(path);
  });

  it("is served from this site as an image and nothing else", async () => {
    const { bucket: store } = bucket();
    const path = await storeAvatar(store, "ns-1", upload(png()));
    const response = await serveAvatar(new Request(`https://git.example.test${path}`), store);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe(AVATAR_CONTENT_SECURITY_POLICY);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(png());

    const head = await serveAvatar(
      new Request(`https://git.example.test${path}`, { method: "HEAD" }),
      store,
    );
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("is public: a signed-out request with no headers reads it", async () => {
    const { bucket: store } = bucket();
    const path = await storeAvatar(store, "ns-1", upload(png()));
    const response = await serveAvatar(new Request(`https://git.example.test${path}`), store);
    expect(response.status).toBe(200);
  });

  it("answers 404 for a picture that is not there, and reads nothing else in the bucket", async () => {
    const { bucket: store, objects, asked } = bucket();
    objects.set("repos/r1/packs/secret.pack", { bytes: png(), contentType: undefined });
    const name = "0123456789abcdef0123456789abcdef.png";
    const get = (path: string, method = "GET") =>
      serveAvatar(new Request(`https://git.example.test${path}`, { method }), store);

    expect((await get(`/-/avatar/ns-1/${name}`)).status).toBe(404);
    expect(asked).toEqual([`avatars/ns-1/${name}`]);
    asked.length = 0;
    for (const path of [
      "/-/avatar/ns-1/secret.pack",
      "/-/avatar/..%2F..%2Frepos%2Fr1%2Fpacks/secret.pack",
      `/-/avatar/ns-1/${name}/x`,
      `/-/avatar/ns-1/${name.replace(".png", ".svg")}`,
      "/-/avatar/",
    ]) {
      expect((await get(path)).status, path).toBe(404);
    }
    // None of those reached the bucket at all.
    expect(asked).toEqual([]);
    expect((await get(`/-/avatar/ns-1/${name}`, "POST")).status).toBe(405);
  });

  it("is deleted only when it is that namespace's upload", async () => {
    const { bucket: store, objects } = bucket();
    const path = await storeAvatar(store, "ns-1", upload(png()));
    await deleteStoredAvatar(store, "ns-2", path);
    await deleteStoredAvatar(store, "ns-1", "https://avatars.example.com/a.png");
    await deleteStoredAvatar(store, "ns-1", null);
    expect(objects.size).toBe(1);
    await deleteStoredAvatar(store, "ns-1", path);
    expect(objects.size).toBe(0);
  });

  it("is read back for a link preview by its path alone", async () => {
    const { bucket: store } = bucket();
    const path = await storeAvatar(store, "ns-1", upload(png()));
    expect(await readStoredAvatar(store, path)).toEqual({ bytes: png(), type: "image/png" });
    expect(await readStoredAvatar(store, "/assets/bots/a.png")).toBeNull();
    expect(await readStoredAvatar(store, path.replace("ns-1", "ns-2"))).toBeNull();
  });
});
