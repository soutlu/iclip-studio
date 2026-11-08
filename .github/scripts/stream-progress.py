#!/usr/bin/env python3
"""通过 PTY 实时记录上传进度；用法：stream-progress.py COMMAND [ARG ...]。"""

import errno
import os
import pty
import re
import signal
import subprocess
import sys
import termios
import time
from contextlib import suppress

ANSI = re.compile(rb"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")
PROGRESS = re.compile(r"\bCopying (blob|config) (?:sha256:)?([0-9a-f]{10,64})\b")
FINISHED = re.compile(r"\b(done|skipped)\b", re.IGNORECASE)
ERROR = re.compile(r"\b(?:error|fatal|failed)\b", re.IGNORECASE)
SPEED = re.compile(r"\s*\|\s*[0-9.]+\s*[KMGTPE]?i?B/s$", re.IGNORECASE)
URL_QUERY = re.compile(r"(https?://[^\s?\"'<>]+)\?[^\s\"'<>]*")


def emit(raw, logged, force=False):
    line = ANSI.sub(b"", raw).decode("utf-8", "replace").strip()
    if not line:
        return
    match = PROGRESS.search(line)
    if match and not ERROR.search(line):
        # Skopeo 此速率来自输入流读取，不代表远端上传吞吐。
        line = SPEED.sub("", line)
        key, terminal = match.groups(), FINISHED.search(line)
        state = terminal[1].lower() if terminal else "progress"
        previous, last, finished = logged.get(key, (None, float("-inf"), set()))
        now = last if terminal else time.monotonic()
        if terminal and state in finished:
            return
        if not terminal and not force and state == previous and now - last < 10:
            return
        if terminal:
            finished.add(state)
        logged[key] = (state, now, finished)
    print(URL_QUERY.sub(r"\1?<redacted>", line), flush=True)


def main(argv):
    if not argv:
        print("Usage: stream-progress.py COMMAND [ARG ...]", file=sys.stderr)
        return 2
    started = time.monotonic()
    master, slave = pty.openpty()
    try:
        # 新 PTY 默认大小为 0×0，skopeo 用的进度条库 mpb 会因此丢弃所有进度行。
        termios.tcsetwinsize(slave, (24, 120))
        child = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=slave,
                                 stderr=slave, start_new_session=True)
    finally:
        os.close(slave)
    stopped = 0

    def kill_group(signum):
        with suppress(ProcessLookupError):
            os.killpg(child.pid, signum)

    def stop(signum, _frame):
        nonlocal stopped
        stopped = stopped or signum
        kill_group(signum)
        signal.alarm(3)

    signal.signal(signal.SIGALRM, lambda *_: kill_group(signal.SIGKILL))
    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, stop)
    pending, logged = b"", {}
    try:
        while True:
            try:
                chunk = os.read(master, 65536)
            except OSError as exc:
                if exc.errno != errno.EIO:
                    raise
                break
            if not chunk:
                break
            lines = re.split(rb"[\r\n]", pending + chunk)
            pending = lines.pop()
            for line in lines:
                emit(line, logged)
        emit(pending, logged, force=True)
        child.wait()
    finally:
        kill_group(signal.SIGKILL)
        code = child.wait()
        signal.alarm(0)
        os.close(master)
        code = 128 + stopped if stopped else code if code >= 0 else 128 - code
        print(f"Command result: exit_code={code} elapsed_seconds={time.monotonic() - started:.1f}",
              flush=True)
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
