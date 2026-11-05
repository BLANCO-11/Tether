"""Run isolation — P1-D1's five points (pi-runtime P5b, 2026-10-10).

Every run's steps execute as their OWN throwaway uid, in a private 0700 directory, with per-step resource limits.
`/proc` is mounted `hidepid=invisible` by the entrypoint, so a step cannot even see another run's processes, and the
token reaches a step over stdin only (run_one.py). Without a uid of its own, a run could read another run's files
and — through /proc — its process details, and act with its execution token (another tenant's, possibly).

The pieces, all used by run_one.py:
  claim_uid / release_uid   a uid no other LIVE run holds, claimed by an atomic mkdir — no shared state to corrupt
  prepare_run_dir           /runs/<execution>, 0700, owned by the run's uid
  step_popen_kwargs         run a step as that uid, in its own process group, under rlimits
  sweep                     at the end: kill everything the run's uid still has running, remove its directory

⚠ FLOW_RUNNER_ISOLATION=off exists ONLY so the isolation check can prove its own test discriminates (the same
reads must SUCCEED with uid separation off). server.py hands run_one a fixed minimal environment that never carries
it, so nothing that comes through the runner's API can turn isolation off.
"""

from __future__ import annotations

import os
import random
import resource
import shutil
import signal
import time

RUNS_ROOT = os.environ.get("FLOW_RUNNER_RUNS_ROOT", "/runs")
UID_LOCKS = os.path.join(RUNS_ROOT, ".uids")
UID_FIRST, UID_LAST = 20000, 59999
SHARED_UID = 10001  # the image's `runner` user — every step ran as this before P5b, and does with isolation off

# Per-step limits. CPU follows the step's wall-clock timeout; the rest are fixed.
MEMORY_BYTES = 2 * 1024**3  # address space — pandas + a sizeable frame; a runaway allocation dies alone
MAX_PROCESSES = 64  # per uid, i.e. per run (each run has its own) — a fork bomb stops here
MAX_FILE_BYTES = 256 * 1024**2
MAX_OPEN_FILES = 512

# Memory groups (entrypoint.sh, 2026-10-26). RLIMIT_AS bounds ONE process; a run may have up to MAX_PROCESSES of them,
# and what they add up to was bounded only by the container's limit — which, under Kubernetes on cgroup v2, kills
# every process in the container at once. So each run's steps also share one group, work/run-<uid>, with its own cap:
# a run that passes it dies alone and fails with a sentence, and every other run carries on.
CGROUP_WORK = "/sys/fs/cgroup/work"
RUN_MEMORY_BYTES = int(os.environ.get("FLOW_RUNNER_RUN_MEMORY_BYTES", str(1024**3)))


def isolated() -> bool:
    return os.environ.get("FLOW_RUNNER_ISOLATION", "on") != "off"


def claim_uid() -> int:
    """A uid no other live run holds. The lock is a directory: mkdir is atomic, so two runs cannot both win."""
    if not isolated():
        return SHARED_UID
    os.makedirs(UID_LOCKS, mode=0o700, exist_ok=True)
    span = UID_LAST - UID_FIRST + 1
    start = random.randrange(span)
    for i in range(span):
        uid = UID_FIRST + (start + i) % span
        try:
            os.mkdir(os.path.join(UID_LOCKS, str(uid)), 0o700)
            return uid
        except FileExistsError:
            continue
    raise RuntimeError("no free run uid — every uid in the range is held by a live run")


def release_uid(uid: int) -> None:
    if uid == SHARED_UID:
        return
    try:
        os.rmdir(os.path.join(UID_LOCKS, str(uid)))
    except OSError:
        pass


def memory_groups_on() -> bool:
    return os.path.exists(os.path.join(CGROUP_WORK, "cgroup.procs"))


def remove_group(path: str) -> None:
    """Kill whatever is left in a run's group and remove it. rmdir succeeds once the last process is gone."""
    if not os.path.isdir(path):
        return
    try:
        with open(os.path.join(path, "cgroup.kill"), "w") as f:
            f.write("1")
    except OSError:
        pass  # empty, or a kernel without cgroup.kill — the sweep has already killed the run's uid
    for _ in range(40):
        try:
            os.rmdir(path)
            return
        except FileNotFoundError:
            return
        except OSError:
            time.sleep(0.05)


def make_group(uid: int) -> str | None:
    """A fresh, capped group for a run's steps. None when memory groups are off, or for the shared uid."""
    if not memory_groups_on() or uid == SHARED_UID or os.geteuid() != 0:
        return None
    path = os.path.join(CGROUP_WORK, f"run-{uid}")
    remove_group(path)  # left behind by a runner that died mid-run
    os.mkdir(path)
    for name, value, required in (("memory.max", str(RUN_MEMORY_BYTES), True),
                                  ("memory.swap.max", "0", False),
                                  ("memory.oom.group", "1", True)):
        try:
            with open(os.path.join(path, name), "w") as f:
                f.write(value)
        except OSError:
            if required:
                raise
    return path


def oom_kills(group: str | None) -> int:
    """How many times the kernel killed something in this group for running out of memory."""
    if not group:
        return 0
    try:
        with open(os.path.join(group, "memory.events")) as f:
            for line in f:
                if line.startswith("oom_kill "):
                    return int(line.split()[1])
    except OSError:
        pass
    return 0


def prepare_run_dir(execution_id: str, uid: int) -> str:
    """/runs/<execution>, created by root, then handed to the run's uid with mode 0700."""
    safe = "".join(c for c in execution_id if c.isalnum() or c in "-_")[:80] or "run"
    path = os.path.join(RUNS_ROOT, safe)
    if os.path.exists(path):
        raise RuntimeError(f"run directory already exists: {path}")
    os.mkdir(path, 0o700)
    os.mkdir(os.path.join(path, "tmp"), 0o700)
    return path


def hand_over(path: str, uid: int) -> None:
    """Give the run's files to its uid (after they are written). 0700 dirs, 0600 files.

    Bottom-up, and mode before owner: root here has no DAC_OVERRIDE / FOWNER, so once a directory or file belongs
    to the run's uid, root can neither enter it nor change its mode.
    """
    for root, _dirs, files in os.walk(path, topdown=False):
        for f in files:
            p = os.path.join(root, f)
            os.chmod(p, 0o600)
            os.chown(p, uid, uid)
        os.chmod(root, 0o700)
        os.chown(root, uid, uid)


def _limits(cpu_seconds: int, run_dir: str):
    def apply() -> None:
        # Runs AFTER the uid switch (CPython applies user/group first). The working directory is entered here, not via
        # Popen's cwd — that chdir happens while still root, and root here cannot enter the run uid's 0700 directory.
        os.chdir(run_dir)
        resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds + 5))
        resource.setrlimit(resource.RLIMIT_AS, (MEMORY_BYTES, MEMORY_BYTES))
        resource.setrlimit(resource.RLIMIT_NPROC, (MAX_PROCESSES, MAX_PROCESSES))
        resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_FILE_BYTES, MAX_FILE_BYTES))
        resource.setrlimit(resource.RLIMIT_NOFILE, (MAX_OPEN_FILES, MAX_OPEN_FILES))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))

    return apply


def _join_then(group: str, uid: int, then):
    def apply() -> None:
        # Still root here: join the run's group first (its files are root's — the uid could not), then become the uid.
        # Nothing the step starts can then exist outside the group.
        with open(os.path.join(group, "cgroup.procs"), "w") as f:
            f.write(str(os.getpid()))
        os.setgroups([])
        os.setgid(uid)
        os.setuid(uid)
        then()

    return apply


def step_popen_kwargs(uid: int, run_dir: str, cpu_seconds: int, group: str | None = None) -> dict:
    """Run a step as the run's uid, in a new process group (so a timeout kills everything it started), limited —
    and, with a memory group, inside it."""
    env = {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "LANG": "C.UTF-8",
        "PYTHONDONTWRITEBYTECODE": "1",
        "HOME": run_dir,
        "TMPDIR": os.path.join(run_dir, "tmp"),
        "LOGNAME": "run",
        "USER": "run",
        # numpy/OpenBLAS reserve address space per thread; one thread keeps a step inside its memory limit.
        "OPENBLAS_NUM_THREADS": "1",
        "OMP_NUM_THREADS": "1",
        "MKL_NUM_THREADS": "1",
    }
    kwargs: dict = {"env": env, "process_group": 0, "preexec_fn": _limits(cpu_seconds, run_dir)}
    if os.geteuid() == 0 and group:
        # Popen would switch uid BEFORE preexec_fn runs, and the uid cannot join a group, so the switch moves in here.
        kwargs["preexec_fn"] = _join_then(group, uid, _limits(cpu_seconds, run_dir))
    elif os.geteuid() == 0:  # only root can switch; a developer running this unprivileged keeps their own uid
        kwargs.update(user=uid, group=uid, extra_groups=[])
    return kwargs


def kill_group(pid: int) -> None:
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def _as_uid(uid: int, fn) -> None:
    """Run `fn` in a child that has become `uid` (so it reaches exactly that uid's processes and files)."""
    pid = os.fork()
    if pid == 0:
        code = 0
        try:
            os.setgroups([])
            os.setgid(uid)
            os.setuid(uid)
            fn()
        except BaseException:  # noqa: BLE001 — a child must never return into the parent's code
            code = 1
        os._exit(code)
    os.waitpid(pid, 0)


def _kill_all_of_uid() -> None:
    # kill(-1) from inside the uid reaches every process of that uid but this one. Repeated: a process may be
    # mid-fork the first time.
    for _ in range(3):
        try:
            os.kill(-1, signal.SIGKILL)
        except ProcessLookupError:
            break
        time.sleep(0.05)


def reap(uid: int) -> None:
    """Kill everything the run's uid still has running. Steps run one at a time, so between steps anything alive is
    something a finished step left behind — including a child that escaped its process group with setsid, which
    still holds the step's output pipes and would otherwise keep the runner waiting for as long as it lives."""
    if uid == SHARED_UID or os.geteuid() != 0:
        return  # a shared uid is every run's; killing it would kill the others
    _as_uid(uid, _kill_all_of_uid)


def sweep(uid: int, run_dir: str) -> None:
    """End of run: kill whatever the run's uid still has running, then remove its directory.

    Done as the run's uid: it reaches exactly that uid's processes, and can delete the run's 0700 files without root
    needing to override permissions (it has no DAC_OVERRIDE here).
    """
    if os.geteuid() != 0:
        shutil.rmtree(run_dir, ignore_errors=True)
        return

    def clean() -> None:
        if uid != SHARED_UID:  # a shared uid is every run's
            _kill_all_of_uid()
        for entry in os.listdir(run_dir):
            p = os.path.join(run_dir, entry)
            if os.path.isdir(p) and not os.path.islink(p):
                shutil.rmtree(p, ignore_errors=True)
            else:
                try:
                    os.unlink(p)
                except OSError:
                    pass

    _as_uid(uid, clean)
    try:
        os.rmdir(run_dir)  # empty now; /runs is root's
    except OSError:
        shutil.rmtree(run_dir, ignore_errors=True)
