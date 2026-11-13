/**
 * The slug a CI job's throwaway app runs: a gzipped tar of `./app/` holding
 * one file, the job's script. Heroku runs a dyno from a slug on top of its
 * stack image, so the slug carries nothing else (no buildpack output, no
 * process that serves). Built here, in memory, without a build: a ustar
 * archive is a few 512-byte blocks, and `CompressionStream` gzips it.
 */

const BLOCK = 512;

function octal(value: number, width: number): string {
  // `width - 1` digits and a NUL, as ustar wants.
  return value.toString(8).padStart(width - 1, "0") + "\0";
}

function header(name: string, size: number, mode: number, type: "0" | "5"): Uint8Array {
  const block = new Uint8Array(BLOCK);
  const put = (text: string, at: number) => block.set(new TextEncoder().encode(text), at);
  if (new TextEncoder().encode(name).length > 100) throw new Error(`tar name too long: ${name}`);
  put(name, 0);
  put(octal(mode, 8), 100);
  put(octal(0, 8), 108); // uid
  put(octal(0, 8), 116); // gid
  put(octal(size, 12), 124);
  put(octal(0, 12), 136); // mtime: the epoch, so the archive is the same for the same script
  put("        ", 148); // checksum, as spaces while it is summed
  put(type, 156);
  put("ustar\u000000", 257);
  let sum = 0;
  for (const byte of block) sum += byte;
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return block;
}

/** An uncompressed tar of `./app/` with `./app/<file>` (mode 0755) in it. */
export function slugTar(file: string, content: string): Uint8Array {
  const body = new TextEncoder().encode(content);
  const padded = Math.ceil(body.length / BLOCK) * BLOCK;
  const out = new Uint8Array(BLOCK * 2 + padded + BLOCK * 2);
  out.set(header("./app/", 0, 0o755, "5"), 0);
  out.set(header(`./app/${file}`, body.length, 0o755, "0"), BLOCK);
  out.set(body, BLOCK * 2);
  // Two zero blocks end the archive; the array is zeroed already.
  return out;
}

/** `bytes`, gzipped. */
export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The slug for a job: `./app/<file>` holding `script`, as a `.tgz`. */
export function slugArchive(file: string, script: string): Promise<Uint8Array> {
  return gzip(slugTar(file, script));
}
