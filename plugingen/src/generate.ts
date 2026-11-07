import openapiTS, { astToString, type OpenAPI3 } from "openapi-typescript";
import type { DocumentConfig, PluginConfig } from "./config.js";
import { PluginGenError } from "./errors.js";
import { completeDiscriminatorMappings } from "./discriminators.js";
import type { FetchText } from "./fetching.js";
import type { JsonObject } from "./json.js";
import { assertTypesOnly, generatedHeader } from "./output.js";
import { parseDocument } from "./parse.js";
import { applyPatches } from "./patches.js";
import {
  containExternalRefs,
  dropErrorResponses,
  inlineDeepRefs,
  prune,
  stripPathPrefix,
  withoutDocs,
} from "./prune.js";
import { shareRepeatedTypes } from "./sharing.js";

export interface GeneratedFile {
  fileName: string;
  specUrl: string;
  text: string;
  operations: number;
}

export interface GenerateOptions {
  /** Keeps warnings that quote the document out of the log. */
  silent: boolean;
}

function isOpenApi3(doc: JsonObject): doc is JsonObject & OpenAPI3 {
  return typeof doc["openapi"] === "string" && typeof doc["info"] === "object";
}

/** Document to TypeScript, with no network. */
export async function documentToTypes(
  doc: JsonObject,
  config: Pick<DocumentConfig, "pathPrefix" | "paths" | "patches">,
  options: GenerateOptions,
): Promise<string> {
  inlineDeepRefs(doc);
  if (config.pathPrefix) stripPathPrefix(doc, config.pathPrefix);
  applyPatches(doc, config.patches);
  // Before pruning, so that what only an example refers to is not kept or chased.
  const pruned = prune(withoutDocs(doc), config.paths);
  dropErrorResponses(pruned);
  containExternalRefs(pruned);
  completeDiscriminatorMappings(pruned);
  if (!isOpenApi3(pruned)) throw new PluginGenError("parse", "The document has no info object");
  // `defaultNonNullable` would make any field with a server-side default required
  // in request bodies too, which is the opposite of what a default means.
  const ast = await openapiTS(pruned, {
    alphabetize: true,
    defaultNonNullable: false,
    silent: options.silent,
  });
  return shareRepeatedTypes(astToString(ast));
}

export async function generateDocument(
  plugin: string,
  config: DocumentConfig,
  fetchText: FetchText,
  options: GenerateOptions,
): Promise<GeneratedFile> {
  const doc = parseDocument(await fetchText(config.specUrl), config.specUrl);
  const types = await documentToTypes(doc, config, options);
  assertTypesOnly(types);
  return {
    fileName: config.fileName,
    specUrl: config.specUrl,
    text: generatedHeader(plugin, config.specUrl) + types,
    operations: Object.values(config.paths).reduce((total, methods) => total + methods.length, 0),
  };
}

export async function generatePlugin(
  config: PluginConfig,
  fetchText: FetchText,
  options: GenerateOptions,
): Promise<GeneratedFile[]> {
  const files: GeneratedFile[] = [];
  for (const document of config.documents) {
    files.push(await generateDocument(config.plugin, document, fetchText, options));
  }
  return files;
}
