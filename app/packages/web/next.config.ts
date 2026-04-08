import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: { allowedOrigins: ["localhost:3000"] },
  },
  serverExternalPackages: [
    "pg",
    "mysql2",
    "ioredis",
    "mongodb",
    "dockerode",
    "@libsql/client",
    "ssh2",
    "archiver",
  ],
  // Transpile workspace packages
  transpilePackages: [
    "@infrawrench/plugin-aws",
    "@infrawrench/plugin-base",
    "@infrawrench/plugin-cloudflare",
    "@infrawrench/plugin-databricks",
    "@infrawrench/plugin-digitalocean",
    "@infrawrench/plugin-docker",
    "@infrawrench/plugin-gcp",
    "@infrawrench/plugin-hetzner",
    "@infrawrench/plugin-kubernetes",
    "@infrawrench/plugin-memcached",
    "@infrawrench/plugin-mongodb",
    "@infrawrench/plugin-mysql",
    "@infrawrench/plugin-neon",
    "@infrawrench/plugin-ovh",
    "@infrawrench/plugin-postgres",
    "@infrawrench/plugin-redis",
    "@infrawrench/plugin-scaleway",
    "@infrawrench/plugin-ssh",
    "@infrawrench/plugin-turso",
    "@infrawrench/ui",
  ],
};

export default nextConfig;
