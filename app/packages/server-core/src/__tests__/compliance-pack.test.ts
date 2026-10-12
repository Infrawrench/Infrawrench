import { describe, expect, it } from "vitest";
import { inflateRawSync } from "node:zlib";
import { buildZip, crc32 } from "../compliance/zip";
import { nextReportSendAt } from "../report-delivery/compose";

/** Read a ZIP back through its central directory, the way unzip tools do. */
function readZip(bytes: Uint8Array): Map<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endAt = bytes.length - 22;
  expect(view.getUint32(endAt, true)).toBe(0x06054b50);
  const count = view.getUint16(endAt + 10, true);
  let at = view.getUint32(endAt + 16, true);
  const out = new Map<string, string>();
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const compressed = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const localAt = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLen));
    const localNameLen = view.getUint16(localAt + 26, true);
    const body = bytes.subarray(
      localAt + 30 + localNameLen,
      localAt + 30 + localNameLen + compressed,
    );
    const data = method === 8 ? new Uint8Array(inflateRawSync(body)) : body;
    expect(crc32(data)).toBe(crc);
    out.set(name, decoder.decode(data));
    at += 46 + nameLen;
  }
  return out;
}

describe("buildZip", () => {
  it("round-trips stored and deflated entries with correct CRCs", () => {
    const enc = new TextEncoder();
    const zip = buildZip([
      { path: "manifest.json", data: enc.encode(JSON.stringify({ a: "x".repeat(500) })) },
      { path: "controls/CC6.1.csv", data: enc.encode('"a"\r\n') },
      { path: "empty.txt", data: new Uint8Array() },
    ]);
    const files = readZip(zip);
    expect([...files.keys()]).toEqual(["manifest.json", "controls/CC6.1.csv", "empty.txt"]);
    expect(files.get("controls/CC6.1.csv")).toBe('"a"\r\n');
    expect(JSON.parse(files.get("manifest.json")!).a).toHaveLength(500);
  });

  it("matches the standard CRC-32 check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("is deterministic for the same inputs and timestamp", () => {
    const when = new Date("2026-10-01T00:00:00Z");
    const entries = [{ path: "a", data: new TextEncoder().encode("hello") }];
    expect(buildZip(entries, when)).toEqual(buildZip(entries, when));
  });
});

describe("quarterly pack schedules", () => {
  const base = { sendDay: 1, hour: 8, timezone: "UTC" } as const;
  it("fires on the chosen day of the first month of each quarter", () => {
    expect(
      nextReportSendAt(
        { ...base, cadence: "quarterly", sendDayOfMonth: 3 },
        new Date("2026-01-04T00:00:00Z"),
      ).toISOString(),
    ).toBe("2026-04-03T08:00:00.000Z");
    expect(
      nextReportSendAt(
        { ...base, cadence: "quarterly", sendDayOfMonth: 31 },
        new Date("2026-07-31T09:00:00Z"),
      ).toISOString(),
    ).toBe("2026-10-31T08:00:00.000Z");
  });
  it("leaves monthly schedules alone", () => {
    expect(
      nextReportSendAt(
        { ...base, cadence: "monthly", sendDayOfMonth: 3 },
        new Date("2026-01-04T00:00:00Z"),
      ).toISOString(),
    ).toBe("2026-02-03T08:00:00.000Z");
  });
});
