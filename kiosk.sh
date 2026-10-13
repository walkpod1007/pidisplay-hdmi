#!/bin/sh
set -eu
xset s off
xset -dpms
xset s noblank
# Select the first physically connected HDMI output; do not force an unknown mode.
echo 'Waiting for an HDMI display'
while :; do
  output=$(xrandr --query | awk '/^HDMI[^ ]* connected/ {print $1; exit}')
  [ -n "$output" ] && break
  sleep 3
done
# Use the connected panel native mode; no low-resolution cap.
# X is never rotated (a rotated X recomposites every update); native-display.py reads PIDISPLAY_ROTATION
# (normal|left|right|inverted, left untouched in the environment) and rotates its own drawing.
xrandr --output "$output" --auto --primary --rotate normal
for other in $(xrandr --query | awk '/^(DSI|DPI)[^ ]* connected/ {print $1}'); do xrandr --output "$other" --off; done
until curl --fail --silent --max-time 3 http://127.0.0.1:8787/api/status >/dev/null; do sleep 2; done
openbox &
exec python3 /opt/pidisplay/native-display.py
