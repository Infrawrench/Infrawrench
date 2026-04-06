import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const FirestoreDatabaseResourceType: ResourceTypeDefinition = {
  id: "firestore-database",
  displayName: "Firestore Database",
  pluralDisplayName: "Firestore Databases",
  description: "A Google Cloud Firestore database",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "locationId", label: "Location", kind: "string", required: false },
    {
      key: "type",
      label: "Type",
      kind: "enum",
      required: false,
      enumValues: ["FIRESTORE_NATIVE", "DATASTORE_MODE"],
    },
    { key: "concurrencyMode", label: "Concurrency Mode", kind: "string", required: false },
    { key: "state", label: "State", kind: "string", required: false },
  ],
  outputs: [],
  dashboardPinnable: true,
};
