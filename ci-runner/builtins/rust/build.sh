#!/usr/bin/env bash
# builtin:rust: the official stable Rust toolchain, run natively in a gVisor
# sandbox beside the job's environment (`abi: native-gvisor`; README
# "Native tools in a sandbox", "Rust"). Nothing is compiled here: the
# release's own components for each target, laid out as `rustup` would lay
# out a toolchain, at /opt/rust, and the C toolchain rustc needs to link.
#
# The components are the minimal profile (rustc, cargo, rust-std) and
# rustfmt and clippy. They are one builtin because they are one release:
# rustc's sysroot is its own directory's parent, cargo finds rustc, rustdoc,
# cargo-fmt and cargo-clippy on PATH and clippy-driver beside cargo-clippy,
# and none of them works with another version's. The tool has no program of
# its own; each is a command (`commands` in the manifest), placed at
# /usr/local/bin as a link to its file, so a program that looks for its
# libraries beside itself finds them.
#
# Linking. rustc links by running `cc`, and on x86_64 asks it for its own
# rust-lld (`-fuse-ld=lld`, its default since Rust 1.90); on aarch64 `cc`
# uses `ld`. The choice was between rust-lld alone (`-C linker=rust-lld`)
# and a real C compiler driver. rust-lld alone needs every C runtime object
# and library rustc leaves to `cc` (crt1.o, crti.o, crtbegin.o, -lc,
# -lgcc_s) spelled out per target in RUSTFLAGS, which a job's own RUSTFLAGS
# (`-D warnings` is common) replaces, and it compiles no C, which every
# crate with a `build.rs` that uses the `cc` crate needs (ring, zstd-sys,
# libgit2-sys, the *-sys crates generally). So `cc` is GCC 13's driver,
# Ubuntu 24.04's default, with cc1, collect2, binutils (as, ld, ar and the
# rest), glibc's and Linux's headers and crt objects, and the libraries
# they run on: C compiles and links as on Ubuntu, and Rust links the way it
# does on any Linux machine. C++ (g++, cc1plus, libstdc++'s headers) is not
# included, nor GCC's LTO (lto1).
#
# Every input is pinned by SHA-256: the Rust components against
# channel-rust-$RUST_VERSION.toml, the release's manifest, which is signed by
# the Rust release key (108F 6620 5EAE B0AA A8DD 5E1C 85AB 96E6 FA1B E5FE;
# check with `gpg --verify channel-rust-$RUST_VERSION.toml.asc` before
# copying new hashes from its `xz_hash` fields), and Ubuntu 24.04's packages
# (the release pocket, whose files stay in the archive for good) against the
# `Packages` index its signed `InRelease` names. A changed download fails
# the build. The manifest's own SHA-256 is pinned too and checked first.
#
# Needs: curl, sha256sum, python3, ar, tar with xz and zstd.
# shellcheck source=builtins/lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/../lib.sh"

RUST_VERSION=1.100.0
RUST_DATE=2026-11-12
RUST_CHANNEL_SHA256=3051e859570f64a8c5acb9d09e87425db52c7d97287c67e8f6d57d7d34ef9258
out="$(out_dir builtin rust "$RUST_VERSION")"

# target  archive (dist/$RUST_DATE/<name>-$RUST_VERSION-<target>-unknown-linux-gnu.tar.xz)  xz_hash
RUST_ARCHIVES=(
  "x86_64 rustc f1d0b1dec81dab6f523cd098507763487b0d4bd7fd2c87582f154128719be03b"
  "x86_64 cargo 7e29ce07d7c6e92d1826870575ba27d57fff6cb3e754aa57d99099cb88fab35d"
  "x86_64 rust-std 4591b6486594ded52ecd6135db95bf9355bbd3ca7a380888b141528bbcf9a5d4"
  "x86_64 rustfmt 4c9389e4722b16499e5d47d89837ec84a4ef755f105ed2a84c038156064e01ab"
  "x86_64 clippy 0d18df3bff6c852ef8243727fed075ecb33dbf93b8ab8c138c2f45e3f270102a"
  "aarch64 rustc fcbfa5b8a0cb28f0c4edfb6dda6910ee910993db31f05258613f5cd5b851263a"
  "aarch64 cargo d07ee80eb6ba3c5845c554ac88086e1ff5d63f83d99c3c09cb32504cbedd6844"
  "aarch64 rust-std c73f62fbe5d837f9807ed9e0076575dd8d3475c79af2b30e3570d328e6713f8f"
  "aarch64 rustfmt f99f80bcd169e8d7de018498d61a544315ead2060fb1e7d515f8ac82c088ef83"
  "aarch64 clippy 941f71acaf2a181d66776b3b889b72d64a90cc405b8f6c41a4b5ac8cd99a36b1"
)

# target  archive path (noble, main)  sha256
DEBS=(
  "x86_64 http://archive.ubuntu.com/ubuntu/pool/main/g/glibc/libc6_2.39-0ubuntu8_amd64.deb af36c7ac770770fe3d3c10e85d6bc538e76e57570ba7db7d397fb9f654783ef3"
  "x86_64 http://archive.ubuntu.com/ubuntu/pool/main/g/glibc/libc6-dev_2.39-0ubuntu8_amd64.deb 1f03b79223d9cf1a6ed3a648f6942619dcb97b2884dba8fd12e262b6771e247a"
  "x86_64 http://archive.ubuntu.com/ubuntu/pool/main/l/linux/linux-libc-dev_6.8.0-31.31_amd64.deb 21c631ba4da3d38d92a133e28a8a14278e1e00174ed135a20661d1e532e05ca5"
  "x86_64 http://archive.ubuntu.com/ubuntu/pool/main/libx/libxcrypt/libcrypt1_4.4.36-4build1_amd64.deb 9474785cd6f398512bf8c305c3901dbb111569dccb6f5832002373c0a8ac5832"
  "x86_64 http://archive.ubuntu.com/ubuntu/pool/main/libx/libxcrypt/libcrypt-dev_4.4.36-4build1_amd64.deb 2edff420ef80b4a3f3751e65c33423ef30e563122a58b759e4854ea8d84ba1b1"
  "x86_64 http://archive.ubuntu.com/ubuntu/pool/main/g/gcc-14/libstdc++6_14-20240412-0ubuntu1_amd64.deb 4863e880d6ee538e4734c430c5579c1ac933b88a42c25bc9980d0f148c54b21e"
  "x86_64 http://archive.ubuntu.com/ubuntu/pool/main/g/gcc-14/libgcc-s1_14-20240412-0ubuntu1_amd64.deb a39efdcaa2245f026dc3254ce14fcff255fc430a17064632b6ba7c5da974a912"
  "x86_64 http://archive.ubuntu.com/ubuntu/pool/main/g/gcc-13/libgcc-13-dev_13.2.0-23ubuntu4_amd64.deb d36c9acb969dd37fdc0496120715d8bba67a5cc43a0c2569717314e6ad80020c"
  "x86_64 http://archive.ubuntu.com/ubuntu/pool/main/g/gcc-13/gcc-13-x86-64-linux-gnu_13.2.0-23ubuntu4_amd64.deb 92f94ad8c5d42472fd032f7820aaeb9df2cc08559ef062a3a277573c03d26a08"
  "x86_64 http://archive.ubuntu.com/ubuntu/pool/main/g/gcc-13/cpp-13-x86-64-linux-gnu_13.2.0-23ubuntu4_amd64.deb b62ca3e8fe6fee933e1e92ab4330a666c09374ae6c49d5c01144142746e409f3"
  "x86_64 http://archive.ubuntu.com/ubuntu/pool/main/b/binutils/binutils-x86-64-linux-gnu_2.42-4ubuntu2_amd64.deb 1f3770dce907c26493217393ed24ca7484443381cafd04c81d6a6bef702b7416"
  "x86_64 http://archive.ubuntu.com/ubuntu/pool/main/b/binutils/libbinutils_2.42-4ubuntu2_amd64.deb 379b737386276ec099bf1fa4802d1ca6a4f020f2a81085b14caafac42ef7aec2"
  "x86_64 http://archive.ubuntu.com/ubuntu/pool/main/b/binutils/libctf0_2.42-4ubuntu2_amd64.deb 3497c775d5d72c4e1cb47f54b0ced6343a25818a6571408caa398b61f4fa74e8"
  "x86_64 http://archive.ubuntu.com/ubuntu/pool/main/b/binutils/libctf-nobfd0_2.42-4ubuntu2_amd64.deb f45396b6fecdfa94da09e057004b75801241db948ddb7c6d831cac0f58632549"
  "x86_64 http://archive.ubuntu.com/ubuntu/pool/main/b/binutils/libsframe1_2.42-4ubuntu2_amd64.deb 0b8d3e9338b2d47a523532463e341962edd1e669fb1760f12d82d7a68b33096a"
  "x86_64 http://archive.ubuntu.com/ubuntu/pool/main/j/jansson/libjansson4_2.14-2build2_amd64.deb 0cf79113f5d193ce9af2be2ff4b2c3b30dd4e55a0b6c47f7d28f6c849ff3aa60"
  "x86_64 http://archive.ubuntu.com/ubuntu/pool/main/libz/libzstd/libzstd1_1.5.5+dfsg2-2build1_amd64.deb 4dcc3ba9606a5837a55248d08162a5b426dd621f75c0eb24d86409e0d0e71d52"
  "x86_64 http://archive.ubuntu.com/ubuntu/pool/main/z/zlib/zlib1g_1.3.dfsg-3.1ubuntu2_amd64.deb 0b93d16d7498f092fa3070fbbad28cdbc6b3d640f1a7681b96fc37f20d1219f1"
  "x86_64 http://archive.ubuntu.com/ubuntu/pool/main/i/isl/libisl23_0.26-3build1_amd64.deb 24b1aa0e1772080fd23df7bed10aadcbbe16b3181b77d3a013c14dfaf9848541"
  "x86_64 http://archive.ubuntu.com/ubuntu/pool/main/m/mpclib3/libmpc3_1.3.1-1build1_amd64.deb 34af1193734f40723c7fc03d855d98c107d8b62bd2fa17dae8b09d2369cdd45e"
  "x86_64 http://archive.ubuntu.com/ubuntu/pool/main/m/mpfr4/libmpfr6_4.2.1-1build1_amd64.deb a25c2f5f123829ab144f31ddb22f4363b7206eb21bf821bfbecca5753ccfc6be"
  "x86_64 http://archive.ubuntu.com/ubuntu/pool/main/g/gmp/libgmp10_6.3.0+dfsg-2ubuntu6_amd64.deb 649a5ee5f74f0aa1e1b9c4f169eabbae56a79aa5aac51ef733eb9e18700bd8fc"
  "aarch64 http://ports.ubuntu.com/ubuntu-ports/pool/main/g/glibc/libc6_2.39-0ubuntu8_arm64.deb 04d7cb73e608b41713b63ef915577f7f5d75e95b1b33174e82e05687fdb6cfaf"
  "aarch64 http://ports.ubuntu.com/ubuntu-ports/pool/main/g/glibc/libc6-dev_2.39-0ubuntu8_arm64.deb cf8d2af040044ea5f9205a7a7a3eceabe9bc182fd780a1dac8e849f8eccee1f1"
  "aarch64 http://ports.ubuntu.com/ubuntu-ports/pool/main/l/linux/linux-libc-dev_6.8.0-31.31_arm64.deb 7fd438efa44a794b438e7dde7ac280166fb8d4b1cf7846393ce019714d8bb3e3"
  "aarch64 http://ports.ubuntu.com/ubuntu-ports/pool/main/libx/libxcrypt/libcrypt1_4.4.36-4build1_arm64.deb 5cd73ba112507dabd8e43b528ca9f530719a370e014b8e3e797770e6e940cccf"
  "aarch64 http://ports.ubuntu.com/ubuntu-ports/pool/main/libx/libxcrypt/libcrypt-dev_4.4.36-4build1_arm64.deb cadcc00021aa1082a8cb5cd1c2686b25b7a4d396f2029eaa1b12159ca46f1766"
  "aarch64 http://ports.ubuntu.com/ubuntu-ports/pool/main/g/gcc-14/libstdc++6_14-20240412-0ubuntu1_arm64.deb cd9ad360c8eee25e1fd9869303f4782eeaa47723594e85631c3def7ec42c3b08"
  "aarch64 http://ports.ubuntu.com/ubuntu-ports/pool/main/g/gcc-14/libgcc-s1_14-20240412-0ubuntu1_arm64.deb bb1c262f2ac9aeb357d3344a06f22f1057306694f6200896775a03ecced08b13"
  "aarch64 http://ports.ubuntu.com/ubuntu-ports/pool/main/g/gcc-13/libgcc-13-dev_13.2.0-23ubuntu4_arm64.deb f8faa5fee7174ec5fdd3eecbc27f38d530f7b500ad6763e2b57a9ac88622dc37"
  "aarch64 http://ports.ubuntu.com/ubuntu-ports/pool/main/g/gcc-13/gcc-13-aarch64-linux-gnu_13.2.0-23ubuntu4_arm64.deb afa768e7a0349c8dc1e0c43a2675ede405f097b6fd55f7188027470c4812dd8a"
  "aarch64 http://ports.ubuntu.com/ubuntu-ports/pool/main/g/gcc-13/cpp-13-aarch64-linux-gnu_13.2.0-23ubuntu4_arm64.deb b8062c2e37b8b44fd1cbfc193d2943761e1bd02e32dd0b47bea5ff860fcb4dcb"
  "aarch64 http://ports.ubuntu.com/ubuntu-ports/pool/main/b/binutils/binutils-aarch64-linux-gnu_2.42-4ubuntu2_arm64.deb 588fb547a21582c0be546db0fb2de4b1edef705dd7069e2dfdd45708b36d9a98"
  "aarch64 http://ports.ubuntu.com/ubuntu-ports/pool/main/b/binutils/libbinutils_2.42-4ubuntu2_arm64.deb f38ec0d006bf89d5b07f6dd2cf0f6206e78c79a04f4d6e41f680cddd75c13108"
  "aarch64 http://ports.ubuntu.com/ubuntu-ports/pool/main/b/binutils/libctf0_2.42-4ubuntu2_arm64.deb 921f29e63209d1ca4c6b4391132139c567121c6e2ebc2c1de25b25528dc713ea"
  "aarch64 http://ports.ubuntu.com/ubuntu-ports/pool/main/b/binutils/libctf-nobfd0_2.42-4ubuntu2_arm64.deb b8522683a59e988f2ea5db0fafe9f508780cc4e125e27e9a4f2d24bbcc6b9029"
  "aarch64 http://ports.ubuntu.com/ubuntu-ports/pool/main/b/binutils/libsframe1_2.42-4ubuntu2_arm64.deb 566a415cccb36807b88d5339b463cfe9c3c3890bdb6d097fb5d7a172f95f2b97"
  "aarch64 http://ports.ubuntu.com/ubuntu-ports/pool/main/j/jansson/libjansson4_2.14-2build2_arm64.deb a9d513eae76f4efb1c7370413bd21634fcfc0955e103d26af95f298af6c90abd"
  "aarch64 http://ports.ubuntu.com/ubuntu-ports/pool/main/libz/libzstd/libzstd1_1.5.5+dfsg2-2build1_arm64.deb 98568129024af1a71702d5a13f2e01c53afd5e2c3f71b2ee97fdd9a19cd97eda"
  "aarch64 http://ports.ubuntu.com/ubuntu-ports/pool/main/z/zlib/zlib1g_1.3.dfsg-3.1ubuntu2_arm64.deb 66aaebb68401a88b4f70a5f48e1a516b611fdcaae15208d8aee677c556d2cf01"
  "aarch64 http://ports.ubuntu.com/ubuntu-ports/pool/main/i/isl/libisl23_0.26-3build1_arm64.deb a65efa480539f8792960d24a02b7dcffd34c3ef9610660d7953d82ee1e8560f4"
  "aarch64 http://ports.ubuntu.com/ubuntu-ports/pool/main/m/mpclib3/libmpc3_1.3.1-1build1_arm64.deb cf8e14c8157fefbe33e63c87bd1810e716f4184d950ea620ec17be547aeb614f"
  "aarch64 http://ports.ubuntu.com/ubuntu-ports/pool/main/m/mpfr4/libmpfr6_4.2.1-1build1_arm64.deb 27d4a76723a77bfaa7c8035907bddf5d9c573d36165c476935f88c30e2fddee5"
  "aarch64 http://ports.ubuntu.com/ubuntu-ports/pool/main/g/gmp/libgmp10_6.3.0+dfsg-2ubuntu6_arm64.deb 8b09803a6318428836ed522f8891edb2a7cf3197433d6aa1bbdedcd07d4124db"
)

# fetch <url> <sha256> <file>: downloads and checks one input.
fetch() {
  curl -fsSL --retry 3 -o "$3" "$1"
  echo "$2  $3" | sha256sum -c --quiet
}

fetch "https://static.rust-lang.org/dist/channel-rust-$RUST_VERSION.toml" "$RUST_CHANNEL_SHA256" "$SCRATCH/channel.toml"

for target in x86_64 aarch64; do
  rust="$SCRATCH/rust-$target"
  mkdir -p "$rust"
  for entry in "${RUST_ARCHIVES[@]}"; do
    read -r arch component sha <<<"$entry"
    [[ "$arch" == "$target" ]] || continue
    name="$component-$RUST_VERSION-$target-unknown-linux-gnu"
    url="https://static.rust-lang.org/dist/$RUST_DATE/$name.tar.xz"
    # The pin is the signed manifest's, which says so too.
    grep -qF "xz_hash = \"$sha\"" "$SCRATCH/channel.toml"
    grep -qF "xz_url = \"$url\"" "$SCRATCH/channel.toml"
    fetch "$url" "$sha" "$SCRATCH/$name.tar.xz"
    tar -xJf "$SCRATCH/$name.tar.xz" -C "$rust"
    rm "$SCRATCH/$name.tar.xz"
  done

  debs="$SCRATCH/debs-$target"
  mkdir -p "$debs"
  for entry in "${DEBS[@]}"; do
    read -r arch url sha <<<"$entry"
    [[ "$arch" == "$target" ]] || continue
    file="$SCRATCH/$(basename "$url")"
    fetch "$url" "$sha" "$file"
    package="$(basename "$url")"
    package="${package%%_*}"
    mkdir -p "$debs/$package"
    (
      cd "$SCRATCH"
      member="$(ar t "$file" | grep '^data\.tar')"
      ar x "$file" "$member"
      tar -xf "$member" -C "$debs/$package"
      rm "$member" "$file"
    )
  done
done

# Lays the files out per target, each blob once in $out under its SHA-256,
# and writes build.json.
python3 -I - "$SCRATCH" "$out" "$RUST_VERSION" <<'PY'
import hashlib, json, os, re, shutil, sys

scratch, out, version = sys.argv[1:4]

# The commands, the same paths on both targets.
TRIPLE_TOOLS = ["as", "ld", "ar", "ranlib", "nm", "objcopy", "objdump", "strip", "readelf"]
COMMANDS = {name: f"/opt/rust/bin/{name}" for name in
            ["cargo", "rustc", "rustdoc", "rustfmt", "cargo-fmt", "cargo-clippy", "clippy-driver"]}
COMMANDS.update({"cc": "/usr/bin/gcc", "gcc": "/usr/bin/gcc", "cpp": "/usr/bin/cpp"})
COMMANDS.update({tool: f"/usr/bin/{tool}" for tool in TRIPLE_TOOLS})

# What of the Rust components is left out: documentation, the debugger
# scripts (no debugger here), rust-analyzer's proc-macro server (no
# rust-analyzer), the sanitizer runtimes (nightly-only flags) and the
# linker wrappers for other platforms' formats.
RUST_SKIP = re.compile(
    r"^(share/|etc/|libexec/|lib/rustlib/etc/|bin/rust-(gdb|gdbgui|lldb)$"
    r"|lib/rustlib/[^/]+/lib/librustc-stable_rt\."
    r"|lib/rustlib/[^/]+/bin/(wasm-component-ld|gcc-ld/(ld64\.lld|lld-link|wasm-ld))$)"
)

# Runtime libraries the loader finds in /lib/<triple>, where builtin:bun has
# the same files, so a job with both mounts them once.
TO_LIB = {"libc6", "libstdc++6", "libgcc-s1"}
# Runtime libraries of the C toolchain, in /usr/lib/<triple>.
TO_USR_LIB = {"libcrypt1", "libbinutils", "libctf0", "libctf-nobfd0", "libsframe1",
              "libjansson4", "libzstd1", "zlib1g", "libisl23", "libmpc3", "libmpfr6", "libgmp10"}
# Headers, crt objects, static libraries and link scripts.
DEV = {"libc6-dev", "libcrypt-dev"}

def layout(target):
    triple = f"{target}-linux-gnu"
    rust_root = os.path.join(scratch, f"rust-{target}")
    debs = os.path.join(scratch, f"debs-{target}")
    files = {}  # guest path -> real file on disk

    # Rust: each component's files, as its installer would place them.
    for archive in sorted(os.listdir(rust_root)):
        base = os.path.join(rust_root, archive)
        for component in open(os.path.join(base, "components")).read().split():
            comp = os.path.join(base, component)
            for line in open(os.path.join(comp, "manifest.in")):
                kind, _, rel = line.strip().partition(":")
                rels = [rel] if kind == "file" else [
                    os.path.relpath(os.path.join(d, f), comp)
                    for d, _, fs in os.walk(os.path.join(comp, rel)) for f in fs]
                for rel in rels:
                    if RUST_SKIP.match(rel):
                        continue
                    real = os.path.realpath(os.path.join(comp, rel))
                    if not real.startswith(comp + os.sep):
                        sys.exit(f"{component}: {rel} points outside the component")
                    files["/opt/rust/" + rel] = real

    # Ubuntu: what each package contributes, with symlinks resolved across
    # all of them (the sandbox mounts files, not links).
    packages = sorted(os.listdir(debs))
    def lookup(rel, depth=0):
        if depth > 40:
            return None
        for alias in (rel, "usr/" + rel):
            for package in packages:
                path = os.path.join(debs, package, alias)
                if os.path.islink(path):
                    target_ = os.readlink(path)
                    if target_.startswith("/"):
                        nxt = target_.lstrip("/")
                    else:
                        nxt = os.path.normpath(os.path.join(os.path.dirname(alias), target_))
                    return lookup(nxt, depth + 1)
                if os.path.isfile(path):
                    return path
        return None

    def take(guest, rel):
        real = lookup(rel)
        if real is not None:
            files[guest] = real
        return real is not None

    def walk(package, rel_dir, guest_dir, top_only=False, keep=lambda name: True):
        root = os.path.join(debs, package, rel_dir)
        if not os.path.isdir(root):
            return
        for d, dirs, fs in os.walk(root):
            if top_only:
                dirs[:] = []
            for f in fs:
                if not keep(f):
                    continue
                rel = os.path.relpath(os.path.join(d, f), os.path.join(debs, package))
                take(guest_dir + os.path.relpath(os.path.join(d, f), root), rel)

    for package in packages:
        if package in TO_LIB:
            walk(package, f"usr/lib/{triple}", f"/lib/{triple}/", top_only=True,
                 keep=lambda f: ".so" in f)
        elif package in TO_USR_LIB:
            walk(package, f"usr/lib/{triple}", f"/usr/lib/{triple}/", top_only=True,
                 keep=lambda f: ".so" in f)
        elif package in DEV or package == "linux-libc-dev":
            walk(package, "usr/include", "/usr/include/")
            walk(package, f"usr/lib/{triple}", f"/usr/lib/{triple}/", top_only=True)
        elif package == "libgcc-13-dev":
            walk(package, f"usr/lib/gcc/{triple}/13", f"/usr/lib/gcc/{triple}/13/")

    loader = {"x86_64": ("ld-linux-x86-64.so.2", "/lib64/ld-linux-x86-64.so.2"),
              "aarch64": ("ld-linux-aarch64.so.1", "/lib/ld-linux-aarch64.so.1")}[target]
    take(loader[1], f"usr/lib/{triple}/{loader[0]}")
    gcc = f"usr/libexec/gcc/{triple}/13"
    for prog in ["cc1", "collect2", "lto-wrapper", "liblto_plugin.so"]:
        take(f"/{gcc}/{prog}", f"{gcc}/{prog}")
    take(f"/usr/lib/gcc/{triple}/13/liblto_plugin.so", f"{gcc}/liblto_plugin.so")
    for name in ["gcc", f"{triple}-gcc-13"]:
        take(f"/usr/bin/{name}", f"usr/bin/{triple}-gcc-13")
    for name in ["cpp", f"{triple}-cpp-13"]:
        take(f"/usr/bin/{name}", f"usr/bin/{triple}-cpp-13")
    # binutils where Ubuntu has them: gcc runs `as` and `ld` from
    # /usr/<triple>/bin, and a build script runs `ar` from PATH.
    for tool in TRIPLE_TOOLS:
        source = f"usr/bin/{triple}-{'ld.bfd' if tool == 'ld' else tool}"
        for guest in (f"/usr/bin/{tool}", f"/usr/bin/{triple}-{tool}", f"/usr/{triple}/bin/{tool}"):
            if not take(guest, source):
                sys.exit(f"{target}: no {source}")
    take(f"/usr/bin/ld.bfd", f"usr/bin/{triple}-ld.bfd")
    take(f"/usr/{triple}/bin/ld.bfd", f"usr/bin/{triple}-ld.bfd")

    for name, path in COMMANDS.items():
        if path not in files:
            sys.exit(f"{target}: the command {name} has no {path}")
    return files

targets = {}
blobs = {}
for target in ["x86_64", "aarch64"]:
    entries = []
    total = 0
    for guest, real in sorted(layout(target).items()):
        h = hashlib.sha256()
        with open(real, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        digest = h.hexdigest()
        if digest not in blobs:
            blobs[digest] = real
            shutil.copyfile(real, os.path.join(out, digest))
        entries.append({"path": guest, "file": digest})
        total += os.path.getsize(real)
    print(f"{target}: {len(entries)} files, {total >> 20} MiB", file=sys.stderr)
    targets[f"{target}-linux"] = {"files": entries}

build = {
    "kind": "builtin",
    "name": "rust",
    "version": version,
    "abi": "native-gvisor",
    "targets": targets,
    "commands": COMMANDS,
    # A CI build starts from nothing and its target directory lives in the
    # job's memory, so incremental compilation's extra files only cost.
    "env": {"CARGO_INCREMENTAL": "0"},
    "description": f"Rust {version} (rustc, cargo, rust-std, rustfmt, clippy) with GCC 13 and binutils to link and compile C, the official releases, run natively in a gVisor sandbox beside the job's environment",
}
with open(os.path.join(out, "build.json"), "w") as f:
    json.dump(build, f, indent=2)
    f.write("\n")
PY
echo "built $out"
