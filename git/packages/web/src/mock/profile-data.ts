/**
 * The pictures organisations uploaded in the dev mock. The Worker keeps them
 * in its bucket and serves them at `/-/avatar/...`; with no Worker here, the
 * mock keeps each as a `data:` URL under the same path and `imageSrc` asks
 * {@link mockAvatar} for it.
 */
import {
  AVATAR_EXTENSIONS,
  avatarPath,
  decodeBase64,
  inspectAvatar,
} from "@infrawrench/git-contract";
import { badRequest } from "./define";

const pictures = new Map<string, string>();

/** The `data:` URL of a picture the mock holds, by its path. */
export const mockAvatar = (path: string): string | null => pictures.get(path) ?? null;

/** Checks an upload as the Worker does, keeps it, and answers the path it would be served at. */
export async function storeMockAvatar(namespaceId: string, base64: string): Promise<string> {
  const bytes = decodeBase64(base64);
  if (bytes === null) throw badRequest("The picture is not valid base64");
  const inspected = inspectAvatar(bytes);
  if (!inspected.ok) throw badRequest(inspected.problem);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const name = `${[...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32)}.${AVATAR_EXTENSIONS[inspected.image.type]}`;
  const path = avatarPath(namespaceId, name);
  pictures.set(path, `data:${inspected.image.type};base64,${base64}`);
  return path;
}

export function dropMockAvatar(path: string | null): void {
  if (path !== null) pictures.delete(path);
}
