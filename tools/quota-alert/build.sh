#!/usr/bin/env bash
# Builds both quota-alert programs into ../../bin. Run on Linux or in WSL:
#   apt-get install gcc gcc-mingw-w64-x86-64 libx11-dev libxft-dev pkg-config
#   bash tools/quota-alert/build.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$here/../../bin"
mkdir -p "$out"

x86_64-w64-mingw32-gcc -Os -s -municode -mwindows -Wall -Wextra \
    -o "$out/quota-alert.exe" "$here/quota_alert_win.c" -luser32 -lgdi32 -lshell32

# shellcheck disable=SC2046
gcc -Os -s -Wall -Wextra -o "$out/quota-alert" "$here/quota_alert_x11.c" $(pkg-config --cflags --libs x11 xft)

ls -l "$out/quota-alert.exe" "$out/quota-alert"
