// The bearer check. Keys are compared as SHA-256 digests, byte by byte
// without stopping early, so neither the length nor a matching prefix of
// the key shows in the time a wrong guess takes.

async function digest(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

export async function sameKey(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([digest(given), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0 && expected.length > 0;
}

export async function authorised(request: Request, expected: string): Promise<boolean> {
  const header = request.headers.get("Authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  return sameKey(header.slice("Bearer ".length).trim(), expected);
}
