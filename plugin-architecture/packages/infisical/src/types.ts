import type { ApiBody, ApiListItem, ApiResponse } from "@infrawrench/plugin-base";
import type { components, operations, paths } from "./api-types.gen.js";

/**
 * Infisical API shapes, each named by its widest response so the narrower ones
 * are assignable to it. `Partial` keeps a mapper usable on what a create answers
 * and on the fallback objects the client builds, and is why it reads with `?.`
 * and `??`: responses are not validated.
 */

export type InfProject = ApiListItem<operations["listProjects"], "projects">;

export type InfEnvironment = Partial<ApiResponse<operations["createEnvironment"]>["environment"]>;

type FolderRead = ApiResponse<operations["getSecretFolderById"]>["folder"];
type FolderRow = ApiListItem<operations["listSecretFolders"], "folders">;

export type InfFolder = Partial<Omit<FolderRead, "environment">> &
  Pick<Partial<FolderRow>, "relativePath"> & {
    /** The document says `envId`, `envName`, `envSlug`; `slug` and `id` are what this has read. */
    environment?: FolderRead["environment"] & { slug?: string; id?: string };
  };

export type InfSecret = Partial<ApiListItem<operations["listSecretsV4"], "secrets">>;

/** What a secret write answers: the secret, or a change request when the environment needs approval. */
export interface InfSecretWrite {
  secret?: InfSecret;
  approval?: object;
}

export type InfDynamicSecret = ApiListItem<operations["listDynamicSecrets"], "dynamicSecrets">;

export type InfLease = ApiListItem<operations["listDynamicSecretLeases"], "leases">;

export type InfSecretSync = components["schemas"]["SecretSync"];

export type InfSyncOption = ApiListItem<operations["listSecretSyncOptions"], "secretSyncOptions">;

export type InfIntegration = ApiListItem<operations["listProjectIntegrations"], "integrations"> & {
  /** Not in the document, which gives an integration no project. */
  projectId?: string;
};

type IdentityRead = ApiResponse<operations["getMachineIdentityById"]>["identity"];

/** A list row's `identity` is narrower than a read's: no `activeLockoutAuthMethods`, no `orgId`. */
export type InfIdentityMembership = Omit<IdentityRead, "identity"> & {
  identity: Partial<IdentityRead["identity"]>;
};

export type InfUniversalAuth = ApiResponse<operations["getUniversalAuth"]>["identityUniversalAuth"];

export type InfClientSecret = ApiListItem<
  operations["listUniversalAuthClientSecrets"],
  "clientSecretData"
>;

export type InfRole = Partial<ApiListItem<operations["listOrganizationRoles"], "roles">>;

export type InfCa = ApiListItem<operations["listProjectCertificateAuthorities"], "cas">;

export type InfCertificate = Partial<
  ApiListItem<operations["searchProjectCertificates"], "certificates">
>;

export type InfCertificateProfile = ApiListItem<
  operations["listCertificateProfiles"],
  "certificateProfiles"
>;

export type InfAuditLog = ApiListItem<operations["listOrganizationAuditLogs"], "auditLogs">;

export type AuditLogQuery = NonNullable<
  operations["listOrganizationAuditLogs"]["parameters"]["query"]
>;

export type ProjectIdentity = ApiListItem<
  paths["/api/v1/projects/{projectId}/identity-memberships"]["get"],
  "identityMemberships"
>;

export type UpdateProjectBody = ApiBody<operations["updateProject"]>;
export type UpdateEnvironmentBody = ApiBody<operations["updateEnvironment"]>;
export type UpdateSecretBody = ApiBody<operations["updateSecretV4"]>;
export type UpdateDynamicSecretData = ApiBody<operations["updateDynamicSecret"]>["data"];
export type UpdateSecretSyncBody = ApiBody<operations["updateSecretSync"]>;
export type UpdateIdentityBody = ApiBody<operations["updateMachineIdentity"]>;
export type UpdateUniversalAuthBody = ApiBody<operations["updateUniversalAuth"]>;
export type CertificateAltNames = NonNullable<
  NonNullable<ApiBody<operations["createCertificate"]>["attributes"]>["altNames"]
>;
