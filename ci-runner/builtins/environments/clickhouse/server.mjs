// clickhouse-server for a CI job: the CI build of the CloudHouse engine (`clickhouse-ci.mjs`, Emscripten, one
// thread, no JSPI) behind enough of ClickHouse's HTTP interface for `@clickhouse/client`: `/ping`, the query in the
// `query` parameter or the body, the data of an `INSERT` after it, settings and `param_<name>` as URL parameters,
// multipart query parameters, Basic or `X-ClickHouse-User`/`X-ClickHouse-Key` auth, gzip both ways, and exceptions
// as ClickHouse formats them (`Code: N. DB::Exception: ...`) with `X-ClickHouse-Exception-Code`.
//
// Environment, as the official image reads it: CLICKHOUSE_USER (default `default`), CLICKHOUSE_PASSWORD (empty: no
// password), CLICKHOUSE_DB (created at start), plus CLICKHOUSE_HTTP_PORT (8123), CLICKHOUSE_LISTEN (127.0.0.1),
// CLICKHOUSE_COMPATIBILITY (a server version's setting defaults) and CLICKHOUSE_LOG_QUERIES=1.
//
// The engine runs one query at a time and every call into it is synchronous, so requests are served in order.
// Everything is in memory and gone when the service stops.

import http from "node:http";
import zlib from "node:zlib";
import { randomUUID } from "node:crypto";
import createClickHouse from "./clickhouse-ci.mjs";

const USER = process.env.CLICKHOUSE_USER || "default";
const PASSWORD = process.env.CLICKHOUSE_PASSWORD ?? "";
const DB = process.env.CLICKHOUSE_DB || "";
const PORT = Number(process.env.CLICKHOUSE_HTTP_PORT || 8123);
const LISTEN = process.env.CLICKHOUSE_LISTEN || "127.0.0.1";
const VERBOSE = process.env.CLICKHOUSE_LOG_QUERIES === "1";
// The server version whose setting defaults queries get (the `compatibility` setting), such as `24.8` to stand in
// for a 24.8 server: 64-bit integers quoted in JSON, and the rest of what changed since. A request's own settings
// still win.
const COMPATIBILITY = process.env.CLICKHOUSE_COMPATIBILITY || "";

const encoder = new TextEncoder();
const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const lenient = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });

// --- What the engine imports (`host-ci.js`) ------------------------------------------------------------------

let input = new Uint8Array(0);
let inputPos = 0;
let output = [];

const OPERATIONS = [
  (t) => t.toLowerCase(),
  (t) => t.toUpperCase(),
  (t) => t.normalize("NFC"),
  (t) => t.normalize("NFD"),
  (t) => t.normalize("NFKC"),
  (t) => t.normalize("NFKD"),
];
const collators = [];
const collatorNumbers = new Map();

const host = {
  readInput(size) {
    const end = Math.min(input.length, inputPos + size);
    const chunk = input.subarray(inputPos, end);
    inputPos = end;
    return chunk;
  },
  writeOutput(data) {
    output.push(data);
  },
  transformStrings(operation, chars, offsets) {
    const transform = OPERATIONS[operation];
    if (!transform) throw new Error(`No operation on strings number ${operation}`);
    let out = new Uint8Array(Math.max(chars.length + (chars.length >> 2), 64));
    const outOffsets = new BigUint64Array(offsets.length);
    let position = 0;
    let start = 0;
    for (let row = 0; row < offsets.length; ++row) {
      const end = Number(offsets[row]);
      const bytes = chars.subarray(start, end);
      start = end;
      let text;
      try {
        text = transform(strict.decode(bytes));
      } catch {
        text = undefined;
      }
      const needed = text === undefined ? bytes.length : text.length * 3;
      if (position + needed > out.length) {
        const grown = new Uint8Array(Math.max(out.length * 2, position + needed));
        grown.set(out.subarray(0, position));
        out = grown;
      }
      if (text === undefined) {
        out.set(bytes, position);
        position += bytes.length;
      } else {
        position += encoder.encodeInto(text, out.subarray(position)).written;
      }
      outOffsets[row] = BigInt(position);
    }
    return { chars: out.subarray(0, position), offsets: outOffsets };
  },
  openCollator(locale) {
    const known = collatorNumbers.get(locale);
    if (known !== undefined) return known;
    if (Intl.Collator.supportedLocalesOf([locale]).length === 0)
      throw new Error(`Unsupported collation locale: ${locale}`);
    collators.push(new Intl.Collator(locale));
    collatorNumbers.set(locale, collators.length - 1);
    return collators.length - 1;
  },
  compareCollated(collator, a, b) {
    return collators[collator].compare(lenient.decode(a), lenient.decode(b));
  },
  readRange() {
    throw new Error("ObjectMergeTree is not part of the CI build");
  },
  writePart() {
    throw new Error("ObjectMergeTree is not part of the CI build");
  },
  prefetch() {},
};

const started = performance.now();
const M = await createClickHouse({
  host,
  print: (line) => console.log(line),
  printErr: (line) => console.error(line),
});

function resultText() {
  const data = Number(M._ch_isolate_result_data());
  const size = Number(M._ch_isolate_result_size());
  return lenient.decode(M.HEAPU8.subarray(data, data + size));
}

{
  const code = M._ch_isolate_init();
  if (code !== 0) {
    console.error(`clickhouse-ci: init failed with ${code}: ${resultText()}`);
    process.exit(1);
  }
}

/** Copies bytes into the engine's memory; the caller frees the pointer. */
function toEngine(bytes) {
  const ptr = M._malloc(Math.max(bytes.length, 1));
  M.HEAPU8.set(bytes, Number(ptr));
  return ptr;
}

/** Runs one query. `params` is a list of [name, value]. Returns { code, body }. */
function runQuery(query, params, body) {
  const q = encoder.encode(query);
  const p = encoder.encode(params.map(([k, v]) => `${k}\0${v}\0`).join(""));
  const qp = toEngine(q);
  const pp = toEngine(p);
  input = body ?? new Uint8Array(0);
  inputPos = 0;
  output = [];
  try {
    const code = M._ch_ci_query(
      BigInt(qp),
      BigInt(q.length),
      BigInt(pp),
      BigInt(p.length),
      body && body.length ? 1 : 0,
    );
    if (code !== 0) return { code, message: resultText() };
    return { code: 0, body: Buffer.concat(output) };
  } finally {
    M._free(qp);
    M._free(pp);
    input = new Uint8Array(0);
    output = [];
  }
}

if (DB) {
  const r = runQuery(`CREATE DATABASE IF NOT EXISTS \`${DB.replaceAll("`", "\\`")}\``, [], null);
  if (r.code !== 0) {
    console.error(`clickhouse-ci: cannot create database ${DB}: ${r.message}`);
    process.exit(1);
  }
}

// --- The HTTP interface ------------------------------------------------------------------------------------

/** ClickHouse's HTTP status for some exception codes (`exceptionCodeToHTTPStatus`); the rest are 500. */
const STATUS = new Map([
  [516, 401],
  [192, 401],
  [194, 401],
  [497, 403],
  [164, 403],
  [60, 404],
  [81, 404],
  [73, 404],
  [62, 400],
  [47, 400],
  [46, 400],
  [36, 400],
  [27, 400],
  [26, 400],
  [25, 400],
  [38, 400],
  [6, 400],
  [43, 400],
  [44, 400],
  [53, 400],
  [70, 400],
  [72, 400],
  [130, 400],
  [41, 400],
  [117, 400],
  [69, 400],
  [32, 400],
  [35, 400],
  [42, 400],
  [57, 400],
  [115, 400],
  [159, 504],
]);

// Every insert is synchronous here (there is no asynchronous insert queue in a one-thread engine, and the engine then
// runs `async_insert` = 1 inserts at once), so flushing the queue has nothing to do.
const FLUSH_ASYNC = /^\s*SYSTEM\s+FLUSH\s+ASYNC\s+INSERT\s+QUEUE\b[^;]*;?\s*$/i;

function contentTypeFor(format) {
  if (/^JSON/i.test(format) && !/EachRow|Lines|Stream/i.test(format))
    return "application/json; charset=UTF-8";
  if (/EachRow|Lines/i.test(format) && /^JSON/i.test(format))
    return "application/x-ndjson; charset=UTF-8";
  if (/^(TabSeparated|TSV)/i.test(format)) return "text/tab-separated-values; charset=UTF-8";
  if (/^CSV/i.test(format)) return "text/csv; charset=UTF-8; header=absent";
  return "text/plain; charset=UTF-8";
}

function formatOf(query, params) {
  const m = /\bFORMAT\s+([A-Za-z0-9_]+)\s*;?\s*$/i.exec(query.trim());
  if (m && !/^\s*INSERT\b/i.test(query)) return m[1];
  const def = params.find(([k]) => k === "default_format");
  return def ? def[1] : "TabSeparated";
}

function decodeBody(buffer, encoding) {
  switch ((encoding || "").toLowerCase()) {
    case "":
    case "identity":
      return buffer;
    case "gzip":
    case "x-gzip":
      return zlib.gunzipSync(buffer);
    case "deflate":
      return zlib.inflateSync(buffer);
    case "br":
      return zlib.brotliDecompressSync(buffer);
    default:
      throw Object.assign(
        new Error(
          `Code: 344. DB::Exception: Unsupported Content-Encoding ${encoding}. (SUPPORT_IS_DISABLED)`,
        ),
        { code: 344 },
      );
  }
}

/** The fields of a `multipart/form-data` body, as the client sends `query` and `param_<name>` when they are large. */
function parseMultipart(body, contentType) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!boundary) return null;
  const delimiter = `--${boundary[1] || boundary[2]}`;
  const text = body.toString("utf8");
  const fields = [];
  for (const part of text.split(delimiter).slice(1)) {
    if (part.startsWith("--")) break;
    const split = part.indexOf("\r\n\r\n");
    if (split < 0) continue;
    const head = part.slice(0, split);
    const name = /name="([^"]*)"/i.exec(head);
    if (!name) continue;
    fields.push([name[1], part.slice(split + 4).replace(/\r\n$/, "")]);
  }
  return fields;
}

function authenticate(req, url) {
  let user = req.headers["x-clickhouse-user"];
  let password = req.headers["x-clickhouse-key"];
  const authorization = req.headers.authorization;
  if (user === undefined && authorization && /^Basic /i.test(authorization)) {
    const decoded = Buffer.from(authorization.slice(6).trim(), "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    user = decoded.slice(0, colon < 0 ? decoded.length : colon);
    password = colon < 0 ? "" : decoded.slice(colon + 1);
  }
  user ??= url.searchParams.get("user") ?? "default";
  password ??= url.searchParams.get("password") ?? "";
  return user === USER && password === PASSWORD;
}

function sendError(req, res, code, message, queryId) {
  const text = message.endsWith("\n") ? message : `${message}\n`;
  res.writeHead(STATUS.get(code) ?? 500, {
    "Content-Type": "text/plain; charset=UTF-8",
    "X-ClickHouse-Exception-Code": String(code),
    "X-ClickHouse-Query-Id": queryId,
    "X-ClickHouse-Timezone": "UTC",
  });
  res.end(text);
}

function handle(req, res, raw) {
  const url = new URL(req.url, "http://localhost");
  const queryId = url.searchParams.get("query_id") || randomUUID();
  if (
    url.pathname === "/ping" ||
    url.pathname === "/replicas_status" ||
    (url.pathname === "/" && req.method === "GET" && !url.searchParams.has("query"))
  ) {
    res.writeHead(200, { "Content-Type": "text/plain; charset=UTF-8" });
    res.end("Ok.\n");
    return;
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (!authenticate(req, url)) {
    sendError(
      req,
      res,
      516,
      `Code: 516. DB::Exception: ${url.searchParams.get("user") ?? "default"}: Authentication failed: password is incorrect, or there is no user with such name. (AUTHENTICATION_FAILED)`,
      queryId,
    );
    return;
  }

  let body;
  try {
    body = decodeBody(raw, req.headers["content-encoding"]);
  } catch (error) {
    sendError(req, res, error.code ?? 1001, String(error.message), queryId);
    return;
  }

  const params = COMPATIBILITY ? [["compatibility", COMPATIBILITY]] : [];
  for (const [k, v] of url.searchParams) if (k !== "query") params.push([k, v]);
  let query = url.searchParams.get("query");
  let data = null;
  const contentType = req.headers["content-type"] || "";
  if (/^multipart\/form-data/i.test(contentType)) {
    const fields = parseMultipart(body, contentType) ?? [];
    for (const [k, v] of fields) {
      if (k === "query") query = (query ? `${query}\n` : "") + v;
      else params.push([k, v]);
    }
  } else if (query !== null) {
    // As the HTTP interface does: the body is the data that follows the query in the URL.
    if (body.length) data = body;
    query = `${query}\n`;
  } else {
    query = body.toString("utf8");
  }
  if (!query || !query.trim()) {
    sendError(req, res, 62, "Code: 62. DB::Exception: Empty query. (SYNTAX_ERROR)", queryId);
    return;
  }

  if (FLUSH_ASYNC.test(query)) {
    res.writeHead(200, {
      "X-ClickHouse-Query-Id": queryId,
      "X-ClickHouse-Timezone": "UTC",
      "X-ClickHouse-Summary": "{}",
    });
    res.end();
    return;
  }

  const t = performance.now();
  const result = runQuery(query, params, data);
  if (VERBOSE)
    console.error(
      `[${(performance.now() - t).toFixed(1)} ms] ${result.code ? `error ${result.code}` : "ok"} ${query.slice(0, 200).replace(/\s+/g, " ")}`,
    );
  if (result.code !== 0) {
    sendError(req, res, result.code, result.message, queryId);
    return;
  }
  const format = formatOf(query, params);
  const headers = {
    "Content-Type": contentTypeFor(format),
    "X-ClickHouse-Query-Id": queryId,
    "X-ClickHouse-Format": format,
    "X-ClickHouse-Timezone": "UTC",
    "X-ClickHouse-Summary": JSON.stringify({
      read_rows: "0",
      read_bytes: "0",
      written_rows: "0",
      written_bytes: "0",
      total_rows_to_read: "0",
      result_rows: "0",
      result_bytes: String(result.body.length),
      elapsed_ns: String(Math.round((performance.now() - t) * 1e6)),
    }),
  };
  let out = result.body;
  const compress = params.some(
    ([k, v]) => k === "enable_http_compression" && (v === "1" || v === "true"),
  );
  const accept = String(req.headers["accept-encoding"] || "");
  if (compress && /\bgzip\b/.test(accept)) {
    out = zlib.gzipSync(out);
    headers["Content-Encoding"] = "gzip";
  } else if (compress && /\bdeflate\b/.test(accept)) {
    out = zlib.deflateSync(out);
    headers["Content-Encoding"] = "deflate";
  }
  res.writeHead(200, headers);
  res.end(out);
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    try {
      handle(req, res, Buffer.concat(chunks));
    } catch (error) {
      sendError(
        req,
        res,
        1001,
        `Code: 1001. DB::Exception: ${error?.stack ?? error}. (STD_EXCEPTION)`,
        randomUUID(),
      );
    }
  });
});
server.keepAliveTimeout = 10_000;
server.listen(PORT, LISTEN, () => {
  console.log(
    `clickhouse-ci: Ready for connections on http://${LISTEN}:${PORT} (started in ${(performance.now() - started).toFixed(0)} ms)`,
  );
});
