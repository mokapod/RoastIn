#!/bin/bash

HQP_CONTROL="/Applications/hqp6-control.app/Contents/MacOS/hqp6-control"
HOST="localhost"
SETTINGS_FILE="$HOME/.hqplayer/settings.xml"

# 0. Record the current playback state so we can restore it at the end
#    hqp6-control --state returns something like "state: 2" (2=playing, 1=paused, 0=stopped)
INITIAL_STATE=$("$HQP_CONTROL" "$HOST" --state 2>&1 | awk '{print $2}' | cut -d':' -f1)

# 1. Check current state of DirectSDM
CURRENT_SDM=$(grep -o 'direct_sdm="[01]"' "$SETTINGS_FILE" | grep -o '[01]')

if [[ "$CURRENT_SDM" == "0" ]]; then
    NEW_SDM="1"
    STATE_MSG="ON"
else
    NEW_SDM="0"
    STATE_MSG="OFF"
fi

# Capture the current <defaults mode="..."> value. Only needed if we're
# about to change it — which happens when turning DirectSDM ON — but
# capturing unconditionally keeps the rollback path uniform.
ORIG_MODE=$(sed -n '/<defaults/ s/.*mode="\([^"]*\)".*/\1/p' "$SETTINGS_FILE" | head -1)

# 2. Update the XML file in place (macOS sed syntax)
# Step A: Toggle the direct_sdm flag
sed -i '' "s/direct_sdm=\"[01]\"/direct_sdm=\"$NEW_SDM\"/" "$SETTINGS_FILE"

# Step B: If turning ON, force the output mode to 1 (DSD)
# This safely matches -1 (Source), 0 (PCM), or 1 (DSD) and forces it to 1.
if [[ "$NEW_SDM" == "1" ]]; then
    sed -i '' '/<defaults/ s/mode="[^"]*"/mode="1"/' "$SETTINGS_FILE"
fi

# Rollback helper — restores the file to its pre-edit state. Called on
# any failure between the sed edits and a confirmed import, so the file
# on disk never disagrees with HQPlayer's live settings. Otherwise the
# server's get_volume_availability would report the new direct_sdm value
# on the next status poll while HQPlayer is still running under the old
# one, and the UI would show the toggle as having taken effect when it
# hasn't.
rollback_settings() {
    sed -i '' "s/direct_sdm=\"[01]\"/direct_sdm=\"$CURRENT_SDM\"/" "$SETTINGS_FILE"
    if [[ "$NEW_SDM" == "1" && -n "$ORIG_MODE" ]]; then
        sed -i '' "/<defaults/ s/mode=\"[^\"]*\"/mode=\"$ORIG_MODE\"/" "$SETTINGS_FILE"
    fi
}

# Resume playback if it was playing before the toggle. Used on both the
# success path and the failure paths, so a failure leaves the user where
# they started rather than silently paused.
resume_if_playing() {
    if [[ "$INITIAL_STATE" == "2" ]]; then
        "$HQP_CONTROL" "$HOST" --play
    fi
}

# 3. Stop playback AND wait until playback has stopped
"$HQP_CONTROL" "$HOST" --stop

# Poll HQPlayer status until state="0" (Stopped)
RETRIES=20
STATE=""

while (( RETRIES-- > 0 )); do
    STATE=$("$HQP_CONTROL" "$HOST" --state 2>&1 | awk '{print $2}' | cut -d':' -f1)
    if [[ "$STATE" == "0" ]]; then
        break # Successfully stopped, exit the loop
    fi
    sleep 0.2
done

# Fail loudly if HQPlayer never confirmed stopped. The loop's purpose is
# to guarantee the import doesn't run mid-playback; a silent expiry
# defeats that. Roll back the sed edits so the file matches HQPlayer's
# actual state (still playing under the old settings) before bailing.
if [[ "$STATE" != "0" ]]; then
    rollback_settings
    resume_if_playing
    echo "DirectSDM toggle failed: HQPlayer did not stop within 4s" >&2
    exit 1
fi

# 4. Reload HQPlayer settings. Wrapped in `with timeout` so a hung Apple
#    event — an inaccessible UI, a permission dialog, a stalled System
#    Events query — doesn't block until the server's 60-second script
#    timeout fires. On timeout, osascript exits non-zero and we roll back.
osascript << EOF
with timeout of 30 seconds
    tell application "HQPlayer6Desktop" to activate

    tell application "System Events"
        tell process "HQPlayer6Desktop"
            -- Wait for menu
            repeat while not (exists menu item "Import settings..." of menu "File" of menu bar 1)
                delay 0.2
            end repeat
            
            click menu item "Import settings..." of menu "File" of menu bar 1
            
            repeat while not (exists window "Import settings file")
                delay 0.2
            end repeat
            
            tell window "Import settings file"
                keystroke "g" using {shift down, command down}
                repeat while not (exists sheet 1)
                    delay 0.2
                end repeat
                
                -- Point directly to the live settings file
                set value of text field 1 of sheet 1 to "$SETTINGS_FILE"
                key code 36 -- Enter
                delay 0.3
                
                repeat while (exists sheet 1)
                    delay 0.2
                end repeat
                
                click button "Open"
            end tell
            
            -- Wait for menu
            repeat while not (exists menu item "Import settings..." of menu "File" of menu bar 1)
                delay 0.5
            end repeat
        end tell
    end tell
end timeout
EOF

AS_RC=$?

if [[ $AS_RC -ne 0 ]]; then
    rollback_settings
    resume_if_playing
    echo "DirectSDM toggle failed: settings import error (osascript exit $AS_RC)" >&2
    exit 1
fi

# 5. Restore the playback state captured at step 0
#    2 = was playing → resume
#    1 = was paused  → leave paused
#    0 = was stopped → leave stopped
resume_if_playing

# 6. Hide HQPlayer's window again
osascript -e 'tell application "System Events" to set visible of process "HQPlayer6Desktop" to false'

# 7. Report result to the server (replaces the old display notification)
echo "DirectSDM is $STATE_MSG"