/**
 * Detail-view renderers for DigitalOcean resources, split per resource domain
 * under `./detail-renderers/`. All functions are pure over the resource
 * instance; `renderDetail` in DigitalOceanClient dispatches into them.
 *
 * This module is the stable import path — it re-exports the whole renderer
 * surface so callers never have to know which domain file a renderer lives in.
 */
export { safeParseJson } from "./detail-renderers/shared.js";
export { applyDropletDetail } from "./detail-renderers/droplet.js";
export {
  applyVolumeDetail,
  applySnapshotDetail,
  applyImageDetail,
  applyNfsShareDetail,
} from "./detail-renderers/storage.js";
export {
  applyManagedDatabaseDetail,
  applyDatabaseUserDetail,
} from "./detail-renderers/database.js";
export { renderDomainDetail, renderDnsRecordDetail } from "./detail-renderers/dns.js";
export { applyGenAiAgentDetail } from "./detail-renderers/genai-agent.js";
export { applyGenAiKnowledgeBaseDetail } from "./detail-renderers/genai-knowledge-base.js";
export { applyGenAiModelRouterDetail } from "./detail-renderers/genai-model-router.js";
