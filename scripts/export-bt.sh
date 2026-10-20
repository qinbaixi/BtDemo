#!/usr/bin/env sh
# Re-export the behavior trees in bt/ to Go and refresh the registry.
#
# Uses the `owlbt` CLI from BtTree (https://github.com/qinbaixi/BtTree).
# Set OWLBT to override, e.g. OWLBT="node ../BtTree/packages/server/dist/cli.js".
set -e
cd "$(dirname "$0")/.."
${OWLBT:-owlbt} export bt --format go
go generate ./internal/ai/trees
