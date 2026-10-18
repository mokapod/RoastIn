#!/bin/bash
#
# restart-hqplayer.sh — quit and relaunch HQPlayer cleanly.

APP_NAME="HQPlayer6Desktop"

# Quit gracefully if running
if pgrep -x "$APP_NAME" > /dev/null; then
    osascript -e "tell application \"$APP_NAME\" to quit"
    # Wait up to 5 seconds for it to exit
    for i in 1 2 3 4 5; do
        if ! pgrep -x "$APP_NAME" > /dev/null; then
            break
        fi
        sleep 1
    done
fi

# If still running, force kill
if pgrep -x "$APP_NAME" > /dev/null; then
    pkill -x "$APP_NAME"
    sleep 1
fi

# Relaunch
open -a "$APP_NAME"