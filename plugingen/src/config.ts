import fs from "node:fs";
import path from "node:path";
import { PluginGenError } from "./errors.js";
import { type JsonValue } from "./json.js";

export const HTTP_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "patch",
  "head",
  "options",
  "trace",
] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export function isHttpMethod(value: string): value is HttpMethod {
  return HTTP_METHODS.some((method) => method === value);
}

export interface Patch {
  pointer: string;
  value: JsonValue;
  why: string;
}

export interface DocumentConfig {
  /** Where the generated types go, under the plugin's `src`. */
  fileName: string;
  specUrl: string;
  pathPrefix?: string;
  paths: Record<string, HttpMethod[]>;
  patches: Patch[];
}

export interface PluginConfig {
  plugin: string;
  documents: DocumentConfig[];
}

const CONFIG_FILE = "plugingen.json";
const PLUGIN_NAME = /^[a-z0-9][a-z0-9-]*$/;
const DOCUMENT_NAME = /^[a-z0-9][a-z0-9_-]*$/;

/** The keys plugingen.schema.json must agree on; a test holds the two together. */
export const DOCUMENT_KEYS = ["specUrl", "pathPrefix", "paths", "patches"];
export const PATCH_KEYS = ["pointer", "value", "why"];

type Fields = Record<string, unknown>;

function isFields(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * JSON Schema is for editors; this is what the run trusts, and every problem it finds
 * names the field, since a config is normally written by someone adding one operation.
 */
class Decoder {
  readonly problems: string[] = [];

  problem(field: string, message: string): void {
    this.problems.push(`${field}: ${message}`);
  }

  unknownKeys(fields: Fields, allowed: readonly string[], where: string): void {
    for (const key of Object.keys(fields)) {
      if (!allowed.includes(key)) {
        this.problem(where ? `${where}.${key}` : key, "is not a known field");
      }
    }
  }

  specUrl(value: unknown, field: string): string {
    if (typeof value !== "string") {
      this.problem(field, "must be a string");
      return "";
    }
    if (!/^https:\/\/\S+$/.test(value) || !URL.canParse(value)) {
      this.problem(field, `must be an https URL, not ${JSON.stringify(value)}`);
    }
    return value;
  }

  paths(value: unknown, field: string): Record<string, HttpMethod[]> {
    const paths: Record<string, HttpMethod[]> = {};
    if (!isFields(value)) {
      this.problem(field, "must be an object of route to HTTP methods");
      return paths;
    }
    if (Object.keys(value).length === 0) this.problem(field, "must list at least one route");
    for (const [route, methods] of Object.entries(value)) {
      const where = `${field}[${JSON.stringify(route)}]`;
      if (!route.startsWith("/")) this.problem(where, "a route must start with /");
      if (!Array.isArray(methods) || methods.length === 0) {
        this.problem(where, "must be a non-empty array of HTTP methods");
        continue;
      }
      const kept: HttpMethod[] = [];
      for (const method of methods) {
        if (typeof method === "string" && isHttpMethod(method) && !kept.includes(method)) {
          kept.push(method);
        } else {
          this.problem(
            where,
            `${JSON.stringify(method)} must be one lowercase HTTP method, listed once (${HTTP_METHODS.join(", ")})`,
          );
        }
      }
      paths[route] = kept;
    }
    return paths;
  }

  patches(value: unknown, field: string): Patch[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      this.problem(field, "must be an array");
      return [];
    }
    const patches: Patch[] = [];
    value.forEach((raw: unknown, index) => {
      const where = `${field}[${index}]`;
      if (!isFields(raw)) {
        this.problem(where, "must be an object");
        return;
      }
      this.unknownKeys(raw, PATCH_KEYS, where);
      const { pointer, value: replacement, why } = raw;
      if (typeof pointer !== "string" || !pointer.startsWith("/")) {
        this.problem(`${where}.pointer`, "must be a JSON pointer starting with /");
      }
      if (typeof why !== "string" || why.trim() === "") {
        this.problem(`${where}.why`, "must say why the document is wrong here");
      }
      if (replacement === undefined) this.problem(`${where}.value`, "is required");
      if (typeof pointer === "string" && typeof why === "string" && isJsonValue(replacement)) {
        patches.push({ pointer, value: replacement, why });
      }
    });
    return patches;
  }

  document(fields: Fields, fileName: string, where: string): DocumentConfig {
    const at = (key: string): string => (where ? `${where}.${key}` : key);
    const document: DocumentConfig = {
      fileName,
      specUrl: this.specUrl(fields["specUrl"], at("specUrl")),
      paths: this.paths(fields["paths"], at("paths")),
      patches: this.patches(fields["patches"], at("patches")),
    };
    const prefix = fields["pathPrefix"];
    if (typeof prefix === "string" && /^\/\S*[^/\s]$/.test(prefix)) {
      document.pathPrefix = prefix;
    } else if (prefix !== undefined) {
      this.problem(at("pathPrefix"), "must start with / and not end with one");
    }
    return document;
  }
}

function isJsonValue(value: unknown): value is JsonValue {
  return value !== undefined;
}

export function decodeConfig(plugin: string, raw: unknown): PluginConfig {
  const decoder = new Decoder();
  const documents: DocumentConfig[] = [];
  if (!isFields(raw)) {
    decoder.problem("(root)", "must be an object");
  } else if (raw["documents"] !== undefined) {
    decoder.unknownKeys(raw, ["$schema", "documents"], "");
    const list = raw["documents"];
    if (!Array.isArray(list) || list.length === 0) {
      decoder.problem("documents", "must be a non-empty array");
    } else {
      const names = new Set<string>();
      list.forEach((item: unknown, index) => {
        const where = `documents[${index}]`;
        if (!isFields(item)) {
          decoder.problem(where, "must be an object");
          return;
        }
        decoder.unknownKeys(item, ["name", ...DOCUMENT_KEYS], where);
        const name = item["name"];
        if (typeof name !== "string" || !DOCUMENT_NAME.test(name)) {
          decoder.problem(`${where}.name`, `must match ${DOCUMENT_NAME.source}`);
          return;
        }
        if (names.has(name)) decoder.problem(`${where}.name`, `${name} is used twice`);
        names.add(name);
        documents.push(decoder.document(item, `api-types.${name}.gen.ts`, where));
      });
    }
  } else {
    decoder.unknownKeys(raw, ["$schema", ...DOCUMENT_KEYS], "");
    documents.push(decoder.document(raw, "api-types.gen.ts", ""));
  }
  if (decoder.problems.length > 0) {
    throw new PluginGenError(
      "config",
      `${plugin}/${CONFIG_FILE} is invalid: ${decoder.problems.join("; ")}`,
    );
  }
  return { plugin, documents };
}

function packagesDir(root: string): string {
  return path.join(root, "plugin-architecture/packages");
}

export function pluginDir(root: string, plugin: string): string {
  return path.join(packagesDir(root), plugin);
}

export function loadConfig(root: string, plugin: string): PluginConfig {
  if (!PLUGIN_NAME.test(plugin)) {
    throw new PluginGenError("config", `${JSON.stringify(plugin)} is not a plugin name`);
  }
  const file = path.join(pluginDir(root, plugin), CONFIG_FILE);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    throw new PluginGenError("config", `${plugin} has no ${CONFIG_FILE}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new PluginGenError("config", `${plugin}/${CONFIG_FILE} is not JSON: ${detail}`);
  }
  return decodeConfig(plugin, raw);
}

/** Every plugin with a config, for `--all`. */
export function discoverPlugins(root: string): string[] {
  return fs
    .readdirSync(packagesDir(root))
    .filter((name) => fs.existsSync(path.join(pluginDir(root, name), CONFIG_FILE)))
    .sort();
}
