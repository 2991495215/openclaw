#!/usr/bin/env bash

set -euo pipefail

source_root="${1:?trusted Vercel CLI source root is required}"
destination="${2:?Vercel CLI destination is required}"
github_output="${3:-}"
cli_label=Vercel
cli_package=vercel
expected_version=63.1.0
expected_lock_sha256="a879779ef830043874ffb5fcf4908a1b6c828731be52879e1c10a45719b13179"
expected_integrity="sha512-JQvJODfMeBGejhW1nfu0zfczU8I0NiARD3FilxuBjFeMtEzgK2LeBD6RC1yyhwR8mVQzod/p/SbjyDNFx11njQ=="
# Use Sandbox directly: Vercel's sandbox wrapper overwrites failed remote exits.
additional_bin=sandbox_cli=sandbox
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/materialize-pinned-cli.sh"
