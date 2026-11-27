import { describe, expect, it } from "vitest";
import {
  AVATAR_LIMITS,
  AVATAR_MAX_BASE64_LENGTH,
  avatarPath,
  decodeBase64,
  inspectAvatar,
  parseAvatarPath,
} from "../index";

const u32 = (value: number): number[] => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
];
const text = (value: string): number[] => [...value].map((char) => char.charCodeAt(0));

/** A PNG's signature and header, and optionally the chunk that makes it an animation. */
export const pngOf = (width: number, height: number, animated = false): Uint8Array =>
  new Uint8Array([
    ...[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    ...u32(13),
    ...text("IHDR"),
    ...u32(width),
    ...u32(height),
    ...[8, 2, 0, 0, 0],
    ...u32(0),
    ...(animated ? [...u32(8), ...text("acTL"), ...u32(2), ...u32(0), ...u32(0)] : []),
    ...u32(0),
    ...text("IDAT"),
    ...u32(0),
  ]);

const jpegOf = (width: number, height: number): Uint8Array =>
  new Uint8Array([
    ...[0xff, 0xd8],
    // An application segment before the frame, as a camera writes.
    ...[0xff, 0xe0, 0x00, 0x06, 0x4a, 0x46, 0x49, 0x46],
    ...[0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff],
    ...[3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1],
  ]);

const webpOf = (width: number, height: number, animated = false): Uint8Array => {
  const w = width - 1;
  const h = height - 1;
  return new Uint8Array([
    ...text("RIFF"),
    ...[22, 0, 0, 0],
    ...text("WEBP"),
    ...text("VP8X"),
    ...[10, 0, 0, 0],
    ...[animated ? 0x02 : 0, 0, 0, 0],
    ...[w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff],
    ...[h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff],
  ]);
};

describe("inspectAvatar", () => {
  it("reads what a picture is from its bytes", () => {
    expect(inspectAvatar(pngOf(512, 512))).toEqual({
      ok: true,
      image: { type: "image/png", width: 512, height: 512 },
    });
    expect(inspectAvatar(jpegOf(640, 480))).toEqual({
      ok: true,
      image: { type: "image/jpeg", width: 640, height: 480 },
    });
    expect(inspectAvatar(webpOf(300, 200))).toEqual({
      ok: true,
      image: { type: "image/webp", width: 300, height: 200 },
    });
  });

  it("refuses what is not one of the three, whatever it is called", () => {
    const refused = [
      new Uint8Array(),
      new TextEncoder().encode(
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      ),
      new TextEncoder().encode("<!doctype html><script>alert(1)</script>"),
      new TextEncoder().encode("GIF89a" + "\0".repeat(40)),
      // A PNG's signature with nothing a PNG has after it.
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(40).fill(0x41)]),
      // A JPEG that ends before its frame.
      new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]),
    ];
    for (const bytes of refused) {
      expect(inspectAvatar(bytes)).toEqual({
        ok: false,
        problem: "The picture must be a PNG, JPEG or WebP image",
      });
    }
  });

  it("refuses an animation", () => {
    for (const bytes of [pngOf(64, 64, true), webpOf(64, 64, true)]) {
      expect(inspectAvatar(bytes)).toEqual({
        ok: false,
        problem: "The picture must be a still image",
      });
    }
  });

  it("holds the limits: the file's size and each side", () => {
    const large = new Uint8Array(AVATAR_LIMITS.maxBytes + 1);
    large.set(pngOf(512, 512));
    expect(inspectAvatar(large)).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/1 MB/),
    });
    expect(inspectAvatar(pngOf(8, 512))).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/at least 16 pixels/),
    });
    expect(inspectAvatar(pngOf(512, 4096))).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/at most 2048 pixels/),
    });
    expect(inspectAvatar(pngOf(2048, 16)).ok).toBe(true);
  });
});

describe("decodeBase64", () => {
  it("answers the bytes, or null for anything that is not base64", () => {
    expect([...decodeBase64("aGVsbG8=")!]).toEqual(text("hello"));
    expect(decodeBase64("")).toEqual(new Uint8Array());
    for (const bad of ["aGVsbG8", "aGVs bG8=", "data:image/png;base64,AAAA", "====", "a-_b"]) {
      expect(decodeBase64(bad), bad).toBeNull();
    }
  });

  it("the upload's cap is the base64 of the largest file", () => {
    expect(AVATAR_MAX_BASE64_LENGTH).toBe(1_398_104);
  });
});

describe("avatarPath", () => {
  const name = "0123456789abcdef0123456789abcdef.png";

  it("round-trips a namespace's picture", () => {
    const path = avatarPath("3f2c1a9e-0000-4000-8000-000000000001", name);
    expect(path).toBe(`/-/avatar/3f2c1a9e-0000-4000-8000-000000000001/${name}`);
    expect(parseAvatarPath(path)).toEqual({
      namespaceId: "3f2c1a9e-0000-4000-8000-000000000001",
      name,
    });
  });

  it("names nothing else: no other folder, extension or depth", () => {
    for (const path of [
      `/-/avatar/ns/${name}/more`,
      `/-/avatar/ns/../repos/${name}`,
      `/-/avatar/ns%2F..%2Frepos/${name}`,
      `/-/avatar/ns/${name.replace(".png", ".svg")}`,
      `/-/avatar/ns/${name.replace(".png", ".html")}`,
      `/-/avatar/ns/${name.toUpperCase()}`,
      `/-/avatar//${name}`,
      `/-/avatar/ns/short.png`,
      `/-/image/ns/${name}`,
    ]) {
      expect(parseAvatarPath(path), path).toBeNull();
    }
  });
});
