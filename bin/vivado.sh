#!/usr/bin/env sh
# POSIX launcher for the Vivado toolchain CLI.
# Usage: bin/vivado.sh <command> [options]
exec "${NODE:-node}" "$(dirname "$0")/vivado-cli.mjs" "$@"
