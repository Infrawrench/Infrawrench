/** Clerk Backend API shapes, from the document (`../plugingen.json`). Timestamps are Unix ms. */
import type { components } from "./api-types.gen.js";

type Schemas = components["schemas"];

export type CkInstance = Schemas["Instance"];
export type CkOrgSettings = Schemas["OrganizationSettings"];
export type CkUser = Schemas["User"];
export type CkOrganization = Schemas["Organization"];
export type CkMembership = Schemas["OrganizationMembership"];
export type CkOrgRole = Schemas["Role"];
export type CkDomain = Schemas["Domain"];
export type CkJwtTemplate = Schemas["JWTTemplate"];
export type CkOAuthApp = Schemas["OAuthApplication"];
export type CkEnterpriseConnection = Schemas["EnterpriseConnection"];
export type CkMachine = Schemas["Machine"];
export type CkIdentifier = Schemas["AllowlistIdentifier"] | Schemas["BlocklistIdentifier"];
export type CkInvitation = Schemas["Invitation"];
export type CkOrgInvitation = Schemas["OrganizationInvitation"];
export type CkRedirectUrl = Schemas["RedirectURL"];
export type CkSession = Schemas["Session"];
