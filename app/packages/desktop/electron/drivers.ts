/**
 * Every plugin's node drivers, for the Electron main process
 * (`nodeDrivers.desktop`). This file is a pure registration point: all driver
 * interfaces live in @infrawrench/plugin-base.
 */
import { collectNodeDrivers } from "@infrawrench/plugin-base/effect";

import { nodeDrivers as postgresPlugin } from "@infrawrench/plugin-postgres/driver";
import { nodeDrivers as mysqlPlugin } from "@infrawrench/plugin-mysql/driver";
import { nodeDrivers as mssqlPlugin } from "@infrawrench/plugin-mssql/driver";
import { nodeDrivers as redisPlugin } from "@infrawrench/plugin-redis/driver";
import { nodeDrivers as kafkaPlugin } from "@infrawrench/plugin-kafka/driver";
import { nodeDrivers as natsPlugin } from "@infrawrench/plugin-nats/driver";
import { nodeDrivers as memcachedPlugin } from "@infrawrench/plugin-memcached/driver";
import { nodeDrivers as mongodbPlugin } from "@infrawrench/plugin-mongodb/driver";
import { nodeDrivers as dockerPlugin } from "@infrawrench/plugin-docker/driver";
import { nodeDrivers as kubernetesPlugin } from "@infrawrench/plugin-kubernetes/driver";
import { nodeDrivers as tursoPlugin } from "@infrawrench/plugin-turso/driver";
import { nodeDrivers as planetscalePlugin } from "@infrawrench/plugin-planetscale/driver";
import { nodeDrivers as gcpPlugin } from "@infrawrench/plugin-gcp/node-driver";
import { nodeDrivers as uploadthingPlugin } from "@infrawrench/plugin-uploadthing/node-driver";

export const { sqlDrivers, kvDrivers, dockerDrivers, k8sDrivers, storageDrivers } =
  collectNodeDrivers(
    [
      postgresPlugin,
      mysqlPlugin,
      mssqlPlugin,
      redisPlugin,
      kafkaPlugin,
      natsPlugin,
      memcachedPlugin,
      mongodbPlugin,
      dockerPlugin,
      kubernetesPlugin,
      tursoPlugin,
      planetscalePlugin,
      gcpPlugin,
      uploadthingPlugin,
    ],
    "desktop",
  );
