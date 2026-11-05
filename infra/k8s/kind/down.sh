#!/usr/bin/env bash
# Delete the local kind cluster and everything in it. The compose stack is not touched.
set -euo pipefail
kind delete cluster --name foundry
