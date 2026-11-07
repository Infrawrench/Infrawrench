import { createHash } from "node:crypto";
import ts from "typescript";

const OPERATION_REF = /\boperations\["([^"]+)"\]/g;
const COMPONENT_REF = /\bcomponents\["([^"]+)"\]\["([^"]+)"\]/g;
/** What `shareRepeatedTypes` names an alias. */
const ALIAS_REF = /\b[A-Za-z_][A-Za-z0-9_]*_[0-9a-f]{8}\b/g;

function memberName(member: ts.TypeElement, file: ts.SourceFile): string | undefined {
  const name = member.name;
  if (!name) return undefined;
  return ts.isStringLiteralLike(name) ? name.text : name.getText(file);
}

function flatten(node: ts.Node, file: ts.SourceFile): string {
  return node.getText(file).replace(/\s+/g, " ");
}

/** Maps `GET /route` to a hash of its type and every named type that type reaches. */
export function operationFingerprints(source: string): Map<string, string> {
  const file = ts.createSourceFile("gen.ts", source, ts.ScriptTarget.Latest, true);
  const named = new Map<string, string>();
  const routes: ts.TypeElement[] = [];

  const indexMembers = (
    members: readonly ts.TypeElement[],
    key: (name: string) => string,
    recurse: boolean,
  ): void => {
    for (const member of members) {
      const name = memberName(member, file);
      if (name === undefined || !ts.isPropertySignature(member) || !member.type) continue;
      if (recurse && ts.isTypeLiteralNode(member.type)) {
        indexMembers(member.type.members, (inner) => `components.${name}.${inner}`, false);
      } else {
        named.set(key(name), flatten(member.type, file));
      }
    }
  };
  for (const statement of file.statements) {
    if (ts.isTypeAliasDeclaration(statement)) {
      named.set(statement.name.text, flatten(statement.type, file));
    } else if (ts.isInterfaceDeclaration(statement)) {
      if (statement.name.text === "paths") routes.push(...statement.members);
      if (statement.name.text === "operations") {
        indexMembers(statement.members, (name) => `operations.${name}`, false);
      }
      if (statement.name.text === "components") {
        indexMembers(statement.members, (name) => `components.${name}`, true);
      }
    }
  }

  const closure = (start: string): string => {
    const seen = new Map<string, string>();
    const pending = [start];
    for (let text = pending.pop(); text !== undefined; text = pending.pop()) {
      const keys = [
        ...[...text.matchAll(OPERATION_REF)].map((match) => `operations.${match[1]}`),
        ...[...text.matchAll(COMPONENT_REF)].map((match) => `components.${match[1]}.${match[2]}`),
        ...[...text.matchAll(ALIAS_REF)].map((match) => match[0]),
      ];
      for (const key of keys) {
        const body = named.get(key);
        if (body === undefined || seen.has(key)) continue;
        seen.set(key, body);
        pending.push(body);
      }
    }
    const reached = [...seen].map(([key, body]) => `${key}=${body}`).sort();
    return createHash("sha256")
      .update([start, ...reached].join("\n"))
      .digest("hex");
  };

  const fingerprints = new Map<string, string>();
  for (const route of routes) {
    const routeName = memberName(route, file);
    if (routeName === undefined || !ts.isPropertySignature(route) || !route.type) continue;
    if (!ts.isTypeLiteralNode(route.type)) continue;
    const members = route.type.members;
    const shared = members.find((member) => memberName(member, file) === "parameters");
    const sharedText = shared ? flatten(shared, file) : "";
    for (const member of members) {
      const method = memberName(member, file);
      if (method === undefined || method === "parameters") continue;
      if (!ts.isPropertySignature(member) || !member.type) continue;
      if (member.type.kind === ts.SyntaxKind.NeverKeyword) continue;
      fingerprints.set(
        `${method.toUpperCase()} ${routeName}`,
        closure(`${sharedText}\n${flatten(member.type, file)}`),
      );
    }
  }
  return fingerprints;
}

/** The operations whose types differ between two generated files. */
export function affectedOperations(before: string, after: string): string[] {
  const old = operationFingerprints(before);
  const fresh = operationFingerprints(after);
  return [...new Set([...old.keys(), ...fresh.keys()])]
    .filter((operation) => old.get(operation) !== fresh.get(operation))
    .sort();
}
