/**
 * Throughput of the hot paths, printed rather than asserted: the numbers in
 * NOTES.md come from here. Skipped unless GIT_CORE_BENCH is set, so a
 * loaded machine cannot fail the suite.
 */
import { createHash } from "node:crypto";
import zlib from "node:zlib";
import { describe, it } from "vitest";
import {
  Sha1,
  adler32,
  applyDelta,
  crc32,
  createDelta,
  deflate,
  encodePktLine,
  decodePktLines,
  inflateSync,
  sha1,
} from "../src";
import { prng, randomBytes } from "./helpers";

function rate(label: string, bytes: number, run: () => void, rounds = 5): void {
  let best = Infinity;
  for (let i = 0; i < rounds; i++) {
    const started = performance.now();
    run();
    best = Math.min(best, performance.now() - started);
  }
  console.log(
    `${label.padEnd(44)} ${(bytes / 2 ** 20 / (best / 1000)).toFixed(0).padStart(6)} MiB/s`,
  );
}

function sourceText(bytes: number): Uint8Array {
  const next = prng(1);
  const words = [
    "const",
    "function",
    "return",
    "import",
    "export",
    "value",
    "result",
    "index",
    "await",
  ];
  let out = "";
  while (out.length < bytes) {
    out += `${"  ".repeat(next() % 4)}${words[next() % words.length]} ${words[next() % words.length]}_${next() % 500} = ${next() % 1000};\n`;
  }
  return new TextEncoder().encode(out.slice(0, bytes));
}

describe.skipIf(!process.env.GIT_CORE_BENCH)("throughput", () => {
  it("measures the hot paths", async () => {
    const size = 32 * 1024 * 1024;
    const random = randomBytes(size, prng(2));
    const text = sourceText(size);

    rate("sha1 (this package)", size, () => new Sha1().update(random).digest());
    rate("sha1, collision detection off (for scale)", size, () =>
      new Sha1({ detectCollisions: false }).update(random).digest(),
    );
    rate("sha1 (node:crypto, for scale)", size, () => createHash("sha1").update(random).digest());
    const started = performance.now();
    await sha1(random);
    console.log(
      `${"sha1 (crypto.subtle, one shot)".padEnd(44)} ${(size / 2 ** 20 / ((performance.now() - started) / 1000)).toFixed(0).padStart(6)} MiB/s`,
    );
    rate("crc32", size, () => crc32(random));
    rate("crc32 (node:zlib, for scale)", size, () => zlib.crc32(random));
    rate("adler32", size, () => adler32(random));

    for (const [name, data] of [
      ["source text", text],
      ["random bytes", random],
    ] as const) {
      const compressed = new Uint8Array(zlib.deflateSync(data));
      rate(`inflate ${name} (this package), output`, size, () => inflateSync(compressed, { size }));
      rate(`inflate ${name} (node:zlib, for scale)`, size, () => zlib.inflateSync(compressed));
    }

    // Many small streams, which is what a pack of source code is.
    const small: Uint8Array[] = [];
    let smallBytes = 0;
    for (let at = 0; smallBytes < 8 * 1024 * 1024; at += 700) {
      const piece = text.subarray(at, at + 300 + (at % 900));
      small.push(new Uint8Array(zlib.deflateSync(piece)));
      smallBytes += piece.length;
    }
    rate(`inflate ${small.length} small streams, output`, smallBytes, () => {
      for (const stream of small) inflateSync(stream);
    });
    rate(`same through node:zlib, for scale`, smallBytes, () => {
      for (const stream of small) zlib.inflateSync(stream);
    });

    const base = text.subarray(0, 4 * 1024 * 1024);
    const target = base.slice();
    for (let at = 5000; at < target.length; at += 40_000)
      target.set(random.subarray(at, at + 60), at);
    let delta: Uint8Array = new Uint8Array(0);
    rate("createDelta (4 MiB, edits every 40 KB)", target.length, () => {
      delta = createDelta(base, target);
    });
    console.log(`  delta is ${delta.length} bytes for a ${target.length} byte target`);
    rate("applyDelta", target.length, () => applyDelta(base, delta), 20);
    rate("createDelta (unrelated inputs)", 4 * 1024 * 1024, () =>
      createDelta(random.subarray(0, 4 << 20), random.subarray(4 << 20, 8 << 20)),
    );

    const line = encodePktLine(random.subarray(0, 60_000));
    const wire = new Uint8Array(line.length * 200);
    for (let i = 0; i < 200; i++) wire.set(line, i * line.length);
    rate("pkt-line decode", wire.length, () => decodePktLines(wire));

    const deflateStarted = performance.now();
    await deflate(text);
    console.log(
      `${"deflate (CompressionStream)".padEnd(44)} ${(size / 2 ** 20 / ((performance.now() - deflateStarted) / 1000)).toFixed(0).padStart(6)} MiB/s`,
    );
  });
});
