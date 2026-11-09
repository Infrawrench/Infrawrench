/**
 * Copy and data for the home page (`src/pages/index.astro`).
 *
 * `PROVIDER_COUNT` is the exact number of plugins in the registry
 * (`server-core/src/plugin-loader.ts`). Marketing copy shows it rounded down
 * as "N+"; the logo strip's "and N more" is exact, so it sums with the named
 * logos to the total.
 */
const PROVIDER_COUNT = 152;
export const PROVIDER_COUNT_COPY = `${Math.floor(PROVIDER_COUNT / 10) * 10}+`;

/** Logos in the strip under the hero; each has an SVG in `public/providers/`. */
export const stripProviders = [
  { id: "aws", name: "AWS" },
  { id: "gcp", name: "Google Cloud" },
  { id: "azure", name: "Azure" },
  { id: "kubernetes", name: "Kubernetes" },
  { id: "cloudflare", name: "Cloudflare" },
  { id: "hetzner", name: "Hetzner" },
  { id: "digitalocean", name: "DigitalOcean" },
  { id: "vercel", name: "Vercel" },
  { id: "supabase", name: "Supabase" },
  { id: "neon", name: "Neon" },
  { id: "github", name: "GitHub" },
  { id: "datadog", name: "Datadog" },
];

export const STRIP_MORE = PROVIDER_COUNT - stripProviders.length;

/** The tabs above the hero shot. `shot` names a pair in `public/screenshots/app/`. */
export const heroViews = [
  { id: "aws", shot: "ec2", label: "AWS", title: "Production · EC2 instances" },
  { id: "kubernetes", shot: "k8s", label: "Kubernetes", title: "prod-eu · Pods" },
  { id: "hetzner", shot: "hetzner", label: "Hetzner", title: "EU compute · Servers" },
  { id: "cloudflare", shot: "cf", label: "Cloudflare", title: "acme.dev · Workers" },
];

export const teamBenefits = [
  {
    title: "One workspace for the team",
    body: "Invite teammates and share every account, dashboard and budget. Roles decide who can read, who can act and who holds the credentials.",
  },
  {
    title: "Terminals in the browser",
    body: "SSH into servers, exec into pods and tunnel to a database through a bastion, with no VPN, local client or kubeconfig.",
  },
  {
    title: "Alerts that find you",
    body: "Budget and resource alerts go to Slack, Microsoft Teams and the mobile app, not to a laptop that is closed.",
  },
  {
    title: "AI chat and workflows",
    body: "Chat history follows you everywhere you sign in, and workflows run on a schedule, on a push or when a budget trips.",
  },
  {
    title: "Audit log, API keys and SDKs",
    body: "Every action is recorded against a person or agent. Drive the same API from scoped keys and nine generated SDKs.",
  },
  {
    title: "On call from your phone",
    body: "The iOS and Android app has dashboards, resources, chat and terminals for when you are away from your desk.",
  },
];

export const nibbletsPoints = [
  {
    title: "A key of its own",
    body: "Each nibblet you switch on gets its own Infrawrench identity. What it does shows under its name in the audit log, and revoking one leaves the rest alone.",
  },
  {
    title: "Only the scopes you tick",
    body: "Choose what each nibblet may do, from reading resources to running commands, and which providers it may touch. It never gets more than you have.",
  },
  {
    title: "Runs on your own machine",
    body: "Open source and self-hosted. Each nibblet lives in its own container, remembers between conversations and wakes on schedules and heartbeats.",
  },
];
