export interface PluginRegistryEntry {
  /** Must match the plugin manifest's id */
  id: string;
  /** npm package name, e.g. "@infrawrench/plugin-digitalocean" */
  packageName: string;
  version: string;
  /** SHA-256 of the package tarball */
  checksum: string;
  blessedAt: string;
  blessedBy: string;
  deprecated?: boolean;
  deprecationReason?: string;
}

/**
 * The blessed plugin registry.
 * Lives in app/packages/web/src/plugins/blessed-plugins.json.
 * Both web and desktop import from the same file via workspace reference.
 * Updating this file is a code review — the security boundary for which plugins can run.
 */
export interface PluginRegistry {
  schemaVersion: "1";
  entries: PluginRegistryEntry[];
}
