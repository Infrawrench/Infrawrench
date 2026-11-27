/**
 * An organisation's uploaded picture: kept in the site's bucket and served
 * from the site's own origin (contract `avatarPath`), so the page's
 * `img-src 'self'` shows it and no other host ever learns who looks.
 *
 * **Stored** at `avatars/<namespace id>/<name>`, where `name` is 32 hex
 * digits of the file's SHA-256 and the extension of what its bytes are. The
 * name is the content, so the address never changes under a cache and a new
 * picture is a new address. What a file is comes from its own bytes
 * (contract `inspectAvatar`): the type its sender named is never read.
 *
 * **Served** to anyone, like the namespace's page (a namespace is never
 * private), with the type its extension says, `nosniff`, and a sandboxing
 * policy: opened in a tab it is an image and nothing else. Only a path of
 * the exact shape reaches the bucket, so nothing else under it can be read
 * through here.
 */
import type { R2Bucket } from "@cloudflare/workers-types/index";
import {
  AVATAR_EXTENSIONS,
  type AvatarImage,
  type AvatarType,
  avatarPath,
  decodeBase64,
  inspectAvatar,
  parseAvatarPath,
} from "@infrawrench/git-contract";

/** What this module needs of the bucket. */
export type AvatarBucket = Pick<R2Bucket, "get" | "put" | "delete">;

/** The policy a picture goes back with: a document opened from it can do nothing. */
export const AVATAR_CONTENT_SECURITY_POLICY = "default-src 'none'; sandbox";

const TYPE_OF_EXTENSION: Record<string, AvatarType> = Object.fromEntries(
  Object.entries(AVATAR_EXTENSIONS).map(([type, extension]) => [extension, type as AvatarType]),
);

const keyOf = (namespaceId: string, name: string): string => `avatars/${namespaceId}/${name}`;

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** Names a stored file. Not a Git object id: those are `core`'s collision-detecting SHA-1. */
const nameOf = async (bytes: Uint8Array<ArrayBuffer>, type: AvatarType): Promise<string> => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `${hex(digest).slice(0, 32)}.${AVATAR_EXTENSIONS[type]}`;
};

export type AvatarUpload =
  | { readonly ok: true; readonly bytes: Uint8Array<ArrayBuffer>; readonly image: AvatarImage }
  | { readonly ok: false; readonly problem: string };

/** The file an upload's base64 stands for, checked, or the sentence that refuses it. */
export const readAvatarUpload = (base64: string): AvatarUpload => {
  const bytes = decodeBase64(base64);
  if (bytes === null) return { ok: false, problem: "The picture is not valid base64" };
  const inspected = inspectAvatar(bytes);
  return inspected.ok ? { ok: true, bytes, image: inspected.image } : inspected;
};

/** Keeps a checked picture and answers the path it is served at. */
export const storeAvatar = async (
  bucket: AvatarBucket,
  namespaceId: string,
  upload: Extract<AvatarUpload, { ok: true }>,
): Promise<string> => {
  const name = await nameOf(upload.bytes, upload.image.type);
  await bucket.put(keyOf(namespaceId, name), upload.bytes as never, {
    httpMetadata: { contentType: upload.image.type },
  });
  return avatarPath(namespaceId, name);
};

/**
 * Deletes the file a namespace's `avatar_url` names, when it is one of this
 * namespace's uploads. Anything else (a person's picture from their account,
 * another namespace's path) is left alone.
 */
export const deleteStoredAvatar = async (
  bucket: AvatarBucket,
  namespaceId: string,
  avatarUrl: string | null,
): Promise<void> => {
  const parsed = avatarUrl === null ? null : parseAvatarPath(avatarUrl);
  if (parsed === null || parsed.namespaceId !== namespaceId) return;
  await bucket.delete(keyOf(parsed.namespaceId, parsed.name));
};

/** A stored picture's bytes and type by its path, for the link preview renderer. Null when there is none. */
export const readStoredAvatar = async (
  bucket: AvatarBucket,
  path: string,
): Promise<{ readonly bytes: Uint8Array; readonly type: AvatarType } | null> => {
  const parsed = parseAvatarPath(path);
  if (parsed === null) return null;
  const object = await bucket.get(keyOf(parsed.namespaceId, parsed.name));
  if (object === null) return null;
  const type = TYPE_OF_EXTENSION[parsed.name.slice(parsed.name.lastIndexOf(".") + 1)]!;
  return { bytes: new Uint8Array(await object.arrayBuffer()), type };
};

const plain = (status: number, body: string, extra: Record<string, string> = {}): Response =>
  new Response(`${body}\n`, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...extra },
  });

/** `GET /-/avatar/<namespace id>/<name>`. */
export const serveAvatar = async (request: Request, bucket: AvatarBucket): Promise<Response> => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return plain(405, "Method Not Allowed", { allow: "GET, HEAD" });
  }
  const parsed = parseAvatarPath(new URL(request.url).pathname);
  if (parsed === null) return plain(404, "Not Found");
  const object = await bucket.get(keyOf(parsed.namespaceId, parsed.name));
  if (object === null) return plain(404, "Not Found");
  const type = TYPE_OF_EXTENSION[parsed.name.slice(parsed.name.lastIndexOf(".") + 1)]!;
  const headers = {
    "content-type": type,
    "content-length": String(object.size),
    // The name is the content: this address never serves anything else.
    "cache-control": "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
    "content-security-policy": AVATAR_CONTENT_SECURITY_POLICY,
  };
  if (request.method === "HEAD") {
    await object.body.cancel().catch(() => undefined);
    return new Response(null, { status: 200, headers });
  }
  return new Response(object.body as never, { status: 200, headers });
};
