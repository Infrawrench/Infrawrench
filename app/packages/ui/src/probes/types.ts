// The wire types come from `@infrawrench/client-core` (the shared pure half);
// this module only adds the client seam a host must provide.
import type { MetricSeries } from "@infrawrench/plugin-base";
import type {
  ProbeCreate,
  ProbePatch,
  ProbeSuggestion,
  SyntheticProbe,
} from "@infrawrench/client-core";

/**
 * What a host must provide for the probes panel. The write methods are
 * optional — their absence renders the panel read-only, the same capability
 * gating `MetricAlertsClient` uses.
 */
export interface ProbesClient {
  listProbes(): Promise<SyntheticProbe[]>;
  /** Endpoint candidates mined from the org's resource outputs. */
  listSuggestions(): Promise<ProbeSuggestion[]>;
  /** The recorded Latency/Up series over an epoch-ms range. */
  probeMetrics(probeId: string, range: { startMs: number; endMs: number }): Promise<MetricSeries[]>;
  createProbe?(input: ProbeCreate): Promise<SyntheticProbe | null>;
  updateProbe?(probeId: string, patch: ProbePatch): Promise<SyntheticProbe | null>;
  deleteProbe?(probeId: string): Promise<void>;
}
