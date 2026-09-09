#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export GRADLE_USER_HOME="$ROOT/.cache/gradle"
cd "$ROOT"
python3 scripts/dependencies.py
gradle -p client-mod runClient --no-daemon
