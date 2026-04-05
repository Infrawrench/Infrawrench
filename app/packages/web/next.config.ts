import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: { allowedOrigins: ["localhost:3000"] },
  },
  // Transpile workspace packages
  transpilePackages: [
    "@infrawrench/plugin-base",
    "@infrawrench/plugin-digitalocean",
    "@infrawrench/plugin-kubernetes",
    "@infrawrench/plugin-postgres",
    "@infrawrench/ui",
  ],
};

export default nextConfig;
