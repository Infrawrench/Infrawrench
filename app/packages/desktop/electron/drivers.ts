/**
 * Aggregates all plugin node drivers and re-exports typed maps for use in
 * the IPC handlers (main.ts). All driver interface definitions live in
 * @infrawrench/plugin-base — this file is a pure registration point.
 */
import type {
  SqlNodeDriver,
  KvNodeDriver,
  DockerNodeDriver,
  StorageNodeDriver,
} from "@infrawrench/plugin-base" with { "resolution-mode": "import" };

import { driver as pgDriver } from "@infrawrench/plugin-postgres/driver";
import { driver as mysqlDriver } from "@infrawrench/plugin-mysql/driver";
import { driver as mssqlDriver } from "@infrawrench/plugin-mssql/driver";
import { driver as redisDriver } from "@infrawrench/plugin-redis/driver";
import { driver as memcachedDriver } from "@infrawrench/plugin-memcached/driver";
import { driver as mongodbDriver } from "@infrawrench/plugin-mongodb/driver";
import { driver as dockerDriver } from "@infrawrench/plugin-docker/driver";
import { driver as libsqlDriver } from "@infrawrench/plugin-turso/driver";
import { driver as planetscaleDriver } from "@infrawrench/plugin-planetscale/driver";
import { nodeDriver as gcpDriver } from "@infrawrench/plugin-gcp/node-driver";

export const sqlDrivers = new Map<string, SqlNodeDriver>([
  [pgDriver.id, pgDriver],
  [mysqlDriver.id, mysqlDriver],
  [mssqlDriver.id, mssqlDriver],
  [libsqlDriver.id, libsqlDriver],
  [planetscaleDriver.id, planetscaleDriver],
]);

export const kvDrivers = new Map<string, KvNodeDriver>([
  [redisDriver.id, redisDriver],
  [memcachedDriver.id, memcachedDriver],
  [mongodbDriver.id, mongodbDriver],
]);

export const dockerDrivers = new Map<string, DockerNodeDriver>([[dockerDriver.id, dockerDriver]]);

// TODO(sdk-audit/k8s-node-driver): wire up the Kubernetes node driver here
// so kubeconfigs with exec credential plugins (gke-gcloud-auth-plugin,
// aws-iam-authenticator), auth-provider, OIDC, and multi-context configs
// work. Pattern:
//   import { driver as k8sDriver } from "@infrawrench/plugin-kubernetes/driver";
//   export const k8sDrivers = new Map<string, K8sNodeDriver>([[k8sDriver.id, k8sDriver]]);
// Then add an `ipcMain.handle("plugin_k8s_command", ...)` channel in
// electron/plugin-host.ts and a `k8s` block in
// src/lib/sql-drivers.ts → buildK8sHostServices to call invoke through it.

export const storageDrivers = new Map<string, StorageNodeDriver>([[gcpDriver.pluginId, gcpDriver]]);
