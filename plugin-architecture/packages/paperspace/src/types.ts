/** Paperspace API payloads this plugin reads (OpenAPI field names, 2026-10). */

export interface PMachine {
  id: string;
  name?: string;
  state?: string;
  os?: string;
  machineType?: string;
  agentType?: string;
  cpus?: number;
  ram?: number;
  storageTotal?: number;
  storageUsed?: number;
  accelerators?: Array<{ name?: string; memory?: number; count?: number }>;
  region?: string;
  privateIp?: string | null;
  networkId?: string | null;
  publicIp?: string | null;
  publicIpType?: string;
  autoShutdownEnabled?: boolean;
  autoShutdownTimeout?: number | null;
  autoShutdownForce?: boolean;
  autoSnapshotEnabled?: boolean;
  autoSnapshotFrequency?: string | null;
  autoSnapshotSaveCount?: number | null;
  updatesPending?: boolean;
  restorePointEnabled?: boolean;
  usageRate?: number | null;
  storageRate?: number | null;
  dtCreated?: string;
  reservation?: { name?: string; id?: string; isActive?: boolean } | null;
}

export interface PMachineEvent {
  id: string;
  name?: string;
  state?: "new" | "in progress" | "done" | "error" | "cancelled";
  machineId?: string | null;
  error?: string | null;
}

export interface POsTemplate {
  id: string;
  name?: string;
  agentType?: string;
  operatingSystemLabel?: string;
  defaultSizeGb?: number;
  availableMachineTypes?: Array<{ machineTypeLabel: string; isAvailable?: boolean }>;
  region?: string;
  parentMachineId?: string;
  dtCreated?: string;
}

export interface PSharedDrive {
  id: string;
  name?: string;
  size?: number;
  mountPoint?: string;
  username?: string;
  password?: string;
  networkId?: string;
  region?: string;
  dtCreated?: string;
}

export interface PSnapshot {
  id: string;
  name?: string;
  machineId?: string;
  isAutoSnapshot?: boolean;
  dtCreated?: string;
}

export interface PNetwork {
  id: string;
  name?: string;
  region?: string;
  network?: string;
  netmask?: string;
  dtCreated?: string;
}

export interface PPublicIp {
  ip: string;
  region?: string;
  assignedMachineId?: string | null;
  dtCreated?: string;
}

export interface PStartupScript {
  id: string;
  name?: string;
  description?: string;
  isEnabled?: boolean;
  isRunOnce?: boolean;
  assignedMachineIds?: string[];
  dtCreated?: string;
}

export interface PProject {
  id: string;
  name?: string;
  dtCreated?: string;
  repoName?: string | null;
  repoUrl?: string | null;
}

export interface PDeployment {
  id: string;
  name?: string;
  projectId?: string;
  endpoint?: string;
  dtCreated?: string;
  latestSpec?: {
    data?: {
      image?: string;
      enabled?: boolean;
      region?: string;
      port?: number;
      resources?: { machineType?: string; instanceType?: string; replicas?: number };
    } | null;
  } | null;
}

export interface PRegistry {
  id: string;
  name?: string;
  url?: string;
  namespace?: string;
  username?: string;
  kind?: string;
  dtCreated?: string;
}
