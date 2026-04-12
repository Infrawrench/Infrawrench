import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { CloudinaryClient } from "./client.js";
import { FolderResourceType } from "./resources/folder.js";
import { MediaAssetResourceType } from "./resources/media-asset.js";
import { UploadPresetResourceType } from "./resources/upload-preset.js";
import { TransformationResourceType } from "./resources/transformation.js";

const manifest: PluginManifest = {
  id: "cloudinary",
  version: "0.1.0",
  displayName: "Cloudinary",
  logoSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="12" fill="#3448C5"/>
    <g transform="translate(14,28) scale(0.72)" fill="white">
      <path d="M80.2 26.8C76.8 11.4 63 0 46.8 0 34 0 22.6 6.6 16.2 17 7 18.2 0 26.2 0 35.8c0 10.8 8.8 19.6 19.6 19.6h57.8C85.4 55.4 92 48.8 92 40.8c0-6.8-4.8-12.6-11.8-14zM77.4 49H19.6C11.8 49 5.4 42.6 5.4 35.8c0-7.6 5.4-14 12.8-14.8l3.2-.4 1.6-2.8C28.4 9 37 3.4 46.8 3.4c14 0 26.2 10 28.8 23.6l.6 3.2 3.2.4c5.2.8 9.2 5.2 9.2 10.4 0 5.6-4.6 8-11.2 8z"/>
    </g>
  </svg>`,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "cloudName",
      label: "Cloud Name",
      description: "Your Cloudinary cloud name, found in the Dashboard.",
      sensitive: false,
      placeholder: "my-cloud",
    },
    {
      key: "apiKey",
      label: "API Key",
      description: "Your Cloudinary API key, found in Settings > API Keys.",
      sensitive: false,
      placeholder: "123456789012345",
    },
    {
      key: "apiSecret",
      label: "API Secret",
      description: "Your Cloudinary API secret, found in Settings > API Keys.",
      sensitive: true,
      placeholder: "abcdefghijklmnopqrstuvwxyz",
    },
  ],
};

const resourceTypes: ResourceTypeDefinition[] = [
  FolderResourceType,
  MediaAssetResourceType,
  UploadPresetResourceType,
  TransformationResourceType,
];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials) => new CloudinaryClient(credentials),
};
