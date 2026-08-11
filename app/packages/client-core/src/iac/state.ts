/**
 * Terraform state parsing for **IaC reconciliation** (the ClickOps detector).
 *
 * Naming, because four things in this repo have "Terraform" in the name:
 * eject-to-Terraform writes HCL describing the user's cloud resources; org
 * config as code moves a whole org as one JSON document; the Terraform
 * *provider* manages Infrawrench's own configuration. This module is the
 * fourth — **IaC reconciliation** — and it reads a state document the user
 * already has in order to say which synced resources Terraform owns.
 *
 * Two input shapes are accepted and version-checked rather than assumed:
 *
 *  - a raw `.tfstate` (state file **format version 4**), whose resources live
 *    at `resources[].instances[].attributes`;
 *  - the output of `terraform show -json` (**format_version 1.x**), whose
 *    resources live at `values.root_module` and recursively in
 *    `values.root_module.child_modules[]`.
 *
 * Everything here is pure and total: it never throws for malformed *content*,
 * only for a document that cannot be a Terraform state at all, and it is the
 * only place that knows either file layout. A state document is untrusted
 * user input, so every bound is enforced here and every attribute Terraform
 * marked sensitive is dropped before the value leaves this module.
 */

/** Hard bounds applied to an uploaded state document. */
export const IAC_STATE_LIMITS = {
  /** Largest accepted upload. Bigger states exist; they need the git-backed path, not a paste box. */
  maxDocumentBytes: 8 * 1024 * 1024,
  /** Resource *instances* (not blocks) parsed out of one document. */
  maxResources: 10_000,
  /** Attributes kept per instance. Beyond this the tail is dropped and a warning is emitted. */
  maxAttributesPerResource: 250,
  /** Longest string value kept; longer values are truncated (they cannot be a useful diff). */
  maxAttributeValueChars: 4_000,
  /** State documents retained per org before the oldest are pruned. */
  maxStatesPerOrg: 20,
  /** Age at which a superseded state document is pruned. */
  retentionDays: 90,
} as const;

/** Placeholder written in place of an attribute the state marks sensitive. */
export const IAC_REDACTED = "«redacted»";

/**
 * Placeholder written in place of a structure too large to keep. Distinct from
 * {@link IAC_REDACTED} so a reader can tell "this was a secret" from "this was
 * a 40 KB policy document" — both are values we did not store, but only one of
 * them is a thing to be careful with.
 */
export const IAC_OMITTED = "«omitted: too large»";

export type IacStateFormat = "tfstate" | "show-json";

export type TerraformStateParseErrorCode =
  "too-large" | "not-json" | "unknown-format" | "unsupported-version" | "too-many-resources";

/** Every rejection a state upload can produce, with a code the API maps to a 400. */
export class TerraformStateParseError extends Error {
  readonly code: TerraformStateParseErrorCode;
  constructor(code: TerraformStateParseErrorCode, message: string) {
    super(message);
    this.name = "TerraformStateParseError";
    this.code = code;
  }
}

/** One resource instance lifted out of a state document. */
export interface IacStateResourceEntry {
  /** Full Terraform address, e.g. `module.vpc.aws_subnet.private[0]`. */
  address: string;
  /** Module address (`module.vpc`), or `null` in the root module. */
  module: string | null;
  mode: "managed" | "data";
  /** Terraform resource type, e.g. `aws_instance`. */
  type: string;
  /** Local name, e.g. `web`. */
  name: string;
  /** `count` index or `for_each` key, when the block has one. */
  indexKey: string | number | null;
  /** Provider address as the document reports it, e.g. `registry.terraform.io/hashicorp/aws`. */
  providerName: string | null;
  /**
   * Attributes, with values we chose not to store replaced by a placeholder:
   * {@link IAC_REDACTED} when the state marked them sensitive,
   * {@link IAC_OMITTED} when the structure was too large to keep.
   */
  attributes: Record<string, unknown>;
  /**
   * Attribute keys whose value was **not stored** — sensitive or oversized.
   *
   * This is the list reconciliation filters the drift diff by, and that is the
   * whole reason it exists: comparing a placeholder against a live value
   * reports drift that isn't there. Anything that puts a placeholder into
   * `attributes` must add its key here, or the placeholder becomes a phantom
   * diff. Use {@link ParsedTerraformState.redactedAttributeCount} when you
   * specifically mean *sensitive*.
   */
  redactedAttributeKeys: string[];
  /** Lower-cased identity strings usable for matching (`id`, `arn`, …). */
  identifiers: string[];
}

export interface ParsedTerraformState {
  format: IacStateFormat;
  /** `"4"` for a tfstate, `"1.0"`-style for `terraform show -json`. */
  formatVersion: string;
  terraformVersion: string | null;
  /** `serial`/`lineage` exist only in a raw tfstate. */
  serial: number | null;
  lineage: string | null;
  resources: IacStateResourceEntry[];
  /** Data-source entries are parsed but never matched; counted so the UI can say so. */
  dataSourceCount: number;
  /** Values dropped because the state marked them **sensitive**. Drives the UI's redaction line. */
  redactedAttributeCount: number;
  /** Values dropped because the structure was **too large**. Reported as a warning. */
  omittedAttributeCount: number;
  /** Non-fatal notes: truncation, skipped modules, unusual shapes. */
  warnings: string[];
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Attribute keys that identify a resource well enough to match on. */
const IDENTITY_KEYS = ["id", "arn", "self_link"] as const;

function collectIdentifiers(attributes: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of IDENTITY_KEYS) {
    const value = attributes[key];
    if (typeof value === "string" && value !== "" && value !== IAC_REDACTED) {
      const normalized = value.toLowerCase();
      if (!out.includes(normalized)) out.push(normalized);
    } else if (typeof value === "number") {
      const normalized = String(value);
      if (!out.includes(normalized)) out.push(normalized);
    }
  }
  return out;
}

/**
 * Clamp one attribute value: truncate long strings, drop huge structures whole.
 *
 * `omitted` says the stored value is **not** what the state actually carried,
 * which is the only thing the caller needs to know: a value we changed can
 * never be compared, or the clamp itself reads as drift.
 */
function clampValue(value: unknown): { value: unknown; omitted: boolean } {
  if (typeof value === "string") {
    return value.length > IAC_STATE_LIMITS.maxAttributeValueChars
      ? { value: value.slice(0, IAC_STATE_LIMITS.maxAttributeValueChars), omitted: true }
      : { value, omitted: false };
  }
  if (Array.isArray(value) || isRecord(value)) {
    const serialized = JSON.stringify(value) ?? "";
    if (serialized.length > IAC_STATE_LIMITS.maxAttributeValueChars) {
      return { value: IAC_OMITTED, omitted: true };
    }
    return { value, omitted: false };
  }
  return { value, omitted: false };
}

interface SanitizeOutcome {
  attributes: Record<string, unknown>;
  /** Sensitive **and** oversized keys — everything excluded from the diff. */
  redactedAttributeKeys: string[];
  /** Of those, the ones dropped for being sensitive. */
  sensitiveCount: number;
  /** Of those, the ones dropped for being too large. */
  omittedCount: number;
  truncated: boolean;
}

function sanitizeAttributes(
  raw: Record<string, unknown>,
  sensitiveKeys: ReadonlySet<string>,
): SanitizeOutcome {
  const attributes: Record<string, unknown> = {};
  const redactedAttributeKeys: string[] = [];
  let count = 0;
  let sensitiveCount = 0;
  let omittedCount = 0;
  let truncated = false;
  for (const [key, value] of Object.entries(raw)) {
    if (count >= IAC_STATE_LIMITS.maxAttributesPerResource) {
      truncated = true;
      break;
    }
    count += 1;
    if (sensitiveKeys.has(key)) {
      attributes[key] = IAC_REDACTED;
      redactedAttributeKeys.push(key);
      sensitiveCount += 1;
      continue;
    }
    const clamped = clampValue(value);
    attributes[key] = clamped.value;
    // A clamped value is a value we did not store faithfully. It must join the
    // excluded list or reconciliation compares our placeholder (or our
    // truncation) against the live value and reports drift that isn't there.
    if (clamped.omitted) {
      redactedAttributeKeys.push(key);
      omittedCount += 1;
    }
  }
  return { attributes, redactedAttributeKeys, sensitiveCount, omittedCount, truncated };
}

/**
 * `sensitive_attributes` in a tfstate is a list of cty paths, each a list of
 * steps like `{"type":"get_attr","value":"password"}`. Only the first step can
 * name a top-level attribute, which is the granularity we store at — a nested
 * sensitive leaf redacts its whole top-level attribute rather than being
 * surgically removed, because half-redacted structures invite mistakes.
 */
function sensitiveKeysFromPaths(value: unknown): Set<string> {
  const keys = new Set<string>();
  if (!Array.isArray(value)) return keys;
  for (const path of value) {
    if (!Array.isArray(path) || path.length === 0) continue;
    const first: unknown = path[0];
    if (isRecord(first) && first["type"] === "get_attr" && typeof first["value"] === "string") {
      keys.add(first["value"]);
    }
  }
  return keys;
}

/**
 * `sensitive_values` in `terraform show -json` mirrors the value structure with
 * `true` at every sensitive leaf. A top-level key is sensitive when it is
 * `true`, or when it is a structure containing any `true`.
 */
function sensitiveKeysFromMirror(value: unknown): Set<string> {
  const keys = new Set<string>();
  if (!isRecord(value)) return keys;
  const containsTrue = (node: unknown): boolean => {
    if (node === true) return true;
    if (Array.isArray(node)) return node.some(containsTrue);
    if (isRecord(node)) return Object.values(node).some(containsTrue);
    return false;
  };
  for (const [key, entry] of Object.entries(value)) {
    if (containsTrue(entry)) keys.add(key);
  }
  return keys;
}

function formatIndexKey(indexKey: string | number | null): string {
  if (indexKey === null) return "";
  return typeof indexKey === "number" ? `[${indexKey}]` : `[${JSON.stringify(indexKey)}]`;
}

function buildAddress(
  module: string | null,
  mode: "managed" | "data",
  type: string,
  name: string,
  indexKey: string | number | null,
): string {
  const head = mode === "data" ? `data.${type}.${name}` : `${type}.${name}`;
  const withModule = module ? `${module}.${head}` : head;
  return `${withModule}${formatIndexKey(indexKey)}`;
}

function normalizeIndexKey(value: unknown): string | number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") return value;
  return null;
}

function normalizeMode(value: unknown): "managed" | "data" {
  return value === "data" ? "data" : "managed";
}

/* ------------------------------------------------------------------ *
 * Format detection + version checks
 * ------------------------------------------------------------------ */

interface Accumulator {
  resources: IacStateResourceEntry[];
  warnings: string[];
  dataSourceCount: number;
  redactedAttributeCount: number;
  omittedAttributeCount: number;
  truncatedAttributes: boolean;
}

/**
 * The two counts are taken from the sanitizer rather than derived from
 * `entry.redactedAttributeKeys.length`, because that list deliberately mixes
 * sensitive and oversized keys — they behave identically for the diff but they
 * are not the same thing to report to a user.
 */
function push(
  acc: Accumulator,
  entry: IacStateResourceEntry,
  counts: { sensitiveCount: number; omittedCount: number },
): void {
  if (acc.resources.length >= IAC_STATE_LIMITS.maxResources) {
    throw new TerraformStateParseError(
      "too-many-resources",
      `State document contains more than ${IAC_STATE_LIMITS.maxResources} resource instances.`,
    );
  }
  acc.resources.push(entry);
  if (entry.mode === "data") acc.dataSourceCount += 1;
  acc.redactedAttributeCount += counts.sensitiveCount;
  acc.omittedAttributeCount += counts.omittedCount;
}

/** Raw `.tfstate`, format version 4. */
function parseStateFileV4(doc: Record<string, unknown>, acc: Accumulator): void {
  const blocks = doc["resources"];
  if (!Array.isArray(blocks)) {
    acc.warnings.push("State document has no `resources` array; nothing to reconcile.");
    return;
  }
  for (const block of blocks) {
    if (!isRecord(block)) continue;
    const type = typeof block["type"] === "string" ? block["type"] : "";
    const name = typeof block["name"] === "string" ? block["name"] : "";
    if (!type || !name) continue;
    const mode = normalizeMode(block["mode"]);
    const rawModule = typeof block["module"] === "string" ? block["module"] : "";
    const module = rawModule === "" ? null : rawModule;
    const providerRaw = typeof block["provider"] === "string" ? block["provider"] : null;
    // `provider["registry.terraform.io/hashicorp/aws"]` → the inner address.
    const providerName = providerRaw
      ? (/provider\["([^"]+)"\]/.exec(providerRaw)?.[1] ?? providerRaw)
      : null;
    const instances = block["instances"];
    if (!Array.isArray(instances)) continue;
    for (const instance of instances) {
      if (!isRecord(instance)) continue;
      const rawAttributes = instance["attributes"];
      if (!isRecord(rawAttributes)) continue;
      const sensitiveKeys = sensitiveKeysFromPaths(instance["sensitive_attributes"]);
      const sanitized = sanitizeAttributes(rawAttributes, sensitiveKeys);
      if (sanitized.truncated) acc.truncatedAttributes = true;
      const indexKey = normalizeIndexKey(instance["index_key"]);
      push(
        acc,
        {
          address: buildAddress(module, mode, type, name, indexKey),
          module,
          mode,
          type,
          name,
          indexKey,
          providerName,
          attributes: sanitized.attributes,
          redactedAttributeKeys: sanitized.redactedAttributeKeys,
          identifiers: collectIdentifiers(sanitized.attributes),
        },
        sanitized,
      );
    }
  }
}

/** `terraform show -json`: one module node, recursing through `child_modules`. */
function parseShowJsonModule(
  moduleNode: Record<string, unknown>,
  parentAddress: string | null,
  acc: Accumulator,
  depth: number,
): void {
  if (depth > 32) {
    acc.warnings.push("Module nesting deeper than 32 levels was not traversed.");
    return;
  }
  const moduleAddress =
    typeof moduleNode["address"] === "string" && moduleNode["address"] !== ""
      ? moduleNode["address"]
      : parentAddress;
  const resources = moduleNode["resources"];
  if (Array.isArray(resources)) {
    for (const entry of resources) {
      if (!isRecord(entry)) continue;
      const type = typeof entry["type"] === "string" ? entry["type"] : "";
      const name = typeof entry["name"] === "string" ? entry["name"] : "";
      if (!type || !name) continue;
      const mode = normalizeMode(entry["mode"]);
      const rawValues = entry["values"];
      const values = isRecord(rawValues) ? rawValues : {};
      const sensitiveKeys = sensitiveKeysFromMirror(entry["sensitive_values"]);
      const sanitized = sanitizeAttributes(values, sensitiveKeys);
      if (sanitized.truncated) acc.truncatedAttributes = true;
      const indexKey = normalizeIndexKey(entry["index"]);
      const address =
        typeof entry["address"] === "string" && entry["address"] !== ""
          ? entry["address"]
          : buildAddress(moduleAddress, mode, type, name, indexKey);
      push(
        acc,
        {
          address,
          module: moduleAddress,
          mode,
          type,
          name,
          indexKey,
          providerName: typeof entry["provider_name"] === "string" ? entry["provider_name"] : null,
          attributes: sanitized.attributes,
          redactedAttributeKeys: sanitized.redactedAttributeKeys,
          identifiers: collectIdentifiers(sanitized.attributes),
        },
        sanitized,
      );
    }
  }
  const children = moduleNode["child_modules"];
  if (Array.isArray(children)) {
    for (const child of children) {
      if (isRecord(child)) parseShowJsonModule(child, moduleAddress, acc, depth + 1);
    }
  }
}

function checkStateFileVersion(raw: unknown): string {
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    throw new TerraformStateParseError(
      "unknown-format",
      "State file `version` is missing or not an integer.",
    );
  }
  if (raw < 4) {
    throw new TerraformStateParseError(
      "unsupported-version",
      `State file format version ${raw} predates Terraform 0.12. Open it once with a current Terraform to upgrade it to version 4, then upload again.`,
    );
  }
  if (raw > 4) {
    throw new TerraformStateParseError(
      "unsupported-version",
      `State file format version ${raw} is newer than the version 4 layout this parser understands. Upload \`terraform show -json\` output instead.`,
    );
  }
  return String(raw);
}

function checkShowJsonVersion(raw: unknown): string {
  if (typeof raw !== "string" || raw === "") {
    throw new TerraformStateParseError(
      "unknown-format",
      "`format_version` is missing or not a string.",
    );
  }
  const major = Number.parseInt(raw.split(".")[0] ?? "", 10);
  if (!Number.isFinite(major)) {
    throw new TerraformStateParseError("unknown-format", `Unrecognised format_version "${raw}".`);
  }
  if (major !== 1) {
    throw new TerraformStateParseError(
      "unsupported-version",
      `\`terraform show -json\` format_version ${raw} is not supported (this parser reads major version 1).`,
    );
  }
  return raw;
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

/**
 * Parse an uploaded state document. Accepts the raw text (so the size bound is
 * applied before `JSON.parse` sees it) or an already-parsed value.
 *
 * Throws {@link TerraformStateParseError} for a document that is not a
 * Terraform state, or whose format version this parser does not read.
 */
export function parseTerraformStateDocument(input: string | unknown): ParsedTerraformState {
  let doc: unknown;
  if (typeof input === "string") {
    // Byte length, not code units — a multi-byte document must not slip past.
    const bytes =
      typeof TextEncoder === "function" ? new TextEncoder().encode(input).length : input.length;
    if (bytes > IAC_STATE_LIMITS.maxDocumentBytes) {
      throw new TerraformStateParseError(
        "too-large",
        `State document is ${Math.round(bytes / 1024)} KiB; the limit is ${IAC_STATE_LIMITS.maxDocumentBytes / (1024 * 1024)} MiB.`,
      );
    }
    try {
      doc = JSON.parse(input);
    } catch {
      throw new TerraformStateParseError("not-json", "State document is not valid JSON.");
    }
  } else {
    doc = input;
  }

  if (!isRecord(doc)) {
    throw new TerraformStateParseError("unknown-format", "State document is not a JSON object.");
  }

  const acc: Accumulator = {
    resources: [],
    warnings: [],
    dataSourceCount: 0,
    redactedAttributeCount: 0,
    omittedAttributeCount: 0,
    truncatedAttributes: false,
  };

  const terraformVersion =
    typeof doc["terraform_version"] === "string" ? doc["terraform_version"] : null;

  let format: IacStateFormat;
  let formatVersion: string;
  let serial: number | null = null;
  let lineage: string | null = null;

  if ("format_version" in doc) {
    format = "show-json";
    formatVersion = checkShowJsonVersion(doc["format_version"]);
    const values = doc["values"];
    if (!isRecord(values)) {
      throw new TerraformStateParseError(
        "unknown-format",
        "`terraform show -json` output has no `values` object. A plan file is not a state document — run `terraform show -json` with no arguments against the workspace.",
      );
    }
    const rootModule = values["root_module"];
    if (!isRecord(rootModule)) {
      acc.warnings.push("`values.root_module` is absent; the state appears to be empty.");
    } else {
      parseShowJsonModule(rootModule, null, acc, 0);
    }
  } else if ("version" in doc) {
    format = "tfstate";
    formatVersion = checkStateFileVersion(doc["version"]);
    serial = typeof doc["serial"] === "number" ? doc["serial"] : null;
    lineage = typeof doc["lineage"] === "string" ? doc["lineage"] : null;
    parseStateFileV4(doc, acc);
  } else {
    throw new TerraformStateParseError(
      "unknown-format",
      "Document carries neither `version` (a .tfstate) nor `format_version` (`terraform show -json` output).",
    );
  }

  if (acc.truncatedAttributes) {
    acc.warnings.push(
      `Some resources carried more than ${IAC_STATE_LIMITS.maxAttributesPerResource} attributes; the extras were dropped.`,
    );
  }
  if (acc.redactedAttributeCount > 0) {
    acc.warnings.push(
      `${acc.redactedAttributeCount} attribute value(s) marked sensitive were redacted and never stored.`,
    );
  }
  if (acc.omittedAttributeCount > 0) {
    acc.warnings.push(
      `${acc.omittedAttributeCount} attribute value(s) were too large to store and are excluded from drift comparison.`,
    );
  }

  return {
    format,
    formatVersion,
    terraformVersion,
    serial,
    lineage,
    resources: acc.resources,
    dataSourceCount: acc.dataSourceCount,
    redactedAttributeCount: acc.redactedAttributeCount,
    omittedAttributeCount: acc.omittedAttributeCount,
    warnings: acc.warnings,
  };
}
