# `linux-appserver`

The remote half of Infrawrench's Linux application support: a headless Wayland compositor that runs on a customer's host and streams individual application windows back to a workspace tab.

It is a standalone Rust workspace, deliberately outside the pnpm workspace (see [Working on it](#working-on-it)).

## Why a compositor and not a VNC server

The feature is "open GIMP from this VM and get a tab with GIMP in it", not "get a desktop". A VNC server gives one framebuffer for a whole screen, so every window would share one tab and the tab bar would carry no information. Per-window streaming needs something that _is_ the window manager, which means being the compositor.

Being the compositor also removes the host's dependencies rather than adding to them: no X server, no VNC server, no desktop environment, no `xpra`. Infrawrench uploads one static binary over the SSH connection it already has and execs it as the user. That follows the same rule the embedded RDP client follows — bundle the dependency, never shell out to whatever the host happens to have installed.

## What is here

| Crate      | Builds on | What it is                                                                                                                             |
| ---------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `iw-proto` | anywhere  | The wire protocol: frame envelope, packed input events, JSON control messages. The field names here are the field names in TypeScript. |
| `iw-codec` | anywhere  | Damage-rectangle coalescing and the lossless encoder (solid fills + zstd'd pixels), plus the tier selector.                            |
| `iw-apps`  | anywhere  | XDG desktop entries and icon theme resolution — what is installed on the host and what it looks like.                                  |
| `iwappd`   | anywhere¹ | The daemon: protocol state machine, flow control, launcher, and the environment applications are spawned into.                         |

¹ The `Backend` trait it drives is implemented by a Smithay compositor that only exists on Linux. Everything above that seam — which is most of the interesting logic — builds and tests on macOS too, which is the point of the split.

### Not here yet

The compositor itself. `iwappd --serve` exits with code 3 and says so. `--list-apps` and `--caps` work today and need no compositor, which is what `infrawrench apps list` will use over a plain SSH exec.

## Design notes worth knowing before changing things

**The encoder models the client's canvas, not the app's last frame.** `Encoder::prev` is what we believe the viewer is holding, so rectangles whose pixels did not actually change are dropped (toolkits over-report damage constantly). The consequence is a rule: **a frame that is encoded must be sent.** Flow-control drops happen _before_ encoding, by accumulating damage rectangles and encoding once, later, against the same `prev`. Dropping after encoding would leave the client holding pixels the encoder believes it already has.

**One codec is wrong for this workload.** A terminal is nearly static text where lossy compression looks like a smear; a video player redraws everything at 30 Hz and lossless costs more bandwidth than we have. `TierSelector` watches how much of the window each frame redraws and moves between tiers with hysteresis, because flipping costs a keyframe.

**VP9, not H.264.** x264 is GPL and cannot be linked into a binary we distribute under BUSL; openh264's patent umbrella covers Cisco's binaries, not ours. libvpx is BSD-3 and royalty-free, and VP9 decode is universal in Chromium — so it is always available in Electron, and `WebCodecs` covers the browsers.

**The launch environment is where "works on a bare cloud VM" is won.** A stock server image has no GPU, often no mesa, and frequently no `XDG_RUNTIME_DIR` at all. `launch_env` forces every toolkit onto a software path; `GSK_RENDERER=cairo` is the load-bearing one, because GTK4 defaults to a GL renderer and dies outright without mesa.

**A parentless toplevel is a tab; anything with a parent is not.** Dialogs and popups composite into their parent's frame. Without that rule, opening a menu spawns a workspace tab.

## Working on it

```
cd linux-appserver
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Rust 1.85+ (edition 2024). This module is **not** in `pnpm-workspace.yaml`, `turbo.json`, or the JS CI — `.github/workflows/linux-appserver.yml` runs exactly the three commands above and nothing else reaches it. It _is_ in `cliff.toml`'s `include_paths`, because the desktop app ships this binary and changes to it are user-visible in the desktop changelog.

There are no runtime dependencies beyond `serde`, `thiserror` and `zstd`. Everything here ends up on someone else's machine, so the bar for adding one is high.

## Licence

BUSL-1.1, the same as the rest of the repository. (The Terraform provider is MIT because people vendor it; nobody vendors this.)
