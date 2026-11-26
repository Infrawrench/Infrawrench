#!/usr/bin/env node
/**
 * Writes `src/sha1dc-ubc.gen.ts` from `lib/ubc_check.c` of
 * https://github.com/cr-marcstevens/sha1collisiondetection (MIT).
 *
 *   node scripts/gen-sha1dc-ubc.mjs <path to ubc_check.c>
 *
 * That file is itself generated (by the reference's `parse_bitrel`), so it
 * is translated mechanically rather than retyped: the disturbance vector
 * table becomes typed arrays, and the body of `ubc_check` is kept line for
 * line. C's `uint32_t` arithmetic maps onto JavaScript's 32-bit integer
 * operators with one change: `>>` becomes `>>>`, so a shift never brings
 * the sign bit down. Every other operator in the body (`^ & | ~ << -`)
 * already works modulo 2^32, and a mask is only ever tested against zero.
 * Two things are added for speed and change no answer: the words are read
 * into locals first, and the function returns once the mask is zero.
 *
 * The script refuses input it does not fully understand instead of guessing.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const source = process.argv[2];
if (!source) {
  console.error("usage: node scripts/gen-sha1dc-ubc.mjs <path to ubc_check.c>");
  process.exit(2);
}
const c = readFileSync(source, "utf8").replace(/\r\n/g, "\n");

const fail = (message) => {
  console.error(`gen-sha1dc-ubc: ${message}`);
  process.exit(1);
};

// 1. The bit each disturbance vector has in the mask.
const bits = [];
for (const match of c.matchAll(
  /^static const uint32_t (DV_[A-Z]+_\d+_\d+_bit)\s*=\s*\(uint32_t\)\(1\) << (\d+);$/gm,
)) {
  bits.push({ name: match[1], bit: Number(match[2]) });
}
if (bits.length !== 32) fail(`expected 32 mask bits, found ${bits.length}`);
bits.forEach((entry, index) => {
  if (entry.bit !== index) fail(`mask bit ${entry.name} is out of order`);
});

// 2. The table: { dvType, dvK, dvB, testt, maski, maskb, { dm[80] } }.
const tableStart = c.indexOf("dv_info_t sha1_dvs[] =");
const tableEnd = c.indexOf("};", tableStart);
if (tableStart < 0 || tableEnd < 0) fail("sha1_dvs not found");
const vectors = [];
const row =
  /\{\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*\{([^}]*)\}\s*\}/g;
for (const match of c.slice(tableStart, tableEnd).matchAll(row)) {
  const [type, k, b, testt, maski, maskb] = match.slice(1, 7).map(Number);
  if (type === 0) continue; // the terminator
  const dm = match[7].split(",").map((word) => word.trim());
  if (dm.length !== 80 || dm.some((word) => !/^0x[0-9a-f]{8}$/.test(word)))
    fail(`bad dm for DV ${type},${k},${b}`);
  if (maski !== 0) fail("more than one mask word is not supported");
  const name = `DV_${type === 1 ? "I" : "II"}_${k}_${b}_bit`;
  if (bits[maskb]?.name !== name) fail(`${name} does not have mask bit ${maskb}`);
  vectors.push({ type, k, b, testt, maskb, dm });
}
if (vectors.length !== 32) fail(`expected 32 disturbance vectors, found ${vectors.length}`);
vectors.forEach((vector, index) => {
  if (vector.maskb !== index) fail("the table is not in mask-bit order");
});
const steps = [...new Set(vectors.map((vector) => vector.testt))].sort((a, b) => a - b);
if (steps.join(",") !== "58,65") fail(`recompression steps changed: ${steps.join(",")}`);

// 3. The body of ubc_check.
const open = "void ubc_check(const uint32_t W[80], uint32_t dvmask[1])\n{\n";
const bodyStart = c.indexOf(open);
const close = "\tdvmask[0]=mask;\n}";
const bodyEnd = c.indexOf(close, bodyStart);
if (bodyStart < 0 || bodyEnd < 0) fail("ubc_check not found");
let body = c.slice(bodyStart + open.length, bodyEnd);
const first = "\tuint32_t mask = ~((uint32_t)(0));\n";
if (!body.startsWith(first)) fail("ubc_check does not start as expected");
body = "\tlet mask = ~0;\n" + body.slice(first.length);
// Each word is read once into a local (`w35` .. `w64`): the conditions name
// every word many times, and a local costs no bounds check.
const used = [...new Set([...body.matchAll(/W\[(\d+)\]/g)].map((match) => Number(match[1])))].sort(
  (a, b) => a - b,
);
if (used.some((index) => index > 79)) fail("a condition reads past W[79]");
body = body.replace(/>>/g, ">>>").replace(/W\[(\d+)\]/g, "w$1");
// Nothing may be left but the operators and names accounted for above.
const residue = body
  .replace(/\bw\d+\b/g, "")
  .replace(/DV_[A-Z]+_\d+_\d+_bit/g, "")
  .replace(/\b(let|mask|if)\b/g, "")
  .replace(/>>>|<<|\|\||&=|[-^&|~!=(){};\s\d]/g, "");
if (residue !== "")
  fail(
    `ubc_check has syntax this script does not translate: ${JSON.stringify(residue.slice(0, 80))}`,
  );
// Every statement of the body only ever clears bits of the mask, so a mask
// that has reached zero stays zero, and for an ordinary block it reaches
// zero within the first few dozen tests. The reference runs on to the end
// regardless (some two hundred lines, most of them behind guards that then
// fail); here the function returns as soon as there is nothing left to
// clear, which is checked before each guarded test.
const statements = body.split("\n");
const lines = [];
let returns = 0;
for (const line of statements) {
  if (/^\tif \(mask & /.test(line)) {
    lines.push("\tif (mask === 0) return 0;");
    returns++;
  }
  lines.push(line);
}
if (returns < 10) fail("ubc_check is not shaped as expected (guarded tests)");
lines.splice(1, 0, ...used.map((index) => `\tconst w${index} = W[${index}]!;`));
body = lines
  .map((line) => line.replace(/\t/g, "  ").replace(/\s+$/, ""))
  .filter((line, index, lines) => line !== "" || lines[index - 1] !== "")
  .join("\n")
  .replace(/\n+$/, "");

const hexRows = (words, perRow) => {
  const rows = [];
  for (let i = 0; i < words.length; i += perRow)
    rows.push("    " + words.slice(i, i + perRow).join(", ") + ",");
  return rows.join("\n");
};

const out = `/* eslint-disable */
// Generated by scripts/gen-sha1dc-ubc.mjs from lib/ubc_check.c of
// https://github.com/cr-marcstevens/sha1collisiondetection. Do not edit.
//
// Copyright 2017 Marc Stevens <marc@marc-stevens.nl>, Dan Shumow <danshu@microsoft.com>
// Distributed under the MIT Software License.
// See LICENSE-sha1collisiondetection.txt beside this package's package.json.
//
// The disturbance vectors a SHA-1 collision attack can be built on, and the
// "unavoidable bit conditions" check: for an expanded message block, which
// of those vectors the block could belong to. See src/sha1.ts for its use.

${bits.map((entry) => `const ${entry.name} = 1 << ${entry.bit};`).join("\n")}

/** How many disturbance vectors are checked. Vector \`i\` has bit \`i\` of the mask. */
export const DV_COUNT = ${vectors.length};

/** The steps whose working state a recompression starts from. */
export const DV_STATE_STEPS = [${steps.join(", ")}] as const;

/** Per vector: the step its recompression starts from (one of \`DV_STATE_STEPS\`). */
export const DV_TEST_STEP = new Uint8Array([${vectors.map((vector) => vector.testt).join(", ")}]);

/** Per vector, 80 words: the XOR difference of the expanded message. */
// prettier-ignore
export const DV_DM = new Int32Array([
${vectors.map((vector) => `    // ${vector.type === 1 ? "I" : "II"}(${vector.k},${vector.b})\n${hexRows(vector.dm, 8)}`).join("\n")}
]);

/**
 * The mask of disturbance vectors whose unavoidable bit conditions the
 * expanded block \`W\` (80 words) meets. Zero for almost every block.
 */
export function ubcCheck(W: Int32Array): number {
${body}
  return mask;
}
`;

const target = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "sha1dc-ubc.gen.ts");
writeFileSync(target, out);
console.log(
  `wrote ${target} (${vectors.length} vectors, ${body.split("\n").length} lines of conditions)`,
);
