#!/usr/bin/env bash
# Tests files/iwci-size against made-up hosts: a meminfo, a CPU count and an
# env file in a temporary root (IWCI_SIZE_ROOT), with nothing applied to the
# machine running it. Run from anywhere: bash infra/ci-runners/tests/iwci-size.sh
set -euo pipefail

script="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/files/iwci-size"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
failures=0
checks=0

fail() {
  echo "FAIL: $*" >&2
  failures=$((failures + 1))
}

expect() { # description, want, got
  checks=$((checks + 1))
  if [[ "$2" != "$3" ]]; then
    fail "$1: want [$2], got [$3]"
  fi
}

# A fresh root for a host of $1 CPUs and $2 KiB of MemTotal; its path in $root.
host() {
  root="$work/$3"
  mkdir -p "$root/proc" "$root/etc/iwci" "$root/etc/sysctl.d"
  printf 'MemTotal:       %s kB\nMemFree:        1234 kB\n' "$2" >"$root/proc/meminfo"
  cpus=$1
}

run() {
  IWCI_SIZE_ROOT="$root" IWCI_SIZE_CPUS="$cpus" bash "$script" "$@"
}

line() { # the line of $1 that starts with $2
  grep "^$2" "$1" || true
}

# ls rather than stat, whose flags differ between GNU and BSD.
# shellcheck disable=SC2012 # one known file name
mode() {
  ls -l "$1" | cut -c1-10
}

# shellcheck disable=SC2012 # one known file name
inode() {
  ls -i "$1" | awk '{ print $1 }'
}

secret='s3cr3t-"value"-not-to-print'

# ci-2 today: an m8i.16xlarge, 64 vCPUs and 247.7 GiB of MemTotal, which ran
# with cpus = 64, memory = "200GiB" and zram = "40GiB". The env file is a
# Terraform one from another instance type (no newline at the end), and
# machines are on.
host 64 259731046 ci-2
printf '%s\n' \
  "IWCI_SERVER_KEY=\"$secret\"" \
  'IWCI_R2_BUCKET="bucket"' \
  'IWCI_CPUS="16"' \
  'IWCI_MEMORY="48GiB"' \
  'IWCI_MEMORY_ADMISSION="estimate"' >"$root/etc/iwci/iwci.env"
printf 'IWCI_RELEASE_PUBLIC_KEY="key"' >>"$root/etc/iwci/iwci.env"
chmod 0640 "$root/etc/iwci/iwci.env"
echo 'vm.nr_overcommit_hugepages = 1' >"$root/etc/sysctl.d/60-iwci-machines.conf"
out="$(run boot)"
env_file="$root/etc/iwci/iwci.env"
expect "ci-2 IWCI_CPUS" 'IWCI_CPUS="64"' "$(line "$env_file" IWCI_CPUS=)"
expect "ci-2 IWCI_MEMORY" 'IWCI_MEMORY="200GiB"' "$(line "$env_file" IWCI_MEMORY=)"
expect "ci-2 other lines kept, in order" \
  "IWCI_SERVER_KEY=\"$secret\"|IWCI_R2_BUCKET=\"bucket\"|IWCI_CPUS=\"64\"|IWCI_MEMORY=\"200GiB\"|IWCI_MEMORY_ADMISSION=\"estimate\"|IWCI_RELEASE_PUBLIC_KEY=\"key\"" \
  "$(paste -sd '|' "$env_file")"
expect "ci-2 env file mode kept" "-rw-r-----" "$(mode "$env_file")"
expect "ci-2 zram" "IWCI_ZRAM_SIZE=40GiB" "$(line "$root/etc/iwci/zram.env" IWCI_ZRAM_SIZE=)"
# The smaller of 200 GiB and three quarters of 247.7 GiB (185.8 GiB).
expect "ci-2 huge pages" "vm.nr_overcommit_hugepages = 95116" \
  "$(line "$root/etc/sysctl.d/60-iwci-machines.conf" vm.nr_overcommit_hugepages)"
checks=$((checks + 1))
if [[ "$out" == *s3cr3t* || "$out" == *bucket* ]]; then
  fail "boot printed the env file"
fi
expect "no temporary files left" "" "$(find "$root" -name '.*.??????' -print)"

# Again on the same host: nothing to change, so the file is not replaced.
before="$(inode "$env_file")"
run boot >/dev/null
expect "second boot leaves the env file alone" "$before" "$(inode "$env_file")"

# The image booting on a larger type, then a smaller one: the values follow.
printf 'MemTotal:       %s kB\n' 389598412 >"$root/proc/meminfo"
cpus=96
run boot >/dev/null
expect "96/371.5 GiB IWCI_CPUS" 'IWCI_CPUS="96"' "$(line "$env_file" IWCI_CPUS=)"
expect "96/371.5 GiB IWCI_MEMORY" 'IWCI_MEMORY="300GiB"' "$(line "$env_file" IWCI_MEMORY=)"
expect "96/371.5 GiB zram" "IWCI_ZRAM_SIZE=60GiB" "$(line "$root/etc/iwci/zram.env" IWCI_ZRAM_SIZE=)"
expect "96/371.5 GiB huge pages" "vm.nr_overcommit_hugepages = 142675" \
  "$(line "$root/etc/sysctl.d/60-iwci-machines.conf" vm.nr_overcommit_hugepages)"
expect "96/371.5 GiB secret kept" "IWCI_SERVER_KEY=\"$secret\"" "$(line "$env_file" IWCI_SERVER_KEY=)"

# A Terraform env file of a host with `size = "auto"` has neither line:
# both are added at the end. Without machines there is no huge page cap to
# set, and none is made.
host 8 32505856 small
printf '%s\n' 'IWCI_SERVER_KEY="k"' >"$root/etc/iwci/iwci.env"
chmod 0600 "$root/etc/iwci/iwci.env"
run boot >/dev/null
expect "missing lines added" 'IWCI_SERVER_KEY="k"|IWCI_CPUS="8"|IWCI_MEMORY="25GiB"' \
  "$(paste -sd '|' "$root/etc/iwci/iwci.env")"
expect "missing lines: mode kept" "-rw-------" "$(mode "$root/etc/iwci/iwci.env")"
expect "zram env readable" "-rw-r--r--" "$(mode "$root/etc/iwci/zram.env")"
checks=$((checks + 1))
if [[ -e "$root/etc/sysctl.d/60-iwci-machines.conf" ]]; then
  fail "boot set huge pages on a host without machines"
fi

# `huge-pages` on a host with fixed sizes (ci-1: 31 GiB): the cap is the
# smaller of its IWCI_MEMORY and three quarters of the host, and nothing
# else changes.
host 16 32505856 ci-1
printf '%s\n' 'IWCI_CPUS="16"' 'IWCI_MEMORY="16GiB"' >"$root/etc/iwci/iwci.env"
run huge-pages >/dev/null
expect "ci-1 16 GiB huge pages" "vm.nr_overcommit_hugepages = 8192" \
  "$(line "$root/etc/sysctl.d/60-iwci-machines.conf" vm.nr_overcommit_hugepages)"
printf '%s\n' 'IWCI_MEMORY=28672MiB' >"$root/etc/iwci/iwci.env"
run huge-pages >/dev/null
expect "ci-1 28 GiB, capped at three quarters" "vm.nr_overcommit_hugepages = 11904" \
  "$(line "$root/etc/sysctl.d/60-iwci-machines.conf" vm.nr_overcommit_hugepages)"
printf '%s\n' 'IWCI_SERVER_KEY="k"' >"$root/etc/iwci/iwci.env"
run huge-pages >/dev/null
expect "ci-1 no IWCI_MEMORY: three quarters" "vm.nr_overcommit_hugepages = 11904" \
  "$(line "$root/etc/sysctl.d/60-iwci-machines.conf" vm.nr_overcommit_hugepages)"
expect "huge-pages leaves the env file" 'IWCI_SERVER_KEY="k"' "$(cat "$root/etc/iwci/iwci.env")"
expect "huge-pages makes no zram env" "" "$(ls "$root/etc/iwci/zram.env" 2>/dev/null || true)"

# What `show` says for the instance types the fleet may take. MemTotal is
# below the nominal memory (firmware and the kernel's own), and taken here
# in ci-2's proportion, 247.7 of 256 GiB.
show() { # CPUs, nominal GiB, then the lines wanted
  local n=$1 gib=$2
  shift 2
  host "$n" $((gib * 1048576 * 2477 / 2560)) "show-$n-$gib"
  expect "show $n CPUs, $gib GiB" "$(printf '%s|' "$@")" "$(run show | tail -n +2 | tr '\n' '|')"
}
show 64 256 IWCI_CPUS=64 IWCI_MEMORY=200GiB IWCI_ZRAM_SIZE=40GiB vm.nr_overcommit_hugepages=95116
show 192 768 IWCI_CPUS=192 IWCI_MEMORY=601GiB IWCI_ZRAM_SIZE=120GiB vm.nr_overcommit_hugepages=285350
show 192 384 IWCI_CPUS=192 IWCI_MEMORY=300GiB IWCI_ZRAM_SIZE=60GiB vm.nr_overcommit_hugepages=142675
show 96 384 IWCI_CPUS=96 IWCI_MEMORY=300GiB IWCI_ZRAM_SIZE=60GiB vm.nr_overcommit_hugepages=142675
# The bounds: zram at least 1 GiB on a small host, at most 128 on a large one.
show 2 4 IWCI_CPUS=2 IWCI_MEMORY=3GiB IWCI_ZRAM_SIZE=1GiB vm.nr_overcommit_hugepages=1486
show 448 2048 IWCI_CPUS=448 IWCI_MEMORY=1605GiB IWCI_ZRAM_SIZE=128GiB vm.nr_overcommit_hugepages=760934

# Bad inputs stop it before it writes anything.
host 4 0 bad
printf '%s\n' 'IWCI_SERVER_KEY="k"' >"$root/etc/iwci/iwci.env"
checks=$((checks + 1))
if run boot >/dev/null 2>&1; then
  fail "boot ran with no MemTotal"
fi
expect "bad host's env file untouched" 'IWCI_SERVER_KEY="k"' "$(cat "$root/etc/iwci/iwci.env")"
host 4 8000000 no-env
checks=$((checks + 1))
if run boot >/dev/null 2>&1; then
  fail "boot ran with no env file"
fi

if ((failures > 0)); then
  echo "$failures of $checks checks failed" >&2
  exit 1
fi
echo "iwci-size: all $checks checks passed"
