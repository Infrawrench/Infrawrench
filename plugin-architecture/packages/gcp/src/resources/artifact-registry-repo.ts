import { f, rt } from "@infrawrench/plugin-base";

export const ArtifactRegistryRepoResourceType = rt({
  name: "Artifact Registry Repository",
  plural: "Artifact Registry Repositories",
  pinnable: false,
  id: "artifact-registry-repo",
  iconKey: "container-registry",
  description: "A Google Artifact Registry repository",
  fields: [
    f("name", "Name"),
    f("location", "Location", { showcase: true }),
    f("format", "Format", {
      showcase: true,
      kind: "enum",
      required: false,
      enumValues: ["DOCKER", "MAVEN", "NPM", "APT", "YUM", "PYTHON", "GO", "HELM"],
    }),
    f("description", "Description", { required: false }),
    f("sizeBytes", "Size", { showcase: true, required: false }),
  ],
  outputs: [],
  supportsCreate: true,
});
