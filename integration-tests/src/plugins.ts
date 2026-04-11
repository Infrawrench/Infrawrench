/**
 * Static import of all plugin objects, keyed by plugin ID.
 */
import type { Plugin } from "@infrawrench/plugin-base";

import { plugin as awsPlugin } from "@infrawrench/plugin-aws";
import { plugin as azurePlugin } from "@infrawrench/plugin-azure";
import { plugin as cloudflarePlugin } from "@infrawrench/plugin-cloudflare";
import { plugin as databricksPlugin } from "@infrawrench/plugin-databricks";
import { plugin as digitaloceanPlugin } from "@infrawrench/plugin-digitalocean";
import { plugin as dockerPlugin } from "@infrawrench/plugin-docker";
import { plugin as gcpPlugin } from "@infrawrench/plugin-gcp";
import { plugin as hetznerPlugin } from "@infrawrench/plugin-hetzner";
import { plugin as kubernetesPlugin } from "@infrawrench/plugin-kubernetes";
import { plugin as memcachedPlugin } from "@infrawrench/plugin-memcached";
import { plugin as mongodbPlugin } from "@infrawrench/plugin-mongodb";
import { plugin as mysqlPlugin } from "@infrawrench/plugin-mysql";
import { plugin as neonPlugin } from "@infrawrench/plugin-neon";
import { plugin as ovhPlugin } from "@infrawrench/plugin-ovh";
import { plugin as planetscalePlugin } from "@infrawrench/plugin-planetscale";
import { plugin as postgresPlugin } from "@infrawrench/plugin-postgres";
import { plugin as redisPlugin } from "@infrawrench/plugin-redis";
import { plugin as scalewayPlugin } from "@infrawrench/plugin-scaleway";
import { plugin as sshPlugin } from "@infrawrench/plugin-ssh";
import { plugin as tursoPlugin } from "@infrawrench/plugin-turso";

export const pluginMap: Record<string, Plugin> = {
  aws: awsPlugin,
  azure: azurePlugin,
  cloudflare: cloudflarePlugin,
  databricks: databricksPlugin,
  digitalocean: digitaloceanPlugin,
  docker: dockerPlugin,
  gcp: gcpPlugin,
  hetzner: hetznerPlugin,
  kubernetes: kubernetesPlugin,
  memcached: memcachedPlugin,
  mongodb: mongodbPlugin,
  mysql: mysqlPlugin,
  neon: neonPlugin,
  ovh: ovhPlugin,
  planetscale: planetscalePlugin,
  postgres: postgresPlugin,
  redis: redisPlugin,
  scaleway: scalewayPlugin,
  ssh: sshPlugin,
  turso: tursoPlugin,
};
