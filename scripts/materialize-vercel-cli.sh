#!/usr/bin/env bash

set -euo pipefail

source_root="${1:?trusted Vercel CLI source root is required}"
destination="${2:?Vercel CLI destination is required}"
github_output="${3:-}"
cli_label=Vercel
cli_package=vercel
expected_version=63.0.2
expected_lock_sha256="1aa038fe6eb6b89385d0b51c86222269d32c7b50ee32a0c66353115152249827"
expected_integrity="sha512-R4Y+2pvU3Yo1c6qjxOvQoVQ6sN2LqJ1+aV5WuFApU4/4x/eX02qLBt5EEJDGEc+EpWfGyCxjYxapvOw74isYPw=="
# Use Sandbox directly: Vercel's sandbox wrapper overwrites failed remote exits.
additional_bin=sandbox_cli=sandbox
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/materialize-pinned-cli.sh"
