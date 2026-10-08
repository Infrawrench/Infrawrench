// Moved to server-core so the github-watcher's pull-request check reads the
// same topology the Graph page draws. Kept as a re-export for web callers.
export { loadDependencyGraph } from "@infrawrench/server-core/dependency-graph/service";
