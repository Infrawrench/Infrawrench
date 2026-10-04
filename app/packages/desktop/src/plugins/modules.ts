/**
 * Every bundled plugin package, as a lazy import. The single list both
 * desktop loaders read: the renderer's (`./loader.ts`, which validates
 * manifests and applies ENABLED_RESOURCE_TYPES) and the main process's
 * (`electron/infrafile/plugins.ts`, used by deploy and the CLI peer client).
 * Adding a plugin to the desktop app means adding it here, once.
 *
 * Every entry is a dynamic import, so a CLI invocation that never touches a
 * plugin (login, orgs, costs) pays nothing for this file existing.
 */
import type { Plugin } from "@infrawrench/plugin-base";

export const PLUGIN_MODULES: Array<() => Promise<{ plugin: Plugin }>> = [
  () => import("@infrawrench/plugin-aws"),
  () => import("@infrawrench/plugin-digitalocean"),
  () => import("@infrawrench/plugin-docker"),
  () => import("@infrawrench/plugin-gcp"),
  () => import("@infrawrench/plugin-hetzner"),
  () => import("@infrawrench/plugin-kafka"),
  () => import("@infrawrench/plugin-kubernetes"),
  () => import("@infrawrench/plugin-linode"),
  () => import("@infrawrench/plugin-memcached"),
  () => import("@infrawrench/plugin-mongodb"),
  () => import("@infrawrench/plugin-mysql"),
  () => import("@infrawrench/plugin-mssql"),
  () => import("@infrawrench/plugin-neon"),
  () => import("@infrawrench/plugin-postgres"),
  () => import("@infrawrench/plugin-redis"),
  () => import("@infrawrench/plugin-scaleway"),
  () => import("@infrawrench/plugin-ssh"),
  () => import("@infrawrench/plugin-tailscale"),
  () => import("@infrawrench/plugin-cloudflare"),
  () => import("@infrawrench/plugin-ovh"),
  () => import("@infrawrench/plugin-oracle-cloud"),
  () => import("@infrawrench/plugin-databricks"),
  () => import("@infrawrench/plugin-depot"),
  () => import("@infrawrench/plugin-coreweave"),
  () => import("@infrawrench/plugin-turso"),
  () => import("@infrawrench/plugin-planetscale"),
  () => import("@infrawrench/plugin-azure"),
  () => import("@infrawrench/plugin-fly"),
  () => import("@infrawrench/plugin-github"),
  () => import("@infrawrench/plugin-vercel"),
  () => import("@infrawrench/plugin-netlify"),
  () => import("@infrawrench/plugin-cloudinary"),
  () => import("@infrawrench/plugin-circleci"),
  () => import("@infrawrench/plugin-clickhouse"),
  () => import("@infrawrench/plugin-crusoe"),
  () => import("@infrawrench/plugin-opensearch"),
  () => import("@infrawrench/plugin-anthropic"),
  () => import("@infrawrench/plugin-assemblyai"),
  () => import("@infrawrench/plugin-cartesia"),
  () => import("@infrawrench/plugin-cohere"),
  () => import("@infrawrench/plugin-cursor"),
  () => import("@infrawrench/plugin-deepgram"),
  () => import("@infrawrench/plugin-deepseek"),
  () => import("@infrawrench/plugin-devin"),
  () => import("@infrawrench/plugin-elevenlabs"),
  () => import("@infrawrench/plugin-fireworks"),
  () => import("@infrawrench/plugin-gemini"),
  () => import("@infrawrench/plugin-gladia"),
  () => import("@infrawrench/plugin-groq"),
  () => import("@infrawrench/plugin-mistral"),
  () => import("@infrawrench/plugin-modal"),
  () => import("@infrawrench/plugin-openai"),
  () => import("@infrawrench/plugin-openrouter"),
  () => import("@infrawrench/plugin-replicate"),
  () => import("@infrawrench/plugin-revai"),
  () => import("@infrawrench/plugin-speechmatics"),
  () => import("@infrawrench/plugin-together"),
  () => import("@infrawrench/plugin-xai"),
  () => import("@infrawrench/plugin-uploadthing"),
  () => import("@infrawrench/plugin-workos"),
];
