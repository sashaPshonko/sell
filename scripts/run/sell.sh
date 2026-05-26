#!/bin/bash
cd "$(dirname "$0")/../.."
while true; do
    node poll.mjs
    sleep 5
done
