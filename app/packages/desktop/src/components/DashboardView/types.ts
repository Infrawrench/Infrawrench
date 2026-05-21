export interface PinnedRow {
  resource_id: string;
  plugin_id: string;
  resource_type_id: string;
  account_id: string;
  display_name: string;
  fields_json: string;
  outputs_json: string;
}

export interface PluginMeta {
  logoSvg: string;
  displayName: string;
  terminalResourceTypeIds: string[];
}

export interface CardStatus {
  phase: "connecting" | "ok" | "error";
  resourceCounts?: { typeLabel: string; count: number }[] | undefined;
  stats?: Array<{ label: string; value: string; variant?: string }> | undefined;
  sparkline?: Array<{ timestamp: number; value: number }> | undefined;
  sparklineLabel?: string | undefined;
  error?: string | undefined;
  sshTarget?: boolean;
  resourceId?: string;
  accountId?: string;
}
