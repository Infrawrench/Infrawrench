import { upgradeFromTwoToThree } from "@scalar/openapi-upgrader/2.0-to-3.0";
import YAML from "yaml";
import { PluginGenError } from "./errors.js";
import { assertJsonObject, type JsonObject } from "./json.js";

function parseText(text: string, url: string): unknown {
  try {
    return text.trimStart().startsWith("{") ? JSON.parse(text) : YAML.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new PluginGenError("parse", `${url} no longer parses: ${detail}`);
  }
}

/** Text to an OpenAPI 3 document: a Swagger 2 one is converted on load. */
export function parseDocument(text: string, url: string): JsonObject {
  const parsed = parseText(text, url);
  assertJsonObject(parsed, url);
  const doc = parsed["swagger"] ? upgrade(parsed, url) : parsed;
  const version = doc["openapi"];
  if (typeof version !== "string" || !version.startsWith("3.")) {
    throw new PluginGenError("parse", `${url} is not an OpenAPI 3 or Swagger 2 document`);
  }
  return doc;
}

function upgrade(doc: JsonObject, url: string): JsonObject {
  const upgraded: unknown = upgradeFromTwoToThree(doc);
  assertJsonObject(upgraded, url);
  return upgraded;
}
