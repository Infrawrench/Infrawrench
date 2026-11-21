// The standalone build inlines `.wasm` imports as bytes (esbuild's `binary` loader).
declare module "*.wasm" {
  const bytes: Uint8Array<ArrayBuffer>;
  export default bytes;
}
