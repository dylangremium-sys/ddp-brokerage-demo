#!/bin/bash
set -e

# Post-merge setup for ddp-brokerage-demo
# Runs automatically after any task branch is merged.
# Must be idempotent and non-interactive.

echo "--- post-merge: installing dependencies ---"

# `npm ci`, never `npm install`. AGENTS.md L88-90 is explicit about this, and
# the reason is not theoretical: `npm install` re-resolves and can silently
# rewrite package-lock.json. A hook that runs after EVERY merge would do that
# repeatedly, unattended, on a file nobody is watching -- and this very branch
# arrived with 32 packages re-pointed at an internal Replit proxy, which is what
# that failure mode looks like once it has happened. `npm ci` installs exactly
# what the committed lockfile pins and refuses if the two have drifted, so a
# desync becomes a loud failure here instead of a silent commit later.
npm ci

echo "--- post-merge: done ---"
