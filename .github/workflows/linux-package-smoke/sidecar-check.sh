#!/usr/bin/env bash
# Checks that an avogadro3d-sidecar is a real x86-64 ELF build, not the committed placeholder
# (apps/desktop/src-tauri/binaries/README.md), and that it completes the stdio protocol handshake
# with Avogadro's UFF linked in and the pinned avogadrolibs commit reported.
# Needs only bash and coreutils, so it runs on the build runner and inside every distro container.
# Usage: sidecar-check.sh <path to avogadro3d-sidecar>
set -euo pipefail
sidecar=${1:?usage: sidecar-check.sh <path to avogadro3d-sidecar>}
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
fail() { echo "::error::3D sidecar $sidecar: $*"; exit 1; }

[[ -f "$sidecar" ]] || fail 'missing'
[[ -x "$sidecar" ]] || fail 'not executable'
if grep -aqF 'avogadro3d-sidecar placeholder' "$sidecar"; then
  fail 'is the committed placeholder, not a native build'
fi
# ELF magic, 64-bit (02), little-endian (01); e_machine at byte 18 is 0x3e (x86-64).
header=$(od -An -tx1 -N20 -- "$sidecar" | tr -d ' \n')
[[ "${header:0:12}" == 7f454c460201 ]] || fail "is not a 64-bit little-endian ELF (header $header)"
[[ "${header:36:4}" == 3e00 ]] || fail "is not an x86-64 ELF (e_machine ${header:36:4})"

commit=$(grep -oE '[0-9a-f]{40}' "$root/native/avogadro3d-sidecar/CMakeLists.txt" | sort -u)
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || fail 'CMakeLists.txt must pin exactly one avogadrolibs commit'

# Ethanol's heavy atoms as a V2000 molfile; "\n" stays a JSON escape inside the request line.
molfile='ethanol\n  ChemDraft\n\n  3  2  0  0  0  0  0  0  0  0999 V2000\n'
molfile+='    0.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0\n'
molfile+='    1.5200    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0\n'
molfile+='    2.0300    1.3500    0.1000 O   0  0  0  0  0  0  0  0  0  0  0  0\n'
molfile+='  1  2  1  0  0  0  0\n  2  3  1  0  0  0  0\nM  END\n'
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
session=sidecar-check
printf '%s\n' \
  "{\"protocolVersion\":2,\"requestId\":\"check-create\",\"sessionId\":\"$session\",\"type\":\"createSession\",\"input\":{\"molfile\":\"$molfile\",\"format\":\"molfile-v2000\",\"atomIdByMolfileIndex\":[\"a1\",\"a2\",\"a3\"],\"graphSignature\":\"check\",\"bondSignature\":\"check\"}}" \
  "{\"protocolVersion\":2,\"requestId\":\"check-ping\",\"sessionId\":\"$session\",\"type\":\"ping\"}" \
  "{\"protocolVersion\":2,\"requestId\":\"check-commit\",\"sessionId\":\"$session\",\"type\":\"commit\"}" \
  "{\"protocolVersion\":2,\"requestId\":\"check-dispose\",\"sessionId\":\"$session\",\"type\":\"dispose\"}" \
  > "$work/requests"

status=0
timeout 60 "$sidecar" --stdio < "$work/requests" > "$work/stdout" 2> "$work/stderr" || status=$?
show() {
  echo '--- sidecar stdout'; cat "$work/stdout"
  echo '--- sidecar stderr'; cat "$work/stderr"
}
if [[ $status != 0 ]]; then
  show
  fail "exited with status $status"
fi

# stdout is protocol-only: one JSON object per line.
if grep -qvE '^\{"protocolVersion":2,' "$work/stdout"; then
  show
  fail 'wrote a non-protocol line to stdout'
fi
expect() {
  local what=$1; shift
  local line
  line=$(grep -F "\"requestId\":\"$1\"" "$work/stdout" || true)
  shift
  local needle
  for needle in "$@"; do
    if ! grep -qF -- "$needle" <<< "$line"; then
      show
      fail "handshake is missing $what ($needle)"
    fi
  done
}
expect 'the createSession response' check-create '"type":"response"' '"ok":true'
expect 'the ready event' check-create.event '"eventType":"ready"' '"headlessPhysics":true'
expect 'the ping response' check-ping '"ok":true'
expect 'the commit response' check-commit '"ok":true' \
  '"engine":{"name":"avogadro3d-sidecar"' "\"sourceCommit\":\"$commit\"" \
  '"forceField":{"name":"UFF"' '"avogadroBacked":true'
expect 'the dispose response' check-dispose '"ok":true'
echo "3D sidecar $sidecar: native x86-64 ELF; handshake complete (UFF, avogadrolibs $commit)."
