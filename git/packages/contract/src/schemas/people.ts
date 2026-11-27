/**
 * People and namespaces as the forge shows them.
 */
import { Schema } from "effect";
import { GIT_PERMISSIONS } from "../http/annotations";
import { IsoDateTime, Visibility } from "./common";

/**
 * A person, wherever one is named: an author, an assignee, a reviewer. `id`
 * is the Infrawrench user id. `username` is null until they claim one, which
 * only happens for people named by the app's own tables (an organisation
 * member who has never opened the forge).
 */
export const UserRef = Schema.Struct({
  id: Schema.String,
  username: Schema.NullOr(Schema.String),
  displayName: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
}).annotate({ identifier: "UserRef" });
export type UserRef = typeof UserRef.Type;

export const NamespaceKind = Schema.Literals(["user", "org"]).annotate({
  identifier: "NamespaceKind",
});
export type NamespaceKind = typeof NamespaceKind.Type;

/** A namespace where one is named beside something else (a repository's owner). */
export const NamespaceRef = Schema.Struct({
  slug: Schema.String,
  kind: NamespaceKind,
  displayName: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
}).annotate({ identifier: "NamespaceRef" });
export type NamespaceRef = typeof NamespaceRef.Type;

/** What the viewer may do in a namespace, for the buttons its page shows. */
export const NamespaceViewer = Schema.Struct({
  isOwner: Schema.Boolean.annotate({
    description: "The viewer's own namespace, or an organisation they hold `git:admin` in.",
  }),
  canCreateRepository: Schema.Boolean,
  canAdminister: Schema.Boolean.annotate({
    description: "May edit the profile and rename the namespace.",
  }),
  permissions: Schema.Array(Schema.Literals(GIT_PERMISSIONS)).annotate({
    description:
      "The viewer's `git:*` permissions in the organisation. Empty for a user namespace and for non-members.",
  }),
}).annotate({ identifier: "NamespaceViewer" });
export type NamespaceViewer = typeof NamespaceViewer.Type;

/** A user's or an organisation's page. */
export const Namespace = Schema.Struct({
  id: Schema.String,
  slug: Schema.String,
  kind: NamespaceKind,
  displayName: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
  websiteUrl: Schema.NullOr(Schema.String),
  location: Schema.NullOr(Schema.String),
  userId: Schema.NullOr(Schema.String).annotate({
    description: "The Infrawrench user, for a user namespace.",
  }),
  organizationId: Schema.NullOr(Schema.String).annotate({
    description:
      "The Infrawrench organisation, for an organisation's namespace. Only sent to its members.",
  }),
  appUrl: Schema.NullOr(Schema.String).annotate({
    description: "The organisation in the Infrawrench app. Only sent to its members.",
  }),
  repositoryCount: Schema.Int.annotate({
    description: "Repositories the viewer can see.",
  }),
  createdAt: IsoDateTime,
  viewer: NamespaceViewer,
}).annotate({ identifier: "Namespace" });
export type Namespace = typeof Namespace.Type;

export const NamespaceUpdate = Schema.Struct({
  displayName: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(100)))),
  description: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(500)))),
  websiteUrl: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(500)))),
  location: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(100)))),
}).annotate({ identifier: "NamespaceUpdate" });
export type NamespaceUpdate = typeof NamespaceUpdate.Type;

/** An Infrawrench organisation the signed-in person belongs to. */
export const SessionOrganization = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  namespace: Schema.NullOr(Schema.String).annotate({
    description: "Its namespace's slug, or null while nobody has claimed one.",
  }),
  permissions: Schema.Array(Schema.Literals(GIT_PERMISSIONS)).annotate({
    description: "The person's `git:*` permissions there.",
  }),
  // git-feature-flag: remove with the flag (KNOWLEDGE.md "Git feature flag").
  gitEnabled: Schema.Boolean.annotate({
    description:
      "Whether Git is turned on for the organisation in the app. Only claiming its namespace reads this: one that has a namespace keeps working either way.",
  }),
  namespacePlanRefusal: Schema.NullOr(Schema.String).annotate({
    description:
      "Why the organisation's plan does not let it claim a namespace, as the sentence the claim would refuse with: an organisation's namespace needs a paid plan. Null when the plan allows it, and for one that has a namespace.",
  }),
  canClaimNamespace: Schema.Boolean.annotate({
    description:
      "Holds `git:admin` in a signed-in browser, Git is on for the organisation, its plan allows it and it has no namespace yet.",
  }),
  privateRepositories: Schema.Boolean.annotate({
    description: "One more private repository fits the organisation's plan.",
  }),
  privateRepositoryRefusal: Schema.NullOr(Schema.String).annotate({
    description:
      "Why not, as the sentence `create` would refuse with. Null when `privateRepositories` is true.",
  }),
  defaultVisibility: Visibility.annotate({
    description:
      "What a new repository in its namespace starts as, set in the app (Settings > Git).",
  }),
}).annotate({ identifier: "SessionOrganization" });
export type SessionOrganization = typeof SessionOrganization.Type;

export const SessionUser = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  username: Schema.NullOr(Schema.String),
  displayName: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
}).annotate({ identifier: "SessionUser" });
export type SessionUser = typeof SessionUser.Type;

/**
 * Who is signed in. `user` is null for a signed-out browser, which every page
 * of a public repository still renders for.
 */
export const Session = Schema.Struct({
  user: Schema.NullOr(SessionUser),
  onboarding: Schema.NullOr(
    Schema.Struct({
      needsUsername: Schema.Boolean.annotate({
        description:
          "Signed in without a username yet: send them to the username page before anything that writes.",
      }),
      suggestedUsername: Schema.NullOr(Schema.String).annotate({
        description: "A free, valid username derived from their name or email, to prefill.",
      }),
      // git-feature-flag: remove with the flag (KNOWLEDGE.md "Git feature flag").
      signupsOpen: Schema.Boolean.annotate({
        description:
          "Whether this person may claim a username yet. Sign-ups are open to members of an Infrawrench organisation that has Git turned on.",
      }),
    }),
  ).annotate({ description: "Null when signed out." }),
  personal: Schema.NullOr(
    Schema.Struct({
      privateRepositories: Schema.Boolean.annotate({
        description: "One more private repository fits the person's own namespace.",
      }),
      privateRepositoryRefusal: Schema.NullOr(Schema.String).annotate({
        description: "Why not, as a sentence. Null when `privateRepositories` is true.",
      }),
      defaultVisibility: Visibility,
    }),
  ).annotate({
    description:
      "What the person's own namespace may take. Null when signed out or without a username.",
  }),
  organizations: Schema.Array(SessionOrganization),
  signInUrl: Schema.String.annotate({
    description: "Where to send a signed-out browser (`/auth/sign-in`); add `?returnTo=`.",
  }),
  appUrl: Schema.String.annotate({ description: "The Infrawrench app's origin, for links back." }),
  sshEnabled: Schema.Boolean.annotate({
    description: "Whether Git over SSH is offered: SSH clone URLs, SSH keys and deploy keys.",
  }),
}).annotate({ identifier: "Session" });
export type Session = typeof Session.Type;

export const UsernameAvailability = Schema.Struct({
  username: Schema.String,
  available: Schema.Boolean,
  reason: Schema.NullOr(Schema.Literals(["taken", "reserved", "invalid"])),
  message: Schema.NullOr(Schema.String).annotate({
    description: "Why not, as a sentence. Null when available.",
  }),
}).annotate({ identifier: "UsernameAvailability" });
export type UsernameAvailability = typeof UsernameAvailability.Type;
