import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { hashRustFolder } from "./utils/iwappd.mjs";

const here = dirname(fileURLToPath(import.meta.url));

const appserverFolder = resolve(here, "..", "..", "..", "..", "linux-appserver");
process.stdout.write(hashRustFolder(appserverFolder));
