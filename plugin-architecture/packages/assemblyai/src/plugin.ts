import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { AssemblyAIClient } from "./client.js";
import { AccountResourceType } from "./resources/account.js";
import { TranscriptResourceType } from "./resources/transcript.js";

/**
 * The official AssemblyAI "A" mark, lifted verbatim from the two symbol paths
 * in their own wordmark asset
 * (https://www.assemblyai.com/_aai/images/logos/assemblyai-logo-full-secondary.svg)
 * and normalised into a 100×100 viewBox. Fills are the brand's own dark-surface
 * variant — #C7C3B2 for the inner stroke, white for the outer — on their
 * near-black #1D1B16.
 */
const logoSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="12" fill="#1D1B16"/>
  <g transform="translate(22,25.5) scale(1.756)">
    <path fill-rule="evenodd" clip-rule="evenodd" d="M14.079 0C12.0495 0 10.2323 1.25675 9.50206 3.15886L0 27.8693H7.21783L14.6989 8.42363C14.8857 7.9481 15.3443 7.61693 15.8792 7.61693C16.4142 7.61693 16.8727 7.9481 17.0595 8.42363H18.0531V4.47505H16.2019L17.9257 0H14.0705L14.079 0Z" fill="#C7C3B2"/>
    <path fill-rule="evenodd" clip-rule="evenodd" d="M9.5016 3.15886C10.2064 1.33317 11.9132 0.101899 13.8323 0H14.0786H17.8148C19.8443 0 21.6615 1.25675 22.3918 3.15886L31.8939 27.8693H24.5486L15.3353 3.91461C14.8088 2.74277 13.637 1.92758 12.2783 1.92758C10.9197 1.92758 9.73937 2.75127 9.21289 3.9231L9.5016 3.16735V3.15886Z" fill="#ffffff"/>
  </g>
</svg>`;

const manifest: PluginManifest = {
  id: "assemblyai",
  version: "0.1.0",
  displayName: "AssemblyAI",
  description:
    "Async speech-to-text. Lists the account's transcripts and provides a Speech tab that uploads a clip, submits a job, and polls it to completion in one step.",
  logoSvg,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiKey",
      label: "API Key",
      description:
        "Your AssemblyAI API key, from the dashboard's API Keys page. AssemblyAI has only one kind of key — the same key both submits and reads transcripts — but keys are scoped to a project: a transcript submitted with one project's key cannot be read with another's.",
      sensitive: true,
      placeholder: "0123456789abcdef0123456789abcdef",
      helpLink: { label: "Get an API key", url: "https://www.assemblyai.com/app/api-keys" },
    },
    {
      key: "region",
      label: "API Region",
      description:
        "Which AssemblyAI host to talk to. EU (api.eu.assemblyai.com) keeps audio and transcripts inside the European Union. Transcripts live on the host they were created against, so an account pointed at EU will not see transcripts submitted through the default host, and vice versa — pick the one your key already uses.",
      sensitive: false,
      optional: true,
      defaultValue: "us",
      regions: [
        { id: "us", label: "Default (North America)", location: "api.assemblyai.com", flag: "🇺🇸" },
        { id: "eu", label: "EU", location: "api.eu.assemblyai.com", flag: "🇪🇺" },
      ],
    },
    caCertCredentialField,
  ],
  // AssemblyAI answers rate-limit violations with 403 rather than 429, which
  // is indistinguishable from an auth failure at the transport layer. Keep the
  // background poller well under any plausible ceiling so we never have to
  // guess which one a 403 meant.
  rateLimit: { capacity: 40, refillPerSecond: 2 },
};

// Account first: it is the singleton that always exists, and the one that
// carries the Speech tab on an account that has not transcribed anything yet.
const resourceTypes: ResourceTypeDefinition[] = [AccountResourceType, TranscriptResourceType];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials, services) => new AssemblyAIClient(credentials, services),
};
