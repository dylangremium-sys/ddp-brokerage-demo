#!/bin/bash
set -e

# Post-merge setup for ddp-brokerage-demo
# Runs automatically after any task branch is merged.
# Must be idempotent and non-interactive.

echo "--- post-merge: installing dependencies ---"
npm install --prefer-offline

echo "--- post-merge: done ---"
