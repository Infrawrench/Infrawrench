import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldBool, fieldString, tf } from "@infrawrench/plugin-base";

/**
 * Terraform mapping for the official `jfrog/artifactory` provider (12.x,
 * registry docs read 2026-10). The provider has one resource type per
 * repository class and package type (`artifactory_local_npm_repository`,
 * `artifactory_remote_docker_repository`, …); the sets below are the ones the
 * provider actually ships, so a package type it lacks (a local `p2`, say) is
 * reported unsupported rather than written as a block that cannot plan.
 *
 * Repositories and users import by key / username. Groups are left out: the
 * provider marks `artifactory_group` deprecated in favour of the separate
 * `jfrog/platform` provider. Xray objects belong to `jfrog/xray`, also a
 * separate provider. Passwords and the access token are never inlined.
 */
const LOCAL = new Set([
  "alpine",
  "ansible",
  "bower",
  "cargo",
  "chef",
  "cocoapods",
  "composer",
  "conan",
  "conda",
  "cran",
  "debian",
  "gems",
  "generic",
  "gitlfs",
  "go",
  "gradle",
  "helm",
  "helmoci",
  "hex",
  "huggingfaceml",
  "ivy",
  "machinelearning",
  "maven",
  "nix",
  "npm",
  "nuget",
  "oci",
  "opkg",
  "pub",
  "puppet",
  "pypi",
  "rpm",
  "sbt",
  "swift",
  "vagrant",
]);
const REMOTE = new Set([
  "alpine",
  "ansible",
  "bazel",
  "bower",
  "cargo",
  "chef",
  "cocoapods",
  "composer",
  "conan",
  "conda",
  "cran",
  "debian",
  "docker",
  "gems",
  "generic",
  "gitlfs",
  "go",
  "gradle",
  "helm",
  "helmoci",
  "hex",
  "huggingfaceml",
  "ivy",
  "maven",
  "nix",
  "npm",
  "nuget",
  "oci",
  "opkg",
  "p2",
  "pub",
  "puppet",
  "pypi",
  "rpm",
  "sbt",
  "swift",
  "terraform",
  "vcs",
]);
const VIRTUAL = new Set([
  "alpine",
  "ansible",
  "bower",
  "chef",
  "cocoapods",
  "composer",
  "conan",
  "conda",
  "cran",
  "debian",
  "docker",
  "gems",
  "generic",
  "gitlfs",
  "go",
  "gradle",
  "helm",
  "helmoci",
  "hex",
  "ivy",
  "maven",
  "nix",
  "npm",
  "nuget",
  "oci",
  "p2",
  "pub",
  "puppet",
  "pypi",
  "rpm",
  "sbt",
  "swift",
  "terraform",
]);

/** The provider resource type for a repository, or null when it has none. */
export function repositoryResourceType(rclass: string, packageType: string): string | null {
  const pkg = packageType.toLowerCase();
  if (rclass === "local") {
    if (pkg === "docker") return "artifactory_local_docker_v2_repository";
    return LOCAL.has(pkg) ? `artifactory_local_${pkg}_repository` : null;
  }
  if (rclass === "remote") return REMOTE.has(pkg) ? `artifactory_remote_${pkg}_repository` : null;
  if (rclass === "virtual")
    return VIRTUAL.has(pkg) ? `artifactory_virtual_${pkg}_repository` : null;
  return null;
}

const list = (raw: string): string[] =>
  raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export const jfrogTerraformExport: TerraformExportCapability = {
  provider: { name: "artifactory", source: "jfrog/artifactory", version: "~> 12.11" },
  providerConfig: {
    url: tf.ref("var.artifactory_url"),
    access_token: tf.ref("var.artifactory_access_token"),
  },
  variables: [
    {
      name: "artifactory_url",
      description: "Artifactory URL, e.g. https://acme.jfrog.io/artifactory",
    },
    { name: "artifactory_access_token", description: "JFrog access token", sensitive: true },
  ],
  supportedResourceTypeIds: ["jfrog-repository", "jfrog-user"],
  mapResource(resource): TerraformExportResult | null {
    switch (resource.resourceTypeId) {
      case "jfrog-repository": {
        const key = fieldString(resource, "key") || resource.externalId || "";
        const rclass = fieldString(resource, "rclass");
        const type = repositoryResourceType(rclass, fieldString(resource, "packageType"));
        if (!key || !type) return null;
        const attributes: Record<string, TerraformValue> = { key: tf.str(key) };
        const text = (field: string, attr: string) => {
          const v = fieldString(resource, field);
          if (v) attributes[attr] = tf.str(v);
        };
        text("description", "description");
        text("notes", "notes");
        text("includesPattern", "includes_pattern");
        text("excludesPattern", "excludes_pattern");
        if (rclass === "remote") {
          const url = fieldString(resource, "remoteUrl");
          if (!url) return null;
          attributes["url"] = tf.str(url);
        }
        if (rclass === "local" || rclass === "remote") {
          if (resource.fields["xrayIndex"] !== undefined) {
            attributes["xray_index"] = tf.bool(fieldBool(resource, "xrayIndex"));
          }
        }
        if (rclass === "virtual") {
          const members = list(fieldString(resource, "repositories"));
          attributes["repositories"] = tf.list(members.map(tf.str));
          text("defaultDeploymentRepo", "default_deployment_repo");
        }
        return { resource: { type, name: key, attributes, importId: key } };
      }
      case "jfrog-user": {
        const name = fieldString(resource, "username") || resource.externalId || "";
        const email = fieldString(resource, "email");
        // External-realm users (LDAP, SAML) are provisioned by the directory.
        const realm = fieldString(resource, "realm");
        if (!name || !email || (realm && realm !== "internal")) return null;
        const attributes: Record<string, TerraformValue> = {
          name: tf.str(name),
          email: tf.str(email),
        };
        const admin = fieldBool(resource, "admin");
        attributes["admin"] = tf.bool(admin);
        // The provider refuses disable_ui_access on an admin.
        if (!admin)
          attributes["disable_ui_access"] = tf.bool(fieldBool(resource, "disableUiAccess"));
        const groups = list(fieldString(resource, "groups"));
        attributes["groups"] = tf.list(groups.map(tf.str));
        return {
          resource: {
            type: "artifactory_user",
            name,
            attributes,
            importId: name,
            comments: [
              "The provider generates a password when none is set; set one with var.* if needed.",
            ],
          },
        };
      }
      default:
        return null;
    }
  },
};
