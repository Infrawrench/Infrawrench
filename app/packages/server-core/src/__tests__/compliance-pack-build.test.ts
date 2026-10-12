import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import {
  SOC2_FRAMEWORK,
  computeComplianceControls,
  toFrameworkSummary,
  type EvidenceSourceResult,
} from "@infrawrench/client-core";

const chain = {
  select: () => chain,
  from: () => chain,
  where: async () => [{ displayName: "Acme" }],
};
vi.mock("../db/client", () => ({ db: chain }));

vi.mock("../compliance/status", () => {
  const sources = [...new Set(SOC2_FRAMEWORK.controls.flatMap((c) => c.sources))];
  const results: EvidenceSourceResult[] = sources.map((sourceId) => ({
    sourceId,
    label: sourceId,
    kind: sourceId === "audit-log" ? "period" : "snapshot",
    status: sourceId === "posture" ? "gap" : "present",
    summary: `${sourceId} ok`,
    metrics: [{ key: "n", label: "Count", value: 3 }],
    gaps: sourceId === "posture" ? ["1 critical finding"] : [],
    itemCount: 1,
    error: null,
  }));
  const { controls, counts } = computeComplianceControls({
    framework: SOC2_FRAMEWORK,
    results,
    settings: [],
  });
  return {
    collectComplianceEvidence: async () => ({
      framework: SOC2_FRAMEWORK,
      collections: new Map(
        results.map((r) => [r.sourceId, { result: r, csv: '"a"\r\n"=1"\r\n', json: { rows: 1 } }]),
      ),
      status: {
        framework: toFrameworkSummary(SOC2_FRAMEWORK),
        period: { from: "2026-07-01", to: "2026-09-30" },
        controls,
        sources: results,
        counts,
        generatedAt: "2026-10-01T00:00:00.000Z",
      },
    }),
  };
});

const { buildEvidencePack } = await import("../compliance/pack");

function unzip(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endAt = bytes.length - 22;
  let at = view.getUint32(endAt + 16, true);
  const out = new Map<string, Uint8Array>();
  for (let i = 0; i < view.getUint16(endAt + 10, true); i++) {
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen));
    const start = local + 30 + view.getUint16(local + 26, true);
    const body = bytes.subarray(start, start + size);
    out.set(name, method === 8 ? new Uint8Array(inflateRawSync(body)) : body);
    at += 46 + nameLen;
  }
  return out;
}

describe("buildEvidencePack", () => {
  it("writes every file with a manifest hash that matches its bytes", async () => {
    const pack = await buildEvidencePack("org-1", "soc2", {
      period: { from: "2026-07-01", to: "2026-09-30" },
      canRead: null,
      generatedBy: "Scheduled delivery",
      now: new Date("2026-10-01T00:00:00Z"),
    });
    expect(pack.filename).toBe("soc2-evidence-2026-07-01-to-2026-09-30.zip");
    const files = unzip(pack.bytes);
    expect(files.has("summary.pdf")).toBe(true);
    expect(new TextDecoder().decode(files.get("summary.pdf")!.subarray(0, 5))).toBe("%PDF-");
    expect(files.has("controls/CC6.1.csv")).toBe(true);
    expect(files.has("controls/A1.3.json")).toBe(true);
    expect(files.has("evidence/vulnerabilities.csv")).toBe(true);
    expect(files.has("evidence/scorecards.csv")).toBe(true);
    expect(files.has("evidence/leaked-credentials.csv")).toBe(true);

    const manifest = JSON.parse(new TextDecoder().decode(files.get("manifest.json")!));
    expect(manifest.organization).toEqual({ id: "org-1", name: "Acme" });
    expect(manifest.counts.gaps).toBeGreaterThan(0);
    expect(manifest.snapshotSources).toContain("posture");
    for (const f of manifest.files as Array<{ path: string; sha256: string; bytes: number }>) {
      const data = files.get(f.path);
      expect(data, f.path).toBeDefined();
      expect(createHash("sha256").update(data!).digest("hex")).toBe(f.sha256);
      expect(data!.length).toBe(f.bytes);
    }
    const sums = new TextDecoder().decode(files.get("SHA256SUMS")!);
    const manifestHash = createHash("sha256").update(files.get("manifest.json")!).digest("hex");
    expect(sums.split("\n")[0]).toBe(`${manifestHash}  manifest.json`);
  });
});
