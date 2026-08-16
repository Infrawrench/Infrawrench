import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

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

function makeHashObj(folder, o) {
  const dir = readdirSync(folder);
  for (const d of dir) {
    if (d === "target") continue;
    const j = resolve(folder, d);
    const s = statSync(j);
    if (s.isDirectory()) {
      const n = {};
      o[d] = n;
      makeHashObj(j, n);
    } else {
      o[d] = createHash("sha256").update(readFileSync(j, "utf8")).digest("hex");
    }
  }
}

function hashRustFolder(folder) {
  const o = {};
  makeHashObj(folder, o);
  return createHash("sha256").update(JSON.stringify(o)).digest("hex");
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
