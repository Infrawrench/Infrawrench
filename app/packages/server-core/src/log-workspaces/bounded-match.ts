/**
 * Log-alert match evaluation that never runs a tenant regex on the poller's
 * event loop. `compileLogSearch`'s shape guard is best-effort, and a single
 * exponentially backtracking pattern would otherwise stall the alert pass
 * (and everything else the shared poller does) for every tenant. Term
 * searches are plain substring checks and stay inline.
 */
import {
  evaluateLogMatches,
  logMatchProbes,
  type CompiledLogSearch,
  type LogMatchEvaluation,
} from "@infrawrench/client-core";
import { testRegexBounded } from "@infrawrench/workflow-runtime";

export async function evaluateLogMatchesBounded(
  text: string,
  search: CompiledLogSearch,
  options?: { matchCap?: number; sampleCap?: number; timeoutMs?: number },
): Promise<LogMatchEvaluation> {
  if (!search.regex) return evaluateLogMatches(text, search, options);
  const probes = logMatchProbes(text);
  const results = await testRegexBounded(search.regex.source, search.regex.flags, probes, {
    ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
  const matched = new Set(probes.filter((_, i) => results[i]));
  return evaluateLogMatches(text, { ...search, test: (probe) => matched.has(probe) }, options);
}
