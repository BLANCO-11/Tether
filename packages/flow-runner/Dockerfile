# flow-runner — Foundry's executor for Pi-built workflows (plans/pi-runtime-2026-10-09).
#
# Built ON the fragment image so a step sees exactly the import set every fragment was written against
# (python 3.12 + pandas 2.2.3): one runtime, not a second one that drifts. On top: the two Excel libraries, so a step
# can BUILD a report file (xlsxwriter writes, openpyxl reads too, and pandas' to_excel uses either) and attach it by
# path instead of sending its rows (2026-10-12). The corporate CA, when there is one, is already trusted by the base.
#
# ⚠ No Docker socket, no Docker CLI, and a network that reaches only `server` (compose `runner-net`).
# Isolation between runs (P5b, P1-D1): each run's steps execute as their own uid in a 0700 directory under rlimits,
# /proc is hidepid — see runner/isolation.py and entrypoint.sh.
FROM foundry/fragment-base:py3.12-pandas2.2.3

RUN pip install --no-cache-dir "xlsxwriter==3.2.0" "openpyxl==3.1.5"

WORKDIR /app
COPY runner /app/runner
COPY sdk /app/sdk
COPY entrypoint.sh /app/entrypoint.sh

# The runner itself starts as ROOT, but a root with almost nothing: compose drops every capability except switching
# uid (SETUID/SETGID), handing a run its directory (CHOWN) and killing a run's processes (KILL) — plus SYS_ADMIN,
# which entrypoint.sh uses once to remount /proc and then removes from the bounding set. Root is needed only to
# switch each run to its own uid; no step ever runs as root. `runner` (10001) remains the uid used when isolation is
# switched off for the isolation check's control.
RUN useradd --system --uid 10001 --home-dir /app --shell /usr/sbin/nologin runner \
 && chmod -R a+rX /app \
 && python -c "import runner.server, runner.run_one, runner.isolation; import sys; sys.path.insert(0,'/app/sdk'); import foundry, xlsxwriter, openpyxl; print('flow-runner ok')"

ENV PYTHONUNBUFFERED=1
EXPOSE 4006
ENTRYPOINT ["/app/entrypoint.sh"]
