import { loadConfig, type DocumentConfig, type PluginConfig } from "./config.js";
import { failureOf, type FailureKind } from "./errors.js";
import type { FetchText } from "./fetching.js";
import { generateDocument, type GeneratedFile } from "./generate.js";
import { affectedOperations } from "./operations.js";
import { readCommitted } from "./output.js";
import { mapLimit } from "./pool.js";
import { oneLine } from "./text.js";

type CheckStatus = "up-to-date" | "changed" | "could-not-check";

const EXIT_UP_TO_DATE = 0;
const EXIT_CHANGED = 1;
const EXIT_COULD_NOT_CHECK = 2;
export const EXIT_USAGE = 64;

interface DocumentReport {
  file: string;
  specUrl: string;
  status: CheckStatus;
  reason: string;
  failure?: FailureKind;
  operations?: string[];
}

/** The machine-readable result, one per plugin. `--json` prints exactly this. */
export interface CheckReport {
  plugin: string;
  status: CheckStatus;
  reason: string;
  /** Set for `could-not-check`. Only a `network` failure is transient. */
  failure?: FailureKind;
  transient?: boolean;
  specUrls: string[];
  /** For `changed`: the operations whose types differ, as `GET /route`. */
  operations?: string[];
  documents: DocumentReport[];
}

export interface CheckOutcome {
  report: CheckReport;
  /** The fresh text of each file that differs from what is committed. */
  changedFiles: GeneratedFile[];
}

async function checkDocument(
  root: string,
  plugin: string,
  document: DocumentConfig,
  fetchText: FetchText,
): Promise<{ report: DocumentReport; changed?: GeneratedFile }> {
  const base = { file: document.fileName, specUrl: document.specUrl };
  try {
    const generated = await generateDocument(plugin, document, fetchText, { silent: true });
    const committed = readCommitted(root, plugin, document.fileName);
    if (committed === generated.text) {
      return { report: { ...base, status: "up-to-date", reason: "matches what is committed" } };
    }
    if (committed === undefined) {
      return {
        report: { ...base, status: "changed", reason: "not generated yet", operations: [] },
        changed: generated,
      };
    }
    const operations = affectedOperations(committed, generated.text);
    return {
      report: {
        ...base,
        status: "changed",
        reason:
          operations.length > 0
            ? `${operations.length} operation(s) differ`
            : "only the file header differs",
        operations,
      },
      changed: generated,
    };
  } catch (error) {
    const { kind, message } = failureOf(error);
    return {
      report: { ...base, status: "could-not-check", reason: oneLine(message), failure: kind },
    };
  }
}

function summarise(plugin: string, specUrls: string[], documents: DocumentReport[]): CheckReport {
  const failed = documents.filter((document) => document.status === "could-not-check");
  if (failed.length > 0) {
    const lasting = failed.filter((document) => document.failure !== "network");
    const worst = lasting[0] ?? failed[0];
    return {
      plugin,
      status: "could-not-check",
      reason: failed.map((document) => document.reason).join("; "),
      ...(worst?.failure ? { failure: worst.failure } : {}),
      transient: lasting.length === 0,
      specUrls,
      documents,
    };
  }
  const changed = documents.filter((document) => document.status === "changed");
  if (changed.length > 0) {
    const operations = [...new Set(changed.flatMap((document) => document.operations ?? []))];
    return {
      plugin,
      status: "changed",
      reason: changed.map((document) => `${document.file}: ${document.reason}`).join("; "),
      specUrls,
      operations: operations.sort(),
      documents,
    };
  }
  return { plugin, status: "up-to-date", reason: "matches what is committed", specUrls, documents };
}

export async function checkPlugin(
  root: string,
  plugin: string,
  fetchText: FetchText,
): Promise<CheckOutcome> {
  let config: PluginConfig;
  try {
    config = loadConfig(root, plugin);
  } catch (error) {
    const { kind, message } = failureOf(error);
    return {
      report: {
        plugin,
        status: "could-not-check",
        reason: oneLine(message, 2000),
        failure: kind,
        transient: false,
        specUrls: [],
        documents: [],
      },
      changedFiles: [],
    };
  }
  const reports: DocumentReport[] = [];
  const changedFiles: GeneratedFile[] = [];
  // In series: documents of one provider tend to share a host.
  for (const document of config.documents) {
    const { report, changed } = await checkDocument(root, plugin, document, fetchText);
    reports.push(report);
    if (changed) changedFiles.push(changed);
  }
  const specUrls = config.documents.map((document) => document.specUrl);
  return { report: summarise(plugin, specUrls, reports), changedFiles };
}

export function checkPlugins(
  root: string,
  plugins: readonly string[],
  fetchText: FetchText,
  concurrency: number,
): Promise<CheckOutcome[]> {
  return mapLimit(plugins, concurrency, (plugin) => checkPlugin(root, plugin, fetchText));
}

/** The worst result wins, so a run with anything uncheckable never reads as just "changed". */
export function exitCodeFor(reports: readonly CheckReport[]): number {
  if (reports.some((report) => report.status === "could-not-check")) return EXIT_COULD_NOT_CHECK;
  if (reports.some((report) => report.status === "changed")) return EXIT_CHANGED;
  return EXIT_UP_TO_DATE;
}
