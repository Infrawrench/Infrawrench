import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { MongoDBClient } from "./client.js";
import { MongoDBDatabaseResourceType } from "./resources/mongodb-database.js";

const manifest: PluginManifest = {
  id: "mongodb",
  version: "0.1.0",
  displayName: "MongoDB",
  description: "Connect to MongoDB databases — browse collections and documents.",
  logoSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="12" fill="#00684A"/>
    <g transform="translate(34,10) scale(0.55)">
      <path d="M35.5 144.3c-1.2-.7-2-1.8-2.5-3.2-.4-1-.7-3.4-.9-7.1-.3-6.3-1.1-10.6-2.5-13.1-1-1.7-2.8-3.3-5.4-5 .2-.1.5-.3.7-.4 3-1.6 5-3.6 6.3-6.2 1.6-3.3 2.4-7.5 2.4-12.6 0-7.2-1.4-12.5-4.3-16.1-2.8-3.6-7.3-6-13.4-7.2-2.4-.5-7-.8-13.8-.9L0 72.4v72.1l2.5.1c6.8.1 11.7-.1 14.6-.6 4.6-.7 8.3-2 11.1-3.8 3.2-2.1 5.6-4.9 7-8.4 1.4-3.3 2.1-7.2 2.1-11.6 0-6.3-1.1-11.2-3.3-14.6-.8-1.2-1.7-2.3-2.8-3.2 3.1-2.1 5.2-4.5 6.3-7.4.8-2.1 1.2-5 1.2-8.7 0-5.2-1-9.5-2.8-12.8-.5-.9-.6-1-2.4-2.2z" fill="none"/>
      <path d="M32.2 73.4c0 5.4-1.3 9.2-4 11.4-2.6 2.2-6.8 3.3-12.5 3.3H9.3V60.5h7.2c5.5 0 9.5 1.2 12 3.5s3.7 6 3.7 10.9zm3.1 44.3c0 5.8-1.5 10-4.4 12.5-3 2.5-7.5 3.8-13.8 3.8H9.3V96.5h7.7c6.4 0 11 1.2 14 3.7 2.9 2.5 4.3 7.5 4.3 14.5z" fill="none"/>
      <path d="M36.2 60.5c-3.2-4-8.1-6.5-14.8-7.6-2.2-.4-6.6-.7-13.2-.8h-8v74.5h8c7 .1 11.7-.1 14.1-.5 4.2-.7 7.7-1.9 10.5-3.5 3-1.9 5.2-4.5 6.5-7.8 1.3-3.1 1.9-6.8 1.9-10.8 0-5.9-1-10.4-3-13.5-1.3-2-3.2-3.7-5.8-5.2 2.5-1.8 4.2-3.8 5.2-6 .8-1.8 1.1-4.5 1.1-8 0-4.8-.9-8.8-2.5-11.8zM9.3 60.5v27.6h6.4c5.7 0 9.9-1.1 12.5-3.3 2.7-2.2 4-6 4-11.4 0-4.9-1.2-8.6-3.7-10.9s-6.5-3.5-12-3.5H9.3zm26 57.7c-3 2.5-7.5 3.8-13.8 3.8H9.3V96.5h7.7c6.4 0 11 1.2 14 3.7 2.9 2.5 4.3 7.5 4.3 14.5 0 5.8-1.5 10-4.4 12.5z" fill="white"/>
    </g>
  </svg>`,
  author: "Infrawrench",
  license: "MIT",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "connectionString",
      label: "Connection String",
      description: "MongoDB connection URI.",
      sensitive: true,
      placeholder: "mongodb://user:pass@host:27017/dbname",
    },
  ],
  kvDriver: {
    driver: "mongodb",
    credentialKey: "connectionString",
  },
};

const resourceTypes: ResourceTypeDefinition[] = [MongoDBDatabaseResourceType];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials, services) => new MongoDBClient(credentials, services),
};
