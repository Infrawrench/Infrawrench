// The wire types come from `@infrawrench/client-core` (the shared pure half);
// this module only adds the client seam a host must provide.
import type {
  Slo,
  SloActiveFreeze,
  SloDetailResponse,
  SloFreezeRequest,
  SloInput,
  SloSourcesResponse,
} from "@infrawrench/client-core";

/**
 * What a host must provide for the SLOs panel. The write methods are
 * optional: their absence renders the panel read-only, the `ProbesClient`
 * convention. `startFreeze` is separately optional because it takes a
 * different permission (`freezes:write`) from editing an SLO.
 */
export interface SlosClient {
  listSlos(): Promise<Slo[]>;
  getSlo(sloId: string): Promise<SloDetailResponse>;
  /** Probes and metric-reporting resources, for the editor's pickers. */
  listSources(): Promise<SloSourcesResponse>;
  createSlo?(input: SloInput): Promise<Slo | null>;
  updateSlo?(sloId: string, patch: Partial<SloInput>): Promise<Slo | null>;
  deleteSlo?(sloId: string): Promise<void>;
  startFreeze?(sloId: string, request: SloFreezeRequest): Promise<SloActiveFreeze | null>;
}
