import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { hashRustFolder } from "./utils/iwappd.mjs";

const here = dirname(fileURLToPath(import.meta.url));

const hashFile = resolve(here, "..", ".iwappd-hash");
const xzFile = resolve(here, "..", "iwappd.tar.xz");
let hashFileContents;
try {
  hashFileContents = readFileSync(hashFile, "utf-8");
} catch {
  if (existsSync(xzFile)) {
    console.log("iwappd hash doesn't exist but .tar.xz does, presuming file is externally managed and bailing now!");
    process.exit(0);
  }
}

const appserverFolder = resolve(here, "..", "..", "..", "..", "linux-appserver");
const currentRepoState = hashRustFolder(appserverFolder);
if (currentRepoState === hashFileContents) {
  console.log("hashes match - bailing now!");
  process.exit(0);
}

console.log("hashes do not match - compiling the rust now!");

// TODO: build rust code using docker and .tar.xz then put in that file path when its okay

// writeFileSync(hashFile, currentRepoState);
