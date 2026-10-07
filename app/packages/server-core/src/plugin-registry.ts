import type { Plugin } from "@infrawrench/plugin-base";

// Static imports: keep plugin registration eager so esbuild bundles them all
import { plugin as awsPlugin } from "@infrawrench/plugin-aws";
import { plugin as cloudflarePlugin } from "@infrawrench/plugin-cloudflare";
import { plugin as digitaloceanPlugin } from "@infrawrench/plugin-digitalocean";
import { plugin as dockerPlugin } from "@infrawrench/plugin-docker";
import { plugin as gcpPlugin } from "@infrawrench/plugin-gcp";
import { plugin as hetznerPlugin } from "@infrawrench/plugin-hetzner";
import { plugin as kafkaPlugin } from "@infrawrench/plugin-kafka";
import { plugin as kubernetesPlugin } from "@infrawrench/plugin-kubernetes";
import { plugin as linodePlugin } from "@infrawrench/plugin-linode";
import { plugin as memcachedPlugin } from "@infrawrench/plugin-memcached";
import { plugin as mongodbPlugin } from "@infrawrench/plugin-mongodb";
import { plugin as mongodbAtlasPlugin } from "@infrawrench/plugin-mongodb-atlas";
import { plugin as mysqlPlugin } from "@infrawrench/plugin-mysql";
import { plugin as mssqlPlugin } from "@infrawrench/plugin-mssql";
import { plugin as neonPlugin } from "@infrawrench/plugin-neon";
import { plugin as newrelicPlugin } from "@infrawrench/plugin-newrelic";
import { plugin as metronomePlugin } from "@infrawrench/plugin-metronome";
import { plugin as oracleCloudPlugin } from "@infrawrench/plugin-oracle-cloud";
import { plugin as ovhPlugin } from "@infrawrench/plugin-ovh";
import { plugin as postgresPlugin } from "@infrawrench/plugin-postgres";
import { plugin as redisPlugin } from "@infrawrench/plugin-redis";
import { plugin as scalewayPlugin } from "@infrawrench/plugin-scaleway";
import { plugin as sentryPlugin } from "@infrawrench/plugin-sentry";
import { plugin as sshPlugin } from "@infrawrench/plugin-ssh";
import { plugin as tailscalePlugin } from "@infrawrench/plugin-tailscale";
import { plugin as snowflakePlugin } from "@infrawrench/plugin-snowflake";
import { plugin as databricksPlugin } from "@infrawrench/plugin-databricks";
import { plugin as depotPlugin } from "@infrawrench/plugin-depot";
import { plugin as coreweavePlugin } from "@infrawrench/plugin-coreweave";
import { plugin as tursoPlugin } from "@infrawrench/plugin-turso";
import { plugin as planetscalePlugin } from "@infrawrench/plugin-planetscale";
import { plugin as redisCloudPlugin } from "@infrawrench/plugin-redis-cloud";
import { plugin as azurePlugin } from "@infrawrench/plugin-azure";
import { plugin as flyPlugin } from "@infrawrench/plugin-fly";
import { plugin as githubPlugin } from "@infrawrench/plugin-github";
import { plugin as vercelPlugin } from "@infrawrench/plugin-vercel";
import { plugin as netlifyPlugin } from "@infrawrench/plugin-netlify";
import { plugin as cloudinaryPlugin } from "@infrawrench/plugin-cloudinary";
import { plugin as circleciPlugin } from "@infrawrench/plugin-circleci";
import { plugin as clickhousePlugin } from "@infrawrench/plugin-clickhouse";
import { plugin as crusoePlugin } from "@infrawrench/plugin-crusoe";
import { plugin as basetenPlugin } from "@infrawrench/plugin-baseten";
import { plugin as opensearchPlugin } from "@infrawrench/plugin-opensearch";
import { plugin as elasticCloudPlugin } from "@infrawrench/plugin-elastic-cloud";
import { plugin as anthropicPlugin } from "@infrawrench/plugin-anthropic";
import { plugin as anyscalePlugin } from "@infrawrench/plugin-anyscale";
import { plugin as assemblyaiPlugin } from "@infrawrench/plugin-assemblyai";
import { plugin as cartesiaPlugin } from "@infrawrench/plugin-cartesia";
import { plugin as coherePlugin } from "@infrawrench/plugin-cohere";
import { plugin as coralogixPlugin } from "@infrawrench/plugin-coralogix";
import { plugin as cursorPlugin } from "@infrawrench/plugin-cursor";
import { plugin as datadogPlugin } from "@infrawrench/plugin-datadog";
import { plugin as deepgramPlugin } from "@infrawrench/plugin-deepgram";
import { plugin as deepseekPlugin } from "@infrawrench/plugin-deepseek";
import { plugin as devinPlugin } from "@infrawrench/plugin-devin";
import { plugin as elevenlabsPlugin } from "@infrawrench/plugin-elevenlabs";
import { plugin as fastlyPlugin } from "@infrawrench/plugin-fastly";
import { plugin as fireworksPlugin } from "@infrawrench/plugin-fireworks";
import { plugin as confluentCloudPlugin } from "@infrawrench/plugin-confluent-cloud";
import { plugin as geminiPlugin } from "@infrawrench/plugin-gemini";
import { plugin as gladiaPlugin } from "@infrawrench/plugin-gladia";
import { plugin as grafanaCloudPlugin } from "@infrawrench/plugin-grafana-cloud";
import { plugin as groqPlugin } from "@infrawrench/plugin-groq";
import { plugin as mistralPlugin } from "@infrawrench/plugin-mistral";
import { plugin as modalPlugin } from "@infrawrench/plugin-modal";
import { plugin as openaiPlugin } from "@infrawrench/plugin-openai";
import { plugin as openrouterPlugin } from "@infrawrench/plugin-openrouter";
import { plugin as replicatePlugin } from "@infrawrench/plugin-replicate";
import { plugin as revaiPlugin } from "@infrawrench/plugin-revai";
import { plugin as speechmaticsPlugin } from "@infrawrench/plugin-speechmatics";
import { plugin as temporalCloudPlugin } from "@infrawrench/plugin-temporal-cloud";
import { plugin as togetherPlugin } from "@infrawrench/plugin-together";
import { plugin as xaiPlugin } from "@infrawrench/plugin-xai";
import { plugin as uploadthingPlugin } from "@infrawrench/plugin-uploadthing";
import { plugin as workosPlugin } from "@infrawrench/plugin-workos";
import { plugin as twilioPlugin } from "@infrawrench/plugin-twilio";
import { plugin as postmarkPlugin } from "@infrawrench/plugin-postmark";
import { plugin as runpodPlugin } from "@infrawrench/plugin-runpod";
import { plugin as renderPlugin } from "@infrawrench/plugin-render";
import { plugin as stripePlugin } from "@infrawrench/plugin-stripe";
import { plugin as supabasePlugin } from "@infrawrench/plugin-supabase";
import { plugin as vultrPlugin } from "@infrawrench/plugin-vultr";
import { plugin as resendPlugin } from "@infrawrench/plugin-resend";
import { plugin as convexPlugin } from "@infrawrench/plugin-convex";
import { plugin as railwayPlugin } from "@infrawrench/plugin-railway";
import { plugin as gitlabPlugin } from "@infrawrench/plugin-gitlab";
import { plugin as civoPlugin } from "@infrawrench/plugin-civo";
import { plugin as xataPlugin } from "@infrawrench/plugin-xata";
import { plugin as herokuPlugin } from "@infrawrench/plugin-heroku";
import { plugin as pagerdutyPlugin } from "@infrawrench/plugin-pagerduty";
import { plugin as bitbucketPlugin } from "@infrawrench/plugin-bitbucket";
import { plugin as cockroachdbCloudPlugin } from "@infrawrench/plugin-cockroachdb-cloud";
import { plugin as northflankPlugin } from "@infrawrench/plugin-northflank";
import { plugin as upcloudPlugin } from "@infrawrench/plugin-upcloud";
import { plugin as incidentIoPlugin } from "@infrawrench/plugin-incident-io";
import { plugin as koyebPlugin } from "@infrawrench/plugin-koyeb";
import { plugin as sendgridPlugin } from "@infrawrench/plugin-sendgrid";
import { plugin as lambdaCloudPlugin } from "@infrawrench/plugin-lambda-cloud";
import { plugin as upstashPlugin } from "@infrawrench/plugin-upstash";
import { plugin as mailgunPlugin } from "@infrawrench/plugin-mailgun";
import { plugin as timescalePlugin } from "@infrawrench/plugin-timescale";

/**
 * The registry, before validation. Exported because `loadPlugins()` *filters*;
 * a plugin whose manifest fails `pluginManifestSchema` is logged and skipped,
 * so its output is the wrong set to assert manifest properties against: the
 * offender is precisely the entry that is missing. Tests that check something
 * about "every plugin that ships" have to start here.
 */
export const BUNDLED_PLUGINS: readonly Plugin[] = [
  awsPlugin,
  cloudflarePlugin,
  digitaloceanPlugin,
  dockerPlugin,
  gcpPlugin,
  hetznerPlugin,
  kafkaPlugin,
  kubernetesPlugin,
  linodePlugin,
  memcachedPlugin,
  mongodbPlugin,
  mongodbAtlasPlugin,
  mysqlPlugin,
  mssqlPlugin,
  neonPlugin,
  newrelicPlugin,
  metronomePlugin,
  oracleCloudPlugin,
  ovhPlugin,
  postgresPlugin,
  redisPlugin,
  scalewayPlugin,
  sentryPlugin,
  sshPlugin,
  tailscalePlugin,
  databricksPlugin,
  snowflakePlugin,
  depotPlugin,
  coreweavePlugin,
  tursoPlugin,
  planetscalePlugin,
  redisCloudPlugin,
  azurePlugin,
  flyPlugin,
  githubPlugin,
  vercelPlugin,
  netlifyPlugin,
  cloudinaryPlugin,
  circleciPlugin,
  clickhousePlugin,
  crusoePlugin,
  basetenPlugin,
  opensearchPlugin,
  elasticCloudPlugin,
  anthropicPlugin,
  anyscalePlugin,
  assemblyaiPlugin,
  cartesiaPlugin,
  coherePlugin,
  coralogixPlugin,
  cursorPlugin,
  datadogPlugin,
  deepgramPlugin,
  deepseekPlugin,
  devinPlugin,
  elevenlabsPlugin,
  fastlyPlugin,
  fireworksPlugin,
  confluentCloudPlugin,
  geminiPlugin,
  gladiaPlugin,
  grafanaCloudPlugin,
  groqPlugin,
  mistralPlugin,
  modalPlugin,
  openaiPlugin,
  openrouterPlugin,
  replicatePlugin,
  revaiPlugin,
  speechmaticsPlugin,
  temporalCloudPlugin,
  togetherPlugin,
  xaiPlugin,
  uploadthingPlugin,
  workosPlugin,
  twilioPlugin,
  postmarkPlugin,
  runpodPlugin,
  renderPlugin,
  stripePlugin,
  supabasePlugin,
  vultrPlugin,
  resendPlugin,
  convexPlugin,
  railwayPlugin,
  gitlabPlugin,
  civoPlugin,
  xataPlugin,
  herokuPlugin,
  pagerdutyPlugin,
  bitbucketPlugin,
  cockroachdbCloudPlugin,
  northflankPlugin,
  upcloudPlugin,
  incidentIoPlugin,
  koyebPlugin,
  sendgridPlugin,
  lambdaCloudPlugin,
  upstashPlugin,
  mailgunPlugin,
  timescalePlugin,
];
