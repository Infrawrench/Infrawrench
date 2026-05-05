#!/usr/bin/env bash
set -euo pipefail

sedi() {
  if sed --version 2>/dev/null | grep -q GNU; then
    sed -i "$@"
  else
    sed -i '' "$@"
  fi
}

restore() {
  sedi 's/"name": "Infrawrench"/"name": "@infrawrench\/desktop"/' package.json
}
trap restore EXIT

sedi 's/"name": "@infrawrench\/desktop"/"name": "Infrawrench"/' package.json
electron-builder "$@"
EXIT_CODE=$?
exit $EXIT_CODE
