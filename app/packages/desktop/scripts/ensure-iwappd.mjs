import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { hashRustFolder } from "./utils/iwappd/hash.mjs";
import { dockerBuild } from "./utils/iwappd/docker.mjs";

const here = dirname(fileURLToPath(import.meta.url));

const hashFile = resolve(here, "..", ".iwappd-hash");
const xzFile = resolve(here, "..", "iwappd.tar.xz");
let hashFileContents;
try {
  hashFileContents = readFileSync(hashFile, "utf-8");
} catch {
  if (existsSync(xzFile)) {
    console.log(
      "iwappd hash doesn't exist but .tar.xz does, presuming file is externally managed and bailing now!",
    );
    process.exit(0);
  }
}

const appserverFolder = resolve(here, "..", "..", "..", "..", "linux-appserver");
const currentRepoState = hashRustFolder(appserverFolder);
if (currentRepoState === hashFileContents) {
  console.log("iwappd hashes match - bailing now!");
  process.exit(0);
}

fetch(`https://iwappd-hash-asset-downloader.infrawrench.com/${currentRepoState}`)
  .then(async (res) => {
    if (res.status === 200) {
      console.log("iwappd version locally was remotely built - downloading that!");
      const b = await res.arrayBuffer();
      writeFileSync(xzFile, Buffer.from(b));
    } else {
      console.log("iwappd hashes do not match - compiling the rust now!");
      dockerBuild(xzFile, appserverFolder);
    }

    writeFileSync(hashFile, currentRepoState);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
