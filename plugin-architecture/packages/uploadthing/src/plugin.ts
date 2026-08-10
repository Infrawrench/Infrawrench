import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { UploadThingClient } from "./client.js";
import { UtAppResourceType } from "./resources/ut-app.js";
import { UtFileResourceType } from "./resources/ut-file.js";

// Mark taken verbatim from the UploadThing docs site header (the inline
// `viewBox="0 0 300 300"` logo on docs.uploadthing.com, brand red #e22400).
// The source artwork is authored in a flipped coordinate space — hence the
// `translate(0,300) scale(0.1,-0.1)` wrapper, which is part of the original
// and must be kept for the four lobes to land the right way up.
const manifest: PluginManifest = {
  id: "uploadthing",
  version: "0.1.0",
  displayName: "UploadThing",
  description:
    "File storage for the UploadThing app an API key belongs to — browse, upload, rename, re-permission and delete files, and watch the storage quota.",
  logoSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300">
    <g transform="translate(0,300) scale(0.1,-0.1)" fill="#e22400" stroke="none">
      <path d="M2193 2980 c-111 -20 -248 -91 -339 -177 -122 -114 -210 -295 -230 -474 -7 -60 -18 -75 -29 -40 -10 32 -79 134 -121 177 -128 135 -290 206 -469 207 -181 1 -322 -59 -455 -192 -95 -96 -141 -166 -181 -280 -75 -212 -59 -449 42 -647 22 -42 38 -78 37 -79 -2 -1 -23 -13 -48 -25 -153 -77 -278 -226 -343 -405 -72 -203 -58 -444 37 -633 89 -177 213 -288 398 -358 66 -25 86 -28 198 -28 112 0 133 3 200 27 216 79 374 248 445 477 9 30 18 60 20 67 3 8 27 0 71 -22 204 -103 451 -83 640 51 137 97 245 254 290 424 20 72 25 283 11 380 l-9 55 66 13 c223 42 429 232 510 470 163 479 -142 994 -602 1017 -48 2 -110 0 -139 -5z"/>
    </g>
  </svg>`,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiKey",
      label: "API Key or Token",
      description:
        "Paste either the V7 `UPLOADTHING_TOKEN` or a raw `sk_live_…` secret key — whichever the dashboard's copy button gave you. Both are in the UploadThing dashboard under API Keys. The key is app-scoped, so one Infrawrench account maps to one UploadThing app; add a second account for a second app.",
      sensitive: true,
      placeholder: "sk_live_… or eyJhcGlLZXkiOiJza19saXZlX…",
      helpLink: {
        label: "Get your API key",
        url: "https://uploadthing.com/dashboard",
      },
    },
    caCertCredentialField,
  ],
};

const resourceTypes: ResourceTypeDefinition[] = [UtAppResourceType, UtFileResourceType];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials, services) => new UploadThingClient(credentials, services),
};
