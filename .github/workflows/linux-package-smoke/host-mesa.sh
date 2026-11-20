#!/usr/bin/env bash
set -euo pipefail
image=$(realpath "$1")
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
cd "$work"
"$image" --appimage-extract > /dev/null
root="$work/squashfs-root"
# linuxdeploy AppRun prepends usr/lib and the multiarch directory.
export LD_LIBRARY_PATH="$root/usr/lib:$root/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
mapfile -t libraries < <(find /usr/lib /lib -type f \
  \( -name 'libEGL_mesa.so*' -o -name 'libgbm.so.*' -o -name 'libdrm.so.*' -o -name '*_dri.so' \) 2>/dev/null | sort -u)
for pattern in libEGL_mesa libgbm libdrm _dri.so; do
  printf '%s\n' "${libraries[@]}" | grep -q "$pattern" || { echo "::error::Missing host Mesa component $pattern"; exit 1; }
done
for library in "${libraries[@]}"; do
  echo "Checking $library"
  dependencies=$(ldd "$library") || { echo "::error::ldd failed for $library"; exit 1; }
  printf '%s\n' "$dependencies"
  if grep -Fq 'not found' <<< "$dependencies" || grep -Fq "$root/" <<< "$dependencies"; then
    echo "::error::Missing or AppImage-shadowed dependency of $library"
    exit 1
  fi
done
