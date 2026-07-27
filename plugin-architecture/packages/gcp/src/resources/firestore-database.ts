import { f, rt } from "@infrawrench/plugin-base";

export const FirestoreDatabaseResourceType = rt({
  name: "Firestore Database",
  id: "firestore-database",
  description: "A Google Cloud Firestore database",
  fields: [
    f("name", "Name"),
    f("locationId", "Location", { required: false }),
    f("type", "Type", {
      kind: "enum",
      required: false,
      enumValues: ["FIRESTORE_NATIVE", "DATASTORE_MODE"],
    }),
    f("databaseEdition", "Edition", {
      kind: "enum",
      required: false,
      enumValues: ["STANDARD", "ENTERPRISE"],
    }),
    f("concurrencyMode", "Concurrency Mode", { required: false }),
    f("state", "State", { required: false }),
  ],
  outputs: [],
  supportsCreate: true,
});
