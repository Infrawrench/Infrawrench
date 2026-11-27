import { badRequest, conflict, defineMockHandlers, mockError, notFound, ok } from "../define";
import { botForEmail } from "@infrawrench/git-contract";
import { requireUser, session } from "../db";
import { FIXTURE_PEOPLE } from "../git";
import {
  MOCK_COMMIT_EMAIL_CODE,
  commitEmails,
  fingerprintOf,
  keyInUse,
  newId,
  parsePublicKey,
  tokens,
  userKeys,
} from "../settings-data";

const HEX = "0123456789abcdef";
const randomHex = (length: number): string =>
  Array.from({ length }, () => HEX[Math.floor(Math.random() * 16)]).join("");

const commitEmail = (id: string) => {
  const found = commitEmails.find((email) => email.id === id);
  if (!found) throw notFound("No such address");
  return found;
};

export default defineMockHandlers({
  account: {
    listCommitEmails: () => {
      requireUser();
      return { emails: commitEmails };
    },
    addCommitEmail: ({ payload }) => {
      const me = requireUser();
      const email = payload.email.trim().toLowerCase();
      if (!session().organizations.some((org) => org.id === payload.organizationId)) {
        throw mockError(403, "You are not a member of that organisation", "not_a_member");
      }
      if (!/^[^\s@,;]+@[^\s@,;.]+(\.[^\s@,;.]+)+$/.test(email)) {
        throw badRequest("That doesn't look like an email address", "email_invalid");
      }
      if (botForEmail(email) !== null) {
        throw badRequest("That address belongs to a bot account", "email_invalid");
      }
      const account = FIXTURE_PEOPLE[email];
      if (account?.id === me.id) {
        throw badRequest("That is the address on your account already", "email_invalid");
      }
      if (account !== undefined) {
        throw conflict("That address belongs to another member of the organisation", "email_taken");
      }
      if (
        commitEmails.some(
          (row) => row.organizationId === payload.organizationId && row.email === email,
        )
      ) {
        throw conflict("You have added that address already", "email_taken");
      }
      const now = new Date().toISOString();
      const added = {
        id: newId("cem"),
        organizationId: payload.organizationId,
        email,
        verifiedAt: null,
        codeSentAt: now,
        createdAt: now,
      };
      commitEmails.push(added);
      return added;
    },
    sendCommitEmailCode: ({ params }) => {
      requireUser();
      const email = commitEmail(params.emailId);
      email.codeSentAt = new Date().toISOString();
      return email;
    },
    verifyCommitEmail: ({ params, payload }) => {
      requireUser();
      const email = commitEmail(params.emailId);
      const typed = payload.code.toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (typed !== MOCK_COMMIT_EMAIL_CODE.replace("-", "")) {
        throw badRequest("That code is not right", "code_invalid");
      }
      email.verifiedAt = new Date().toISOString();
      return email;
    },
    removeCommitEmail: ({ params }) => {
      requireUser();
      const index = commitEmails.findIndex((email) => email.id === params.emailId);
      if (index < 0) throw notFound("No such address");
      commitEmails.splice(index, 1);
      return ok;
    },
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
