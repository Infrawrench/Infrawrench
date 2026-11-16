// A package registry for the builtins' tests: no network, nothing fetched
// from npm. `node registry.mjs <dir> <port>` serves every package below
// <dir> (a directory with a package.json, `<dir>/<name>/<version>/` or, for
// a scope, `<dir>/@scope/<name>/<version>/`) as npm's registry API does:
// `GET /<name>` is the packument, `GET /<name>/-/<file>.tgz` the tarball,
// packed here from the directory. Anything else is a 404. Every request is
// logged, so a test can see what a client asked for.
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";

const [root, port = "4873"] = process.argv.slice(2);
const base = `http://127.0.0.1:${port}`;

// A ustar archive of every file under `dir`, each under `package/`, in a
// fixed order with fixed times, so a package's tarball is the same bytes
// every time.
function pack(dir) {
  const files = [];
  const walk = (at) => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(path);
    }
  };
  walk(dir);
  const blocks = [];
  for (const path of files) {
    const data = readFileSync(path);
    const header = Buffer.alloc(512);
    const name = `package/${relative(dir, path)}`;
    header.write(name, 0, 100);
    const mode = /(^|\/)bin\//.test(name) ? "0000755" : "0000644";
    header.write(`${mode}\0`, 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.write("        ", 148);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks), { level: 9 });
}

function versionsOf(name) {
  let dirs;
  try {
    dirs = readdirSync(join(root, name));
  } catch {
    return [];
  }
  return dirs
    .map((version) => join(root, name, version))
    .filter((dir) => {
      try {
        return statSync(join(dir, "package.json")).isFile();
      } catch {
        return false;
      }
    });
}

function packument(name) {
  const versions = {};
  for (const dir of versionsOf(name)) {
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    if (manifest.name !== name) continue;
    const tarball = pack(dir);
    const file = `${name.split("/").pop()}-${manifest.version}.tgz`;
    versions[manifest.version] = {
      ...manifest,
      dist: {
        tarball: `${base}/${name}/-/${file}`,
        shasum: createHash("sha1").update(tarball).digest("hex"),
        integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
      },
    };
  }
  const all = Object.keys(versions).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  if (all.length === 0) return null;
  return { name, "dist-tags": { latest: all[all.length - 1] }, versions };
}

createServer((req, res) => {
  console.log(req.method, req.url);
  const path = decodeURIComponent(req.url.split("?")[0]);
  const tarball = path.match(/^\/((?:@[^/]+\/)?[^/@][^/]*)\/-\/([^/]+)-(\d[^/]*)\.tgz$/);
  if (req.method === "GET" && tarball) {
    const dir = versionsOf(tarball[1]).find((d) => d.endsWith(`/${tarball[3]}`));
    if (dir) {
      res.setHeader("content-type", "application/octet-stream");
      res.end(pack(dir));
      return;
    }
  }
  const doc = req.method === "GET" && packument(path.slice(1));
  if (!doc) {
    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(doc));
}).listen(Number(port), "127.0.0.1", () => console.log(`registry listening on ${port}`));
