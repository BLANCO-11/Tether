#!/bin/sh
# flow-runner boot (pi-runtime P5b). Runs as root with only the capabilities compose grants, does the two things
# that need SYS_ADMIN, then drops it for good before the runner starts.
#
# 1. /proc hidepid=invisible: a process sees only its own uid's processes, so a step cannot even list another run's.
# 2. /runs: where each run gets its 0700 directory. Emptied at boot — nothing in it outlives the runs that made it.
set -eu
log() { printf '{"svc":"flow-runner","event":"%s","detail":"%s"}\n' "$1" "$2"; }

if ! mount -o remount,hidepid=invisible /proc 2>/dev/null; then
  # Fail closed: without it a step can read other runs' process details. On a host whose AppArmor profile denies
  # mount, give this container a profile that allows remounting /proc (or set FLOW_RUNNER_REQUIRE_HIDEPID=0, knowingly).
  if [ "${FLOW_RUNNER_REQUIRE_HIDEPID:-1}" = "1" ]; then
    log refusing_to_start "cannot remount /proc with hidepid (needs CAP_SYS_ADMIN and a mount-permitting AppArmor profile)"
    exit 3
  fi
  log warning "running WITHOUT hidepid — other runs' processes are visible"
fi

mkdir -p /runs
# A directory left by a crash belongs to a run uid root cannot enter, so it may stay. Harmless: execution ids are
# unique, and no process from before the restart survives it.
find /runs -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true
chown root:root /runs
chmod 0711 /runs

# Memory groups (2026-10-26): every run's steps go in their own cgroup with its own memory cap (isolation.py), so a
# step that runs away is killed ALONE and its run fails with a sentence. Without them the container's own limit is
# the only one, and Kubernetes on cgroup v2 kills a container's processes as a group — one runaway step would end
# every run in the pod.
#
#   /sys/fs/cgroup            the container's own group — its limit stays read-only, even to root
#     service/                the runner (and `exec` shells)
#     work/                   every run's steps; capped at the container limit minus headroom for the runner
#       run-<uid>/            one run (isolation.py)
#
# Only work/ is writable afterwards, through its own bind mount: with the whole tree writable, root here could raise
# the container's own memory.max. Same block in packages/forge/entrypoint.sh.
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
  log memory_groups "on: each run capped at ${FLOW_RUNNER_RUN_MEMORY_BYTES:-1073741824} bytes"
elif [ "${FLOW_RUNNER_REQUIRE_MEMORY_GROUPS:-1}" = "1" ]; then
  log refusing_to_start "cannot set up per-run memory groups (needs cgroup v2 in a private namespace, CAP_SYS_ADMIN and a mount-permitting AppArmor profile)"
  exit 3
else
  log warning "running WITHOUT memory groups: one step running out of memory can end every run"
fi

# SYS_ADMIN (and SETPCAP, needed only to do this) leave the bounding set: nothing after this line — the runner, a run, a step — can ever regain it.
# The container reads the whole repo .env (one settings file for the stack), so the runner starts with ONLY its own
# variables: no other secret in that file is ever in this process, let alone a step's.
exec env -i PATH="$PATH" HOME=/root LANG="${LANG:-C.UTF-8}" PYTHONUNBUFFERED=1 \
  FLOW_RUNNER_SECRET="${FLOW_RUNNER_SECRET:-}" \
  ${FLOW_RUNNER_RUN_MEMORY_BYTES:+FLOW_RUNNER_RUN_MEMORY_BYTES="$FLOW_RUNNER_RUN_MEMORY_BYTES"} \
  ${FLOW_RUNNER_PORT:+FLOW_RUNNER_PORT="$FLOW_RUNNER_PORT"} \
  ${FLOW_RUNNER_ISOLATION:+FLOW_RUNNER_ISOLATION="$FLOW_RUNNER_ISOLATION"} \
  ${FLOW_RUNNER_RUNS_ROOT:+FLOW_RUNNER_RUNS_ROOT="$FLOW_RUNNER_RUNS_ROOT"} \
  setpriv --bounding-set=-sys_admin,-setpcap --inh-caps=-all --no-new-privs python -m runner.server
