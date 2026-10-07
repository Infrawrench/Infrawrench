// Moved to server-core so the github-watcher's pull-request check reports the
// same impact the delete dialog does. Kept as a re-export for web callers.
export {
  getBlastRadius,
  type BlastRadiusOptions,
} from "@infrawrench/server-core/dependency-graph/blast-radius";
