import { badRequest, conflict, defineMockHandlers, notFound, ok } from "../define";
import { requireUser } from "../db";
import { fingerprintOf, keyInUse, newId, parsePublicKey, tokens, userKeys } from "../settings-data";

const HEX = "0123456789abcdef";
const randomHex = (length: number): string =>
  Array.from({ length }, () => HEX[Math.floor(Math.random() * 16)]).join("");

export default defineMockHandlers({
  account: {
    listKeys: () => {
      requireUser();
      return { keys: userKeys };
    },
    createKey: ({ payload }) => {
      requireUser();
      const parsed = parsePublicKey(payload.key);
      if (!parsed) throw badRequest("That is not a public key", "key_invalid");
      const fingerprint = fingerprintOf(parsed.body);
      if (keyInUse(fingerprint)) {
        throw conflict("That key is already in use somewhere else", "key_in_use");
      }
      const title = (payload.title ?? "").trim() || parsed.comment || "SSH key";
      const key = {
        id: newId("key"),
        title,
        algorithm: parsed.algorithm,
        fingerprint,
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
      };
      userKeys.push(key);
      return key;
    },
    deleteKey: ({ params }) => {
      requireUser();
      const index = userKeys.findIndex((key) => key.id === params.keyId);
      if (index < 0) throw notFound("Key not found");
      userKeys.splice(index, 1);
      return ok;
    },
    listTokens: () => {
      requireUser();
      return { tokens };
    },
    createToken: ({ payload }) => {
      requireUser();
      if (payload.name.trim() === "") throw badRequest("A name is required");
      const secret = `iwg_${randomHex(40)}`;
      const token = {
        id: newId("tok"),
        name: payload.name.trim(),
        prefix: secret.slice(0, 12),
        scopes: [...payload.scopes],
        createdAt: new Date().toISOString(),
        expiresAt:
          payload.expiresInDays === undefined || payload.expiresInDays === null
            ? null
            : new Date(Date.now() + payload.expiresInDays * 86_400_000).toISOString(),
        lastUsedAt: null,
      };
      tokens.unshift(token);
      return { token, secret };
    },
    revokeToken: ({ params }) => {
      requireUser();
      const index = tokens.findIndex((token) => token.id === params.tokenId);
      if (index < 0) throw notFound("Token not found");
      tokens.splice(index, 1);
      return ok;
    },
  },
});
