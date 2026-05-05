#!/usr/bin/env node
// Merge two electron-builder per-arch update YMLs (latest-mac.yml or latest.yml)
// into one consolidated YML by unioning their `files:` entries. Top-level
// `path:`/`sha512:`/`size:` are taken from the primary input.
//
// Usage: node merge-update-yml.mjs <primary.yml> <secondary.yml> <output.yml>

import { readFileSync, writeFileSync } from "node:fs";

const [, , primaryPath, secondaryPath, outputPath] = process.argv;
if (!primaryPath || !secondaryPath || !outputPath) {
  console.error("usage: merge-update-yml.mjs <primary> <secondary> <output>");
  process.exit(2);
}

function splitYml(text) {
  const lines = text.split("\n");
  const startIdx = lines.findIndex((l) => /^files\s*:/.test(l));
  if (startIdx === -1) return { head: lines, files: [], tail: [] };
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === "" || /^\s/.test(line)) continue;
    endIdx = i;
    break;
  }
  return {
    head: lines.slice(0, startIdx + 1),
    files: lines.slice(startIdx + 1, endIdx),
    tail: lines.slice(endIdx),
  };
}

const primary = splitYml(readFileSync(primaryPath, "utf8"));
const secondary = splitYml(readFileSync(secondaryPath, "utf8"));

const merged = [...primary.head, ...primary.files, ...secondary.files, ...primary.tail];
writeFileSync(outputPath, merged.join("\n"));
