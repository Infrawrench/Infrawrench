// Types `ctx.exports` from this Worker's own exports, which is what lets the
// gateway call `ctx.exports.Bundles.fetch` with a checked name.
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./index");
  }
}
