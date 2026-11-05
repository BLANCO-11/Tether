"""Runs ONE step function in its own process. Protocol: job on stdin, ONE JSON line on stdout.

The step's own `print()`s are redirected to stderr while it runs, so nothing a step writes can be read as
its result — the result is only what `run()` returns, wrapped here.
"""

from __future__ import annotations

import contextlib
import importlib.util
import json
import os
import sys
import traceback

sys.path.insert(0, "/app/sdk")


def main() -> None:
    job = json.load(sys.stdin)
    real_stdout = sys.stdout
    try:
        import foundry  # noqa: PLC0415 — configured per step, after the job is read

        foundry._configure(job["ctx"])
        spec = importlib.util.spec_from_file_location("step", job["entry"])
        if spec is None or spec.loader is None:
            raise RuntimeError(f"cannot load {job['entry']}")
        mod = importlib.util.module_from_spec(spec)
        with contextlib.redirect_stdout(sys.stderr):
            spec.loader.exec_module(mod)
            if not callable(getattr(mod, "run", None)):
                raise RuntimeError("the step file must define run(params, inputs)")
            result = mod.run(job.get("params") or {}, job.get("inputs") or {})
        real_stdout.write(json.dumps({"ok": True, "result": result, "reads": foundry._reads}, default=str) + "\n")
    except Exception as e:  # noqa: BLE001 — every failure is reported, never swallowed
        real_stdout.write(json.dumps({"ok": False, "error": failure_message(e, job.get("entry")), "trace": traceback.format_exc(limit=8)[-4000:]}) + "\n")
        sys.exit(1)


def failure_message(e: BaseException, entry: str | None) -> str:
    """What the person reads when a step fails (2026-10-13): one sentence, not a traceback.

    A refused or failed platform call (FoundryError) is the server's own sentence — it already says what happened and
    what to do. Anything else is the exception and the line of the step's own file it came from. The traceback goes to
    the step's logs (run_one.py), where the run page and Forge's fix turn can still read it.
    """
    if type(e).__name__ == "FoundryError":
        return str(e)
    where = ""
    if entry:
        frames = [f for f in traceback.extract_tb(e.__traceback__) if f.filename == entry]
        if frames:
            where = f" ({os.path.basename(entry)}, line {frames[-1].lineno})"
    text = str(e).strip()
    return f"{type(e).__name__}{where}: {text}" if text else f"{type(e).__name__}{where}"


if __name__ == "__main__":
    main()
