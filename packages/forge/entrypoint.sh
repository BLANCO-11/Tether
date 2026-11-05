#!/bin/sh
# forge boot (2026-10-13), the flow-runner pattern: runs as root with only the capabilities compose grants, does the one
# thing that needs SYS_ADMIN, drops it for good, and starts the host with only its own variables.
#
# /proc hidepid=invisible: a conversation's Forge sees only its own uid's processes, never another chat's (nor their
# environment, which holds the AI key).
set -eu
log() { printf '{"svc":"forge","event":"%s","detail":"%s"}\n' "$1" "$2"; }

if [ "${1:-host}" = "egress" ]; then
  # The proxy needs nothing: no capabilities, no secrets, only the allowlist.
  exec env -i PATH="$PATH" HOME=/tmp LANG=C.UTF-8 \
    FORGE_EGRESS_ALLOW="${FORGE_EGRESS_ALLOW:-}" LLM_BASE_URL="${LLM_BASE_URL:-}" ${FORGE_EGRESS_PORT:+FORGE_EGRESS_PORT="$FORGE_EGRESS_PORT"} \
    ${NODE_EXTRA_CA_CERTS:+NODE_EXTRA_CA_CERTS="$NODE_EXTRA_CA_CERTS"} \
    setpriv --reuid=65534 --regid=65534 --clear-groups --inh-caps=-all --bounding-set=-all --no-new-privs \
    node /app/egress-proxy.mjs
fi

if ! mount -o remount,hidepid=invisible /proc 2>/dev/null; then
  if [ "${FORGE_REQUIRE_HIDEPID:-1}" = "1" ]; then
    log refusing_to_start "cannot remount /proc with hidepid (needs CAP_SYS_ADMIN and a mount-permitting AppArmor profile)"
    exit 3
  fi
  log warning "running WITHOUT hidepid: a conversation can see other conversations' processes"
fi

# Memory groups (2026-10-26): every conversation gets its own cgroup with its own memory cap (host.mjs), so one that
# runs away is killed ALONE. Without them the container's own limit is the only one, and Kubernetes on cgroup v2 kills
# a container's processes as a group — one runaway chat ended every chat in the pod (infra/k8s/kind/check.sh §9).
#
#   /sys/fs/cgroup            the container's own group — its limit stays read-only, even to root
#     service/                this host (and `exec` shells)
#     work/                   every conversation; its cap is the container limit minus headroom for the host
#       conv-<uid>/           one conversation (host.mjs)
#
# Only work/ is writable afterwards, through its own bind mount: with the whole tree writable, root here could raise
# the container's own memory.max — measured, it could. Same block in packages/flow-runner/entrypoint.sh.
memory_groups() {
  c=/sys/fs/cgroup
  # A private cgroup namespace only: with the host's tree visible, the moves below would move the host's processes.
  [ "$(cat /proc/self/cgroup)" = "0::/" ] || return 1
  grep -qw memory "$c/cgroup.controllers" 2>/dev/null || return 1
  mount -o remount,bind,rw "$c" || return 1
  mkdir -p "$c/service" "$c/work" || return 1
  for p in $(cat "$c/cgroup.procs"); do echo "$p" > "$c/service/cgroup.procs" 2>/dev/null || true; done
  echo +memory > "$c/cgroup.subtree_control" || return 1
  echo +memory > "$c/work/cgroup.subtree_control" || return 1
  limit=$(cat "$c/memory.max")
  if [ "$limit" != max ]; then
    reserve=$((limit / 5)); [ "$reserve" -lt 134217728 ] && reserve=134217728
    echo $((limit - reserve)) > "$c/work/memory.max" || return 1
  fi
  mount --bind "$c/work" "$c/work" || return 1
  mount -o remount,bind,ro "$c" || return 1
}
if memory_groups; then
  log memory_groups "on: each conversation capped at ${FORGE_CONVERSATION_MEMORY_BYTES:-1073741824} bytes"
elif [ "${FORGE_REQUIRE_MEMORY_GROUPS:-1}" = "1" ]; then
  log refusing_to_start "cannot set up per-conversation memory groups (needs cgroup v2 in a private namespace, CAP_SYS_ADMIN and a mount-permitting AppArmor profile)"
  exit 3
else
  log warning "running WITHOUT memory groups: one conversation running out of memory can end every conversation"
fi

# SYS_ADMIN and SETPCAP leave the bounding set before the host starts; nothing after this can regain them.
exec env -i PATH="$PATH" HOME=/root LANG="${LANG:-C.UTF-8}" \
  FORGE_HOST_SECRET="${FORGE_HOST_SECRET:-}" \
  ${FORGE_CONVERSATION_MEMORY_BYTES:+FORGE_CONVERSATION_MEMORY_BYTES="$FORGE_CONVERSATION_MEMORY_BYTES"} \
  ${FORGE_HOST_PORT:+FORGE_HOST_PORT="$FORGE_HOST_PORT"} \
  ${FORGE_MAX_FOLDER_BYTES:+FORGE_MAX_FOLDER_BYTES="$FORGE_MAX_FOLDER_BYTES"} \
  ${FORGE_EGRESS_PROXY:+FORGE_EGRESS_PROXY="$FORGE_EGRESS_PROXY"} \
  ${NODE_EXTRA_CA_CERTS:+NODE_EXTRA_CA_CERTS="$NODE_EXTRA_CA_CERTS"} \
  setpriv --bounding-set=-sys_admin,-setpcap --inh-caps=-all --no-new-privs node /app/host.mjs
