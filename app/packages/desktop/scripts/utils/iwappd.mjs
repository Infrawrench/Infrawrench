import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { readFileSync, readdirSync, statSync } from "node:fs";

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

export function hashRustFolder(folder) {
  const o = {};
  makeHashObj(folder, o);
  return createHash("sha256").update(JSON.stringify(o)).digest("hex");
}
