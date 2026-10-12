import {
  remediationDateStamp,
  remediationField,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
  type RemediationPlaceholder,
  type RemediationResource,
  type SeatRemediationFinding,
} from "@infrawrench/plugin-base";

/**
 * Remediation for Docker Hub savings findings, as `curl` against the Hub API.
 *
 * No official tool deletes a Hub repository or tag: the Docker CLI has no
 * remote delete, `docker/hub-tool` (which had `repo rm` / `tag rm`) is
 * archived, and Docker Scout does not manage repositories. The published Hub
 * API reference (https://docs.docker.com/reference/api/hub/latest/) documents
 * the token exchange and the repository and tag reads, but no DELETE for
 * either. The deletes below are the routes Docker's own clients call and this
 * plugin's Delete action uses: `DELETE /v2/repositories/{ns}/{repo}/` in
 * `docker/terraform-provider-docker` (`hubclient/client_repository.go`) and
 * hub-tool, and `DELETE /v2/repositories/{ns}/{repo}/tags/{tag}/` in hub-tool
 * (`pkg/hub/tags.go`). Each delete's description says so.
 *
 * The documented registry route (`DELETE registry-1.docker.io/v2/{name}/manifests/{digest}`,
 * https://docs.docker.com/reference/api/registry/latest/) is not used: it
 * deletes by digest only, takes every tag pointing at that digest with it, and
 * refuses a manifest a tag still references.
 *
 * - A never-pulled repository (orphan): get a bearer token, save the
 *   repository's settings and tag list, then delete it.
 * - An inactive tag (orphan): get a bearer token, `docker pull` the tag to keep
 *   a local copy, then delete the tag.
 */
export function dockerHubRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind !== "orphan") return [];
  const { resource } = finding;

  if (resource.resourceTypeId === "dockerhub-repository") {
    const ref = repositoryRef(resource);
    if (!ref) return [];
    const base = `/v2/namespaces/${enc(ref.ns)}/repositories/${enc(ref.repo)}`;
    const file = (what: string) =>
      `${`${ref.ns}_${ref.repo}`.replace(/[^A-Za-z0-9_.-]/g, "_")}-${what}-${remediationDateStamp()}.json`;
    return [
      tokenCommand(),
      {
        tool: "curl",
        command: `${get(base)} > ${shellQuote(file("repository"))}`,
        description:
          "Save the repository's settings (description, overview, visibility) so it can be recreated.",
        destructive: false,
        placeholders: [JWT],
      },
      {
        tool: "curl",
        command: `${get(`${base}/tags?page_size=100`)} > ${shellQuote(file("tags"))}`,
        description: "Save the first 100 tags with their digests, the images the delete removes.",
        destructive: false,
        placeholders: [JWT],
      },
      {
        tool: "curl",
        command: del(`/v2/repositories/${enc(ref.ns)}/${enc(ref.repo)}/`),
        description:
          "Delete the repository and every image in it. This route is not in Docker's published Hub API reference; Docker's own Terraform provider and hub-tool call it.",
        destructive: true,
        placeholders: [JWT],
      },
    ];
  }

  if (resource.resourceTypeId === "dockerhub-tag") {
    const ref = tagRef(resource);
    if (!ref) return [];
    return [
      tokenCommand(),
      {
        tool: "docker",
        command: `docker pull ${shellQuote(`docker.io/${ref.ns}/${ref.repo}:${ref.tag}`)}`,
        description: "Pull the tag to keep a local copy of the image.",
        destructive: false,
      },
      {
        tool: "curl",
        command: del(`/v2/repositories/${enc(ref.ns)}/${enc(ref.repo)}/tags/${enc(ref.tag)}/`),
        description:
          "Delete the tag. This route is not in Docker's published Hub API reference; Docker's archived hub-tool CLI calls it.",
        destructive: true,
        placeholders: [JWT],
      },
    ];
  }

  return [];
}

/**
 * Remediation for Docker seat findings. Inactive or duplicate: get a bearer
 * token, show the member's row (role, teams, last sign-in), then remove them
 * from the organization with the documented
 * `DELETE /v2/orgs/{org}/members/{username}`
 * (https://docs.docker.com/reference/api/hub/latest/, operation
 * deleteV2OrgsByOrgNameMembersByUsername). Removing frees the seat; the bill
 * only drops once the seat count is reduced in Billing. Downgrade: never
 * produced, the API does not report the plan.
 */
export function dockerHubSeatRemediationCommands(
  finding: SeatRemediationFinding,
): RemediationCommand[] {
  if (finding.reason === "downgrade") return [];
  const { seat } = finding;
  const i = seat.memberId.indexOf("/");
  const org = (seat.context["org"] ?? "").trim() || (i > 0 ? seat.memberId.slice(0, i) : "");
  const username = (seat.login ?? "").trim() || (i > 0 ? seat.memberId.slice(i + 1) : "");
  if (!org || !username) return [];
  const members = `/v2/orgs/${enc(org)}/members`;
  const filter = `.results[] | select(.username == ${JSON.stringify(username)})`;
  return [
    tokenCommand(),
    {
      tool: "curl",
      command: `${get(`${members}?page_size=100&search=${enc(username)}`)} | jq ${shellQuote(filter)}`,
      description: `Show ${username}'s role, teams and last sign-in in ${org} before removing them.`,
      destructive: false,
      placeholders: [JWT],
    },
    {
      tool: "curl",
      command: del(`${members}/${enc(username)}`),
      description:
        "Remove the member from the organization and all its teams, freeing the seat; they can be invited again later. Then reduce the seat count in Billing, or Docker keeps charging for the empty seat.",
      destructive: false,
      placeholders: [JWT],
    },
  ];
}

const HUB = "https://hub.docker.com";

const CREDENTIALS: RemediationPlaceholder[] = [
  {
    name: "DOCKERHUB_USERNAME",
    description: "Your Docker ID, or the organization name for an organization access token",
  },
  {
    name: "DOCKERHUB_TOKEN",
    description:
      "A personal access token with Read, Write & Delete access, or an organization access token that may delete repositories and tags",
  },
];

const JWT: RemediationPlaceholder = {
  name: "DOCKERHUB_JWT",
  description: "The bearer token the first command sets (it lasts ten minutes)",
};

const enc = encodeURIComponent;

/**
 * The documented token exchange (`POST /v2/auth/token`). The body is built by
 * `jq` so a secret holding quotes still makes valid JSON; `-f` leaves the
 * variable empty on a rejected login instead of setting it to `null`.
 */
function tokenCommand(): RemediationCommand {
  return {
    tool: "curl",
    command:
      `DOCKERHUB_JWT=$(jq -n --arg identifier "$DOCKERHUB_USERNAME" --arg secret "$DOCKERHUB_TOKEN"` +
      ` '{identifier: $identifier, secret: $secret}'` +
      ` | curl -sSf -X POST ${HUB}/v2/auth/token -H 'Content-Type: application/json' --data-binary @-` +
      ` | jq -r .access_token)`,
    description:
      "Exchange your access token for a short-lived Docker Hub bearer token (documented: Create access token). Needs jq.",
    destructive: false,
    placeholders: CREDENTIALS,
  };
}

function get(path: string): string {
  return `curl -sS --fail-with-body ${shellQuote(HUB + path)} -H "Authorization: Bearer $DOCKERHUB_JWT"`;
}

function del(path: string): string {
  return `curl -sS --fail-with-body -X DELETE ${shellQuote(HUB + path)} -H "Authorization: Bearer $DOCKERHUB_JWT"`;
}

/** `ns/name` from the fields, else the externalId. */
function repositoryRef(resource: RemediationResource): { ns: string; repo: string } | null {
  const ns = remediationField(resource, "namespace");
  const repo = remediationField(resource, "name");
  if (ns && repo) return { ns, repo };
  return splitRepo((resource.externalId ?? "").trim());
}

/** `ns/repo:tag` from the fields, else the externalId (a tag holds no colon or slash). */
function tagRef(resource: RemediationResource): { ns: string; repo: string; tag: string } | null {
  const fromFields = splitRepo(remediationField(resource, "repository"));
  const fieldTag = remediationField(resource, "tag");
  if (fromFields && fieldTag) return { ...fromFields, tag: fieldTag };
  const id = (resource.externalId ?? "").trim();
  const i = id.lastIndexOf(":");
  if (i <= 0) return null;
  const repo = splitRepo(id.slice(0, i));
  const tag = id.slice(i + 1);
  return repo && tag && !tag.includes("/") ? { ...repo, tag } : null;
}

function splitRepo(id: string): { ns: string; repo: string } | null {
  const i = id.indexOf("/");
  if (i <= 0 || i === id.length - 1) return null;
  return { ns: id.slice(0, i), repo: id.slice(i + 1) };
}
