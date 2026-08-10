import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { DeepgramClient } from "./client.js";
import { ProjectResourceType } from "./resources/project.js";
import { ApiKeyResourceType } from "./resources/api-key.js";
import { MemberResourceType } from "./resources/member.js";
import { InviteResourceType } from "./resources/invite.js";
import { BalanceResourceType } from "./resources/balance.js";
import { ModelResourceType } from "./resources/model.js";

/**
 * Deepgram's own mark — the first subpath of the wordmark they serve in their
 * site header
 * (https://cdn.sanity.io/images/10fppwnn/production/3c446251d322f9635751c565c123db9859b48347-146x32.svg).
 * Deepgram publish no standalone icon asset, so the mark is extracted from
 * there and re-based from its native `viewBox="0 2 19.7522 21.6996"` onto the
 * 100×100 rounded rect the host expects.
 *
 * Colours are their live design tokens, not an approximation:
 * `--deepgram-primary: #13ef95` on `--deepgram-background: #0b0b0c`
 * (deepgram.com stylesheet). `#13ef93` is the 300 step of the same ramp and is
 * the shade most references quote — the primary token is the correct one.
 */
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="12" fill="#0B0B0C"/>
  <g transform="translate(22.7,20) scale(2.765) translate(0,-2)" fill="#13EF95">
    <path fill-rule="evenodd" clip-rule="evenodd" d="M16.6284 5.24048C18.688 7.33087 19.7956 10.094 19.7522 13.0198V13.0162C19.6617 18.9076 14.7064 23.6996 8.70876 23.6996H0.282329C0.123066 23.6996 0.0434352 23.5079 0.155643 23.3922L4.25665 19.2729C4.32542 19.2042 4.41591 19.1644 4.51364 19.1644H8.78839C12.227 19.1644 15.1082 16.4158 15.2096 13.0415C15.2602 11.32 14.6268 9.69252 13.4251 8.45564C12.2234 7.21876 10.6127 6.53884 8.89336 6.53884H4.5426V13.5623C4.5426 13.6238 4.49554 13.6708 4.43401 13.6708H0.108588C0.0470548 13.6708 0 13.6238 0 13.5623V2.10849C0 2.04701 0.0470548 2 0.108588 2H8.89336C11.8216 2 14.5689 3.15008 16.6284 5.24048Z"/>
  </g>
</svg>`;

const manifest: PluginManifest = {
  id: "deepgram",
  version: "0.1.0",
  displayName: "Deepgram",
  description:
    "Speech-to-text and text-to-speech. Manage projects, API keys, members, invites and prepaid balances, chart usage, and round-trip audio through Nova transcription and Aura voices.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiKey",
      label: "API Key",
      description:
        "A Deepgram API key. Create one in the Deepgram Console under your project's Settings → API Keys. Deepgram has a single key type but three scopes: a `member` key can transcribe and synthesize but cannot list keys, members, invites or balances, so those sections stay empty; use an `admin` or `owner` key to manage the project. The secret is shown once at creation and cannot be retrieved afterwards.",
      sensitive: true,
      placeholder: "0123456789abcdef0123456789abcdef01234567",
      helpLink: {
        label: "Create a key in the Deepgram Console",
        url: "https://console.deepgram.com/",
      },
    },
    caCertCredentialField,
  ],
  credits: {
    label: "Balance",
    topUpUrl: "https://console.deepgram.com/",
    // Balances are an admin/owner-scoped read; a `member` key sees none, which
    // is a permission gap rather than an empty pot.
    requiresElevatedCredential: true,
  },
};

const resourceTypes: ResourceTypeDefinition[] = [
  ProjectResourceType,
  ApiKeyResourceType,
  MemberResourceType,
  InviteResourceType,
  BalanceResourceType,
  ModelResourceType,
];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials, services) => new DeepgramClient(credentials, services),
};
