#!/usr/bin/env bash
# Renders store screenshots: ./render.sh  (desktop-*.html at 1200x800, mobile-*.html at 900x1600)
cd "$(dirname "$0")"
EDGE="/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
for f in desktop-*.html mobile-*.html; do
  [ -e "$f" ] || continue
  case "$f" in desktop-*) size=1200,800 ;; *) size=900,1600 ;; esac
  out="$(pwd -W)/${f%.html}.png"
  "$EDGE" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --window-size=$size --screenshot="$out" "file:///$(pwd -W)/$f" >/dev/null 2>&1
  echo "$f -> ${f%.html}.png"
done
