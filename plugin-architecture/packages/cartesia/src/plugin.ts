import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { CartesiaClient } from "./client.js";
import { VoiceResourceType } from "./resources/voice.js";
import { PronunciationDictResourceType } from "./resources/pronunciation-dict.js";
import { ApiKeyResourceType } from "./resources/api-key.js";

// Brand mark ("Archie") and palette taken from Cartesia's own brand page,
// https://www.cartesia.ai/brand — the symbol is lifted verbatim from the
// inline SVG there (native viewBox "0 0 90 83") and rescaled to 100×100.
// Colours are the published "Verdant" (#309D4B) and "White" (#F4F4F1) pair.
const manifest: PluginManifest = {
  id: "cartesia",
  version: "0.1.0",
  displayName: "Cartesia",
  logoSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="12" fill="#309D4B"/>
    <g transform="translate(18,20.5) scale(0.7111)" fill="#F4F4F1">
      <path d="M89.1256 28.6346V51.252H77.9183L76.4474 49.2161L72.9215 44.3358L70.5208 41.0131L66.4165 35.3331L67.6578 41.0131L69.4514 49.2161L69.8956 51.252L71.245 57.4192L72.9215 65.092L73.0376 65.6225L74.8301 73.8241L76.6237 82.0274H51.3153L49.5216 73.8241L48.6137 69.6692L47.7291 65.6225L45.9355 57.4192L44.5874 51.252L43.2394 57.4192L41.4457 65.6225L40.5122 69.8934L39.6532 73.8241L37.8595 82.0274H12.5021L14.2958 73.8241L16.0393 65.8445V65.8435L16.2042 65.7215L16.339 65.6225L24.3069 59.7214L27.4162 57.4192L32.4095 53.7207L35.7439 51.252H0V28.6346H24.1731L24.3069 28.0255L25.0544 24.6081L26.8469 16.405L28.6406 8.2019L30.4331 0H58.6925L60.485 8.2019L60.8605 9.9186L56.7162 12.9875L52.1007 16.405L48.6137 18.9878L41.0246 24.6081L40.5122 24.987L35.5868 28.6346H89.1256Z"/>
    </g>
  </svg>`,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiKey",
      label: "API Key",
      description:
        "Your Cartesia API key, created in the Cartesia console under API Keys. Starts with sk_car_. This key drives voice and pronunciation-dictionary listing, text-to-speech, and transcription.",
      sensitive: true,
      placeholder: "sk_car_...",
    },
    {
      key: "adminApiKey",
      label: "Admin API Key (optional)",
      description:
        "A separate Cartesia *admin* key, created in the console with the Admin key type. It starts with sk_car_admin_ and is NOT interchangeable with the key above. Cartesia only accepts an admin key on /usage/credits and /api-keys, so leaving this blank simply hides the API Keys list and the credit-usage stats — voices, pronunciation dictionaries, synthesis, and transcription all keep working.",
      sensitive: true,
      optional: true,
      placeholder: "sk_car_admin_...",
    },
    caCertCredentialField,
  ],
};

const resourceTypes: ResourceTypeDefinition[] = [
  VoiceResourceType,
  PronunciationDictResourceType,
  ApiKeyResourceType,
];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials, services) => new CartesiaClient(credentials, services),
};
