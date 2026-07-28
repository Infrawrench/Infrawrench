import { describe, expect, it } from "vitest";
import { buildMultipartBody } from "../multipart.js";

function decode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("binary");
}

describe("buildMultipartBody", () => {
  it("emits a boundary that matches the Content-Type header", () => {
    const { contentType, body } = buildMultipartBody([
      { kind: "field", name: "model", value: "cohere-transcribe-03-2026" },
    ]);

    const match = /^multipart\/form-data; boundary=(.+)$/.exec(contentType);
    expect(match).toBeTruthy();
    const boundary = match![1]!;
    const text = decode(body);
    expect(text.startsWith(`--${boundary}\r\n`)).toBe(true);
    expect(text.endsWith(`--${boundary}--\r\n`)).toBe(true);
  });

  it("encodes plain fields with a form-data disposition", () => {
    const { body } = buildMultipartBody([
      { kind: "field", name: "model", value: "cohere-transcribe-03-2026" },
      { kind: "field", name: "language", value: "en" },
    ]);

    const text = decode(body);
    expect(text).toContain(
      'Content-Disposition: form-data; name="model"\r\n\r\ncohere-transcribe-03-2026\r\n',
    );
    expect(text).toContain('Content-Disposition: form-data; name="language"\r\n\r\nen\r\n');
  });

  it("encodes a file part with filename and content type, and preserves raw bytes", () => {
    const audio = Uint8Array.from([0x00, 0x0d, 0x0a, 0xff, 0x80, 0x2d, 0x2d]);
    const { body } = buildMultipartBody([
      { kind: "file", name: "file", fileName: "clip.wav", contentType: "audio/wav", data: audio },
    ]);

    const text = decode(body);
    expect(text).toContain(
      'Content-Disposition: form-data; name="file"; filename="clip.wav"\r\nContent-Type: audio/wav\r\n\r\n',
    );

    // The payload must survive byte-for-byte — including bytes that look like
    // CRLF or boundary dashes.
    const marker = "audio/wav\r\n\r\n";
    const start = text.indexOf(marker) + marker.length;
    expect(Array.from(body.subarray(start, start + audio.byteLength))).toEqual(Array.from(audio));
  });

  it("strips quotes and newlines that would break the disposition header", () => {
    const { body } = buildMultipartBody([
      {
        kind: "file",
        name: "file",
        fileName: 'ev"il\r\nname.wav',
        contentType: "audio/wav",
        data: new Uint8Array(0),
      },
    ]);

    const text = decode(body);
    expect(text).toContain('filename="evilname.wav"');
  });

  it("uses a fresh boundary on every call", () => {
    const a = buildMultipartBody([{ kind: "field", name: "x", value: "1" }]);
    const b = buildMultipartBody([{ kind: "field", name: "x", value: "1" }]);
    expect(a.contentType).not.toBe(b.contentType);
  });
});
