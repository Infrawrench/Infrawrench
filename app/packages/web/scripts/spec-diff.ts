#!/usr/bin/env tsx
/**
 * Semantic diff between the committed `openapi.json` and the document the
 * server builds now, for checking a route domain's move to HttpApi.
 *
 * A byte diff is useless here: zod-to-openapi and Effect's generator spell the
 * same schema differently (`type: ["string", "null"]` against an `anyOf` with
 * `null`, an inline `allOf` for a refined string, `example` against
 * `examples`). This compares meaning instead, after resolving references, and
 * sorts every difference into one of three kinds:
 *
 *   STRUCTURE   what a client or generated SDK sees: operations, ids, tags,
 *               parameters, statuses, property sets, types, `required`,
 *               nullability, enums, component names, permissions, security.
 *   ADDED       documentation of something that was always true: a
 *               permission gate now stated, an error status now listed.
 *   CONSTRAINT  validation bounds and patterns.
 *   DOCS        summaries, descriptions, examples.
 *
 * Usage:
 *   tsx --import @infrawrench/server-core/env-loader scripts/spec-diff.ts [options]
 *     --ops=effect     only operations served by an HttpApi domain (default)
 *     --ops=all        every operation
 *     --prefix=/api/org/{orgId}/budgets   only paths starting with this
 *     --docs           also print DOCS differences (counted either way)
 *     --old=<file>     compare against this file instead of openapi.json
 *
 * Exits 1 when any STRUCTURE difference is found.
 */
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildOpenApiDocument } from "../src/api/openapi/index";
import { buildOpenApiFragment } from "../src/http/openapi";
import { DOMAINS } from "../src/http/domains";
import { SPEC_SERVERS } from "./spec-servers";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = { [key: string]: Json };
type Kind = "STRUCTURE" | "ADDED" | "CONSTRAINT" | "DOCS";

interface Finding {
  readonly op: string;
  readonly kind: Kind;
  readonly where: string;
  readonly message: string;
}

const METHODS = ["get", "post", "put", "patch", "delete"] as const;
const DOC_KEYS = new Set(["description", "title", "example", "examples"]);
const CONSTRAINT_KEYS = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "pattern",
  "multipleOf",
  "uniqueItems",
  "minProperties",
  "maxProperties",
]);

const isObj = (v: Json | undefined): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, "").split("=");
    return [k ?? "", rest.length ? rest.join("=") : "true"] as const;
  }),
);

/**
 * Canonical form of a schema. References are inlined (each component once per
 * path through the tree, so recursion terminates) and their names kept as
 * `$name`, since a component's name is a type name in every SDK.
 */
function normalize(schema: Json | undefined, doc: Obj, stack: readonly string[] = []): Json {
  if (!isObj(schema)) return schema ?? null;
  let s: Obj = { ...schema };

  if (typeof s["$ref"] === "string") {
    const name = s["$ref"].replace("#/components/schemas/", "");
    const rest = Object.fromEntries(Object.entries(s).filter(([k]) => k !== "$ref"));
    if (stack.includes(name)) return { $name: name, $recursive: true };
    const components = isObj(doc["components"]) ? doc["components"] : {};
    const schemas = isObj(components["schemas"]) ? components["schemas"] : {};
    const target = normalize(schemas[name], doc, [...stack, name]);
    return isObj(target) ? { ...target, ...normalizeObj(rest, doc, stack), $name: name } : target;
  }

  // `allOf` is the intersection of its members: constraint-only members are
  // the parent with extra keywords, and object members (zod's `.extend()`)
  // merge into one object.
  if (Array.isArray(s["allOf"])) {
    const parts = s["allOf"];
    delete s["allOf"];
    const objects: Obj[] = [];
    for (const part of parts) {
      if (isObj(part) && !("$ref" in part) && !("properties" in part)) s = { ...part, ...s };
      else {
        const resolved = normalize(part, doc, stack);
        if (isObj(resolved)) objects.push(resolved);
      }
    }
    if (objects.length === 1 && objects[0]) {
      // `allOf: [$ref X, { description }]` is a reference to X described at
      // the use site: it keeps X's name.
      s = { ...objects[0], ...s };
    } else if (objects.length > 1) {
      const properties: Obj = {};
      const required = new Set<string>();
      let closed = false;
      for (const member of objects) {
        if (isObj(member["properties"])) Object.assign(properties, member["properties"]);
        if (Array.isArray(member["required"])) {
          for (const r of member["required"]) if (typeof r === "string") required.add(r);
        }
        if (member["additionalProperties"] === false) closed = true;
      }
      s = {
        type: "object",
        properties,
        required: [...required],
        ...(closed ? { additionalProperties: false } : {}),
        ...s,
      };
    }
  }

  for (const key of ["anyOf", "oneOf"] as const) {
    const members = s[key];
    if (!Array.isArray(members)) continue;
    delete s[key];
    const nonNull = members.filter((m) => !(isObj(m) && m["type"] === "null"));
    if (nonNull.length < members.length) s["$nullable"] = true;
    if (nonNull.length === 1 && isObj(nonNull[0])) {
      s = { ...nonNull[0], ...s };
    } else if (nonNull.length > 1) {
      // A union of literal-only members is an enum, whichever way it is spelled.
      const literals = nonNull.every(
        (m) =>
          isObj(m) &&
          Array.isArray(m["enum"]) &&
          Object.keys(m).every((k) => k === "enum" || k === "type"),
      );
      if (literals) {
        s["enum"] = nonNull.flatMap((m) => (isObj(m) && Array.isArray(m["enum"]) ? m["enum"] : []));
        const first = nonNull[0];
        if (isObj(first) && first["type"] !== undefined) s["type"] = first["type"];
      } else {
        s["$union"] = nonNull;
      }
    }
  }
  delete s["discriminator"];

  // `type: [x, "null"]` and `nullable: true` are both "x or null".
  if (Array.isArray(s["type"])) {
    const types = s["type"].filter((t) => t !== "null");
    if (types.length < s["type"].length) s["$nullable"] = true;
    s["type"] = types.length === 1 ? (types[0] ?? null) : types;
  }
  if (s["nullable"] === true) {
    delete s["nullable"];
    s["$nullable"] = true;
  }
  if ("const" in s) {
    s["enum"] = [s["const"] ?? null];
    delete s["const"];
  }

  // A member merged up out of `anyOf` or `allOf` may itself be a reference.
  if (typeof s["$ref"] === "string") return normalize(s, doc, stack);
  return normalizeObj(s, doc, stack);
}

function normalizeObj(s: Obj, doc: Obj, stack: readonly string[]): Obj {
  const out: Obj = {};
  for (const [key, value] of Object.entries(s)) {
    if (key === "properties" && isObj(value)) {
      out[key] = Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, normalize(v, doc, stack)]),
      );
    } else if (key === "items" || (key === "additionalProperties" && isObj(value))) {
      out[key] = normalize(value, doc, stack);
    } else if (key === "$union" && Array.isArray(value)) {
      out[key] = value.map((v) => normalize(v, doc, stack));
    } else if ((key === "required" || key === "enum") && Array.isArray(value)) {
      out[key] = [...value].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    } else if (key === "examples" && Array.isArray(value) && value.length === 1) {
      out["example"] = value[0] ?? null;
    } else {
      out[key] = value;
    }
  }
  // Effect states an integer's safe range; zod-to-openapi leaves it implicit.
  if (out["minimum"] === -9007199254740991) delete out["minimum"];
  if (out["maximum"] === 9007199254740991) delete out["maximum"];
  // An empty `required` says nothing.
  if (Array.isArray(out["required"]) && out["required"].length === 0) delete out["required"];
  return out;
}

function kindOf(key: string): Kind {
  if (DOC_KEYS.has(key)) return "DOCS";
  if (CONSTRAINT_KEYS.has(key)) return "CONSTRAINT";
  return "STRUCTURE";
}

const show = (v: Json | undefined) => {
  const text = JSON.stringify(v);
  return text === undefined ? "(absent)" : text.length > 160 ? `${text.slice(0, 157)}...` : text;
};

function compareSchemas(
  op: string,
  where: string,
  a: Json | undefined,
  b: Json | undefined,
  out: Finding[],
): void {
  if (!isObj(a) || !isObj(b)) {
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      out.push({ op, kind: "STRUCTURE", where, message: `${show(a)} -> ${show(b)}` });
    }
    return;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (key === "$recursive") continue;
    const va = a[key];
    const vb = b[key];
    if (key === "properties" && isObj(va) && isObj(vb)) {
      const names = new Set([...Object.keys(va), ...Object.keys(vb)]);
      for (const name of names) {
        if (!(name in va)) {
          out.push({ op, kind: "STRUCTURE", where: `${where}.${name}`, message: "property added" });
        } else if (!(name in vb)) {
          out.push({
            op,
            kind: "STRUCTURE",
            where: `${where}.${name}`,
            message: "property removed",
          });
        } else compareSchemas(op, `${where}.${name}`, va[name], vb[name], out);
      }
      continue;
    }
    if (key === "properties") {
      if (JSON.stringify(va) !== JSON.stringify(vb)) {
        out.push({
          op,
          kind: "STRUCTURE",
          where: `${where}{}`,
          message: `${show(va)} -> ${show(vb)}`,
        });
      }
      continue;
    }
    if (key === "items" || (key === "additionalProperties" && (isObj(va) || isObj(vb)))) {
      compareSchemas(op, `${where}${key === "items" ? "[]" : "{*}"}`, va, vb, out);
      continue;
    }
    if (key === "$union" && Array.isArray(va) && Array.isArray(vb) && va.length === vb.length) {
      va.forEach((m, i) => compareSchemas(op, `${where}|${i}`, m, vb[i], out));
      continue;
    }
    if (JSON.stringify(va) !== JSON.stringify(vb)) {
      // Naming a type that was inline is additive for every SDK; losing a name is not.
      const kind = key === "$name" && va === undefined ? "ADDED" : kindOf(key);
      out.push({ op, kind, where: `${where} ${key}`, message: `${show(va)} -> ${show(vb)}` });
    }
  }
}

function compareOps(op: string, a: Obj, b: Obj, oldDoc: Obj, newDoc: Obj, out: Finding[]): void {
  for (const key of [
    "operationId",
    "tags",
    "x-required-permission",
    "x-internal",
    "security",
    "deprecated",
  ]) {
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
      const added = key === "x-required-permission" && a[key] === undefined;
      out.push({
        op,
        kind: added ? "ADDED" : "STRUCTURE",
        where: key,
        message: `${show(a[key])} -> ${show(b[key])}`,
      });
    }
  }
  // The permission note the spec builder appends is derived from the gate.
  const stripNote = (v: Json | undefined) =>
    typeof v === "string" ? v.replace(/\n*_Requires permission: `[^`]*`\._$/, "") || undefined : v;
  for (const key of ["summary", "description"]) {
    if (key === "description" && stripNote(a[key]) === stripNote(b[key])) continue;
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
      out.push({ op, kind: "DOCS", where: key, message: `${show(a[key])} -> ${show(b[key])}` });
    }
  }

  const params = (o: Obj, doc: Obj) =>
    new Map(
      (Array.isArray(o["parameters"]) ? o["parameters"] : []).filter(isObj).map((p) => [
        `${String(p["in"])}:${String(p["name"])}`,
        {
          required: p["required"] === true,
          schema: normalize(p["schema"], doc),
          description: p["description"],
        },
      ]),
    );
  const pa = params(a, oldDoc);
  const pb = params(b, newDoc);
  for (const name of new Set([...pa.keys(), ...pb.keys()])) {
    const x = pa.get(name);
    const y = pb.get(name);
    if (!x || !y) {
      out.push({ op, kind: "STRUCTURE", where: `param ${name}`, message: x ? "removed" : "added" });
      continue;
    }
    if (x.required !== y.required) {
      out.push({
        op,
        kind: "STRUCTURE",
        where: `param ${name} required`,
        message: `${x.required} -> ${y.required}`,
      });
    }
    compareSchemas(op, `param ${name}`, x.schema, y.schema, out);
  }

  const body = (o: Obj) => (isObj(o["requestBody"]) ? o["requestBody"] : undefined);
  const ba = body(a);
  const bb = body(b);
  if (Boolean(ba) !== Boolean(bb)) {
    out.push({ op, kind: "STRUCTURE", where: "requestBody", message: ba ? "removed" : "added" });
  } else if (ba && bb) {
    if ((ba["required"] === true) !== (bb["required"] === true)) {
      out.push({
        op,
        kind: "STRUCTURE",
        where: "requestBody required",
        message: `${show(ba["required"])} -> ${show(bb["required"])}`,
      });
    }
    compareContent(op, "body", ba["content"], bb["content"], oldDoc, newDoc, out);
  }

  const ra = isObj(a["responses"]) ? a["responses"] : {};
  const rb = isObj(b["responses"]) ? b["responses"] : {};
  for (const status of new Set([...Object.keys(ra), ...Object.keys(rb)])) {
    const x = ra[status];
    const y = rb[status];
    if (!isObj(x) || !isObj(y)) {
      const added = !x && /^[45]/.test(status);
      out.push({
        op,
        kind: added ? "ADDED" : "STRUCTURE",
        where: `response ${status}`,
        message: x ? "removed" : "added",
      });
      continue;
    }
    if (x["description"] !== y["description"]) {
      out.push({
        op,
        kind: "DOCS",
        where: `response ${status} description`,
        message: `${show(x["description"])} -> ${show(y["description"])}`,
      });
    }
    compareContent(op, `response ${status}`, x["content"], y["content"], oldDoc, newDoc, out);
  }
}

function compareContent(
  op: string,
  where: string,
  a: Json | undefined,
  b: Json | undefined,
  oldDoc: Obj,
  newDoc: Obj,
  out: Finding[],
): void {
  const ca = isObj(a) ? a : {};
  const cb = isObj(b) ? b : {};
  for (const type of new Set([...Object.keys(ca), ...Object.keys(cb)])) {
    const x = ca[type];
    const y = cb[type];
    if (!isObj(x) || !isObj(y)) {
      out.push({
        op,
        kind: "STRUCTURE",
        where: `${where} ${type}`,
        message: x ? "removed" : "added",
      });
      continue;
    }
    compareSchemas(
      op,
      `${where}`,
      normalize(x["schema"], oldDoc),
      normalize(y["schema"], newDoc),
      out,
    );
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const oldDoc = JSON.parse(
  await readFile(resolve(here, "..", args.get("old") ?? "openapi.json"), "utf8"),
) as Obj;
const newDoc = (await buildOpenApiDocument({ servers: [...SPEC_SERVERS] })) as unknown as Obj;

const effectOps = new Set<string>();
for (const [path, item] of Object.entries(buildOpenApiFragment(DOMAINS).paths)) {
  for (const method of Object.keys(item)) effectOps.add(`${method} ${path}`);
}

const scope = args.get("ops") ?? "effect";
const prefix = args.get("prefix");
const findings: Finding[] = [];
const oldPaths = isObj(oldDoc["paths"]) ? oldDoc["paths"] : {};
const newPaths = isObj(newDoc["paths"]) ? newDoc["paths"] : {};
let compared = 0;
for (const path of new Set([...Object.keys(oldPaths), ...Object.keys(newPaths)])) {
  if (prefix && !path.startsWith(prefix)) continue;
  for (const method of METHODS) {
    const key = `${method} ${path}`;
    if (scope === "effect" && !effectOps.has(key)) continue;
    const x = isObj(oldPaths[path]) ? oldPaths[path][method] : undefined;
    const y = isObj(newPaths[path]) ? newPaths[path][method] : undefined;
    if (!isObj(x) && !isObj(y)) continue;
    compared++;
    const op = `${method.toUpperCase()} ${path}`;
    if (!isObj(x) || !isObj(y)) {
      findings.push({
        op,
        kind: "STRUCTURE",
        where: "operation",
        message: x ? "removed" : "added",
      });
      continue;
    }
    compareOps(op, x, y, oldDoc, newDoc, findings);
  }
}

const printDocs = args.has("docs");
const byOp = new Map<string, Finding[]>();
for (const f of findings) byOp.set(f.op, [...(byOp.get(f.op) ?? []), f]);
for (const [op, list] of byOp) {
  const shown = list.filter((f) => printDocs || f.kind !== "DOCS");
  if (shown.length === 0) continue;
  console.log(op);
  for (const f of shown) console.log(`  ${f.kind.padEnd(10)} ${f.where}: ${f.message}`);
}
const count = (k: Kind) => findings.filter((f) => f.kind === k).length;
console.log(
  `\n${compared} operations compared: ${count("STRUCTURE")} structure, ${count("ADDED")} added, ` +
    `${count("CONSTRAINT")} constraint, ${count("DOCS")} docs differences`,
);
process.exit(count("STRUCTURE") > 0 ? 1 : 0);
