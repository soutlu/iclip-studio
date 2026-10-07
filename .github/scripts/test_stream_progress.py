"""验证真实 PTY 的 CR 进度、退出状态和终止清理，无需镜像或网络。"""

import contextlib
import importlib.util
import io
import os
from pathlib import Path
import re
import select
import signal
import subprocess
import sys
import unittest
from unittest import mock

SCRIPT = Path(__file__).with_name("stream-progress.py")
SPEC = importlib.util.spec_from_file_location("stream_progress", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class StreamProgressTest(unittest.TestCase):
    def launch(self, source):
        process = subprocess.Popen(
            [sys.executable, str(SCRIPT), sys.executable, "-c", source],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        )
        self.addCleanup(self.cleanup, process)
        return process

    @staticmethod
    def cleanup(process):
        if process.poll() is None:
            process.terminate()
        process.communicate(timeout=6)

    def first_output(self, process):
        ready, _, _ = select.select([process.stdout], [], [], 1.5)
        self.assertTrue(ready, "CR 更新必须在子进程退出前可见，不能等 LF/EOF")
        return os.read(process.stdout.fileno(), 65536).decode()

    def elapsed(self, output, code):
        result = re.search(
            rf"^Command result: exit_code={code} elapsed_seconds=([0-9.]+)$",
            output, re.MULTILINE,
        )
        self.assertIsNotNone(result, "必须记录子命令退出状态和实际经过时间")
        return float(result[1])

    def test_child_has_nonzero_terminal_dimensions(self):
        process = self.launch(
            "import os; size = os.get_terminal_size(1); print(size.columns, size.lines)"
        )
        output, _ = process.communicate(timeout=5)
        self.assertEqual(process.returncode, 0)
        columns, rows = map(int, output.decode().splitlines()[0].split())
        self.assertGreater(columns, 0)
        self.assertGreater(rows, 0)
        self.elapsed(output.decode(), 0)

    def test_cr_progress_is_live_and_exit_and_eof_are_preserved(self):
        process = self.launch(
            "import os, sys, time; "
            "os.write(1, b'\\x1b[2KCopying blob abcdef012345 [=>--] 1 MiB / 2 MiB | 1.1 GiB/s\\r'); "
            "time.sleep(2); os.write(1, b'final output without newline'); sys.exit(7)"
        )
        first = self.first_output(process)
        self.assertIn("Copying blob abcdef012345", first)
        self.assertIn("1 MiB / 2 MiB", first)
        self.assertNotIn("GiB/s", first)
        self.assertNotIn("\x1b", first)
        self.assertIsNone(process.poll())
        remaining, _ = process.communicate(timeout=5)
        self.assertIn("final output without newline", remaining.decode())
        self.assertEqual(process.returncode, 7)
        self.assertGreaterEqual(self.elapsed(remaining.decode(), 7), 2)

    def test_throttle_is_per_layer_and_completion_and_errors_are_immediate(self):
        output, logged = io.StringIO(), {}
        with contextlib.redirect_stdout(output), mock.patch.object(
            MODULE.time, "monotonic", side_effect=[0, 1, 1, 10, 10.1]
        ):
            MODULE.emit(b"Copying blob abcdef012345 1 MiB", logged)
            MODULE.emit(b"Copying blob abcdef012345 2 MiB", logged)
            MODULE.emit(b"Copying blob 123456abcdef 1 MiB", logged)
            MODULE.emit(b"Copying blob abcdef012345 3 MiB", logged)
            MODULE.emit(b"Copying blob abcdef012345 done", logged)
            MODULE.emit(b"Copying blob abcdef012345 4 MiB", logged)
            MODULE.emit(b"Copying blob abcdef012345 skipped", logged)
            MODULE.emit(
                b'time="2026-09-29T12:00:00Z" level=fatal msg="Copying blob abcdef012345: Patch '
                b'"https://registry.test/upload?_state=secret&sig=private": connection reset by peer"',
                logged,
            )
        lines = output.getvalue().splitlines()
        self.assertEqual(len(lines), 7)
        self.assertFalse(any("2 MiB" in line for line in lines))
        self.assertTrue(any("123456abcdef" in line for line in lines))
        self.assertTrue(any("3 MiB" in line for line in lines))
        self.assertTrue(any("4 MiB" in line for line in lines))
        self.assertTrue(any("done" in line for line in lines))
        self.assertTrue(any("skipped" in line for line in lines))
        self.assertIn('https://registry.test/upload?<redacted>"', lines[-1])
        self.assertIn("connection reset by peer", lines[-1])
        self.assertNotIn("secret", output.getvalue())
        self.assertNotIn("private", output.getvalue())

    def test_cr_redraw_deduplicates_terminal_states_and_throttles_config(self):
        skipped = "Copying blob abcdef012345 skipped: already exists"
        done = "Copying blob abcdef012345 done"
        config = "Copying config eb225a2b04 1 KiB / 2 KiB"
        config_done = "Copying config eb225a2b04 done"
        error = "error Copying config eb225a2b04 retry failed"
        redraws = [skipped, config + " | 991.9 KiB/s"] * 10 + [done, config_done] * 10 + [error] * 2
        process = self.launch(
            "import os, sys\n"
            f"for line in {redraws!r}:\n"
            "    os.write(1, ('\\x1b[2K' + line + '\\r').encode())\n"
            f"os.write(1, {config_done.encode()!r})\n"
            "sys.exit(9)"
        )
        output, _ = process.communicate(timeout=5)
        lines = output.decode().splitlines()
        for expected in (skipped, done, config, config_done):
            self.assertEqual(lines.count(expected), 1, expected)
        self.assertEqual(lines.count(error), 2)
        self.assertEqual(process.returncode, 9)

    def test_interrupt_and_terminate_clean_up_unresponsive_child(self):
        for signum in (signal.SIGINT, signal.SIGTERM):
            with self.subTest(signal=signum):
                process = self.launch(
                    "import os, signal, time; "
                    "signal.signal(signal.SIGINT, signal.SIG_IGN); "
                    "signal.signal(signal.SIGTERM, signal.SIG_IGN); "
                    "os.write(1, (str(os.getpid()) + '\\r').encode()); time.sleep(30)"
                )
                child_pid = int(self.first_output(process).strip())
                process.send_signal(signum)
                remaining, _ = process.communicate(timeout=6)
                self.assertEqual(process.returncode, 128 + signum)
                self.assertGreaterEqual(self.elapsed(remaining.decode(), 128 + signum), 3)
                with self.assertRaises(ProcessLookupError):
                    os.kill(child_pid, 0)


if __name__ == "__main__":
    unittest.main()
