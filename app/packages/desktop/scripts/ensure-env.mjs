import { copyFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, "..", "env.ts");
const source = resolve(here, "..", "env.example.ts");

if (!existsSync(target)) {
  copyFileSync(source, target);
  console.log("[ensure-env] created env.ts from env.example.ts");
}
