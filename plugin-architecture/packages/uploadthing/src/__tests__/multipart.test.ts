import { describe, expect, it } from "vitest";
import { buildMultipartFileBody } from "../multipart.js";

describe("buildMultipartFileBody", () => {
  it("encodes a single file part with a Content-Type that carries the boundary", () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    const { contentType, body } = buildMultipartFileBody({
      name: "file",
      fileName: "pic.png",
      contentType: "image/png",
      data,
    });

    expect(contentType).toMatch(/^multipart\/form-data; boundary=----infrawrench/);
    const boundary = contentType.slice("multipart/form-data; boundary=".length);
    const text = new TextDecoder().decode(body);
    expect(text.startsWith(`--${boundary}\r\n`)).toBe(true);
    expect(text).toContain('Content-Disposition: form-data; name="file"; filename="pic.png"');
    expect(text).toContain("Content-Type: image/png");
    expect(text.endsWith(`--${boundary}--\r\n`)).toBe(true);
    // Payload bytes sit between the header blank line and the closing boundary.
    const headerEnd =
      body.indexOf(0x0a) >= 0 ? indexOfSubarray(body, new Uint8Array([13, 10, 13, 10])) : -1;
    expect(headerEnd).toBeGreaterThan(0);
    expect(Array.from(body.slice(headerEnd + 4, headerEnd + 8))).toEqual([1, 2, 3, 4]);
  });

  it("strips quotes from the filename rather than breaking the header", () => {
    const { body } = buildMultipartFileBody({
      name: "file",
      fileName: 'weird"name.png',
      contentType: "application/octet-stream",
      data: new Uint8Array([9]),
    });
    const text = new TextDecoder().decode(body);
    expect(text).toContain('filename="weirdname.png"');
    expect(text).not.toContain('filename="weird"name.png"');
  });
});

function indexOfSubarray(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}
