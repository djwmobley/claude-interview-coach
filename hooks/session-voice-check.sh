#!/usr/bin/env bash
# Hook: Stop — remind Claude to capture voice observations before session closes.
# Fires on every session stop. Outputs a reminder that Claude reads as context.
# The actual voice capture (voice.md update + Postgres storage) is done by Claude,
# not by this script. This script is just the trigger.

set -euo pipefail

cd "C:/claude-interview-coach/claude-interview-coach"

cat <<'EOF'
=== SESSION CLOSE: Voice Capture Check ===

Before this session ends, check whether Damian corrected, rewrote, or edited
any output you produced. If yes:

1. Update memory/voice.md with specific observations (what changed, in which
   direction, any new characteristic phrases or metaphors). Follow
   framework/voice-capture.md.

2. Store voice observations to Postgres via store_session_moments.py with
   role_type=strategy and tags including "voice". Example:

   echo '[{
     "question": "What voice pattern was observed?",
     "response": "Description of what Damian changed and why it matters",
     "coach_notes": "What the AI draft got wrong vs what he wrote",
     "quality_score": 5,
     "role_type": "strategy",
     "session_date": "YYYY-MM-DD",
     "tags": ["voice", "relevant-context-tags"]
   }]' | python tools/store_session_moments.py

3. Also store any new strategy decisions (role_type=strategy) from this session.

If Damian did not correct or rewrite anything, skip this. Do not store empty
observations.

=== End Voice Capture Check ===
EOF
