"""Protocol handling of pager_kernel.  Run from tern_kernel/:  python -m unittest discover -s tests -t . -v"""

import json
import os
import subprocess
import sys
import threading
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
KERNEL_DIR = os.path.dirname(HERE)
sys.path.insert(0, KERNEL_DIR)

from pager_kernel import display, introspect, magics, protocol  # noqa: E402


class WireFormat(unittest.TestCase):
    def test_encode_is_one_utf8_line(self):
        raw = protocol.encode_message({"type": "stream", "text": "a\nb é ✓"})
        self.assertTrue(raw.endswith(b"\n"))
        self.assertEqual(raw.count(b"\n"), 1)
        self.assertEqual(json.loads(raw)["text"], "a\nb é ✓")

    def test_nan_and_unserialisable_values_do_not_break_the_line(self):
        raw = protocol.encode_message({"type": "x", "v": float("nan"), "o": object()})
        self.assertEqual(raw.count(b"\n"), 1)
        json.loads(raw)

    def test_decode_line(self):
        self.assertEqual(protocol.decode_line(b'{"type": "interrupt"}\n'), {"type": "interrupt"})
        self.assertIsNone(protocol.decode_line("   "))
        self.assertIsNone(protocol.decode_line("not json"))
        self.assertIsNone(protocol.decode_line('{"no_type": 1}'))
        self.assertIsNone(protocol.decode_line("[1, 2]"))

    def test_output_bus_merges_adjacent_writes_in_order(self):
        sent = []

        class Chan:
            def send(self, msg):
                sent.append(msg)

        bus = protocol.OutputBus(Chan(), lambda: "7", interval=0.0)
        bus.write("stdout", "a")
        bus.write("stdout", "b")
        bus.write("stderr", "e")
        bus.write("stdout", "c")
        bus.flush_now()
        self.assertEqual([(m["name"], m["text"], m["id"]) for m in sent], [("stdout", "ab", "7"), ("stderr", "e", "7"), ("stdout", "c", "7")])


class Pure(unittest.TestCase):
    def test_mime_bundle_prefers_reprs_and_always_has_plain(self):
        class Frame:
            def _repr_html_(self):
                return "<table></table>"

            def __repr__(self):
                return "Frame"

        data, _ = display.mime_bundle(Frame())
        self.assertEqual(data["text/html"], "<table></table>")
        self.assertEqual(data["text/plain"], "Frame")
        data, _ = display.mime_bundle([1, 2])
        self.assertEqual(data, {"text/plain": "[1, 2]"})

    def test_broken_repr_does_not_raise(self):
        class Bad:
            def __repr__(self):
                raise RuntimeError("no")

        data, _ = display.mime_bundle(Bad())
        self.assertIn("repr failed", data["text/plain"])

    def test_magic_lines_are_rewritten_only_for_percent_and_bang(self):
        out = magics.transform_magics("%config A.b = 1\nx = 3 != 4\n!echo hi\n  %who")
        self.assertIn("__pager__.line('config', 'A.b = 1')", out)
        self.assertIn("x = 3 != 4", out)
        self.assertIn("__pager__.shell('echo hi')", out)
        self.assertIn("  __pager__.line('who', '')", out)

    def test_completion(self):
        ns = {"alpha": 1, "text": "abc"}
        matches, start, end = introspect.complete(ns, "al", 2)
        self.assertEqual((start, end), (0, 2))
        self.assertIn("alpha", [m["text"] for m in matches])
        matches, start, end = introspect.complete(ns, "text.up", 7)
        self.assertEqual([m["text"] for m in matches], ["upper"])
        self.assertEqual(start, 5)
        matches, start, _ = introspect.complete(ns, "import jso", 10)
        self.assertIn("json", [m["text"] for m in matches])
        self.assertEqual(start, 7)


class Session:
    """A kernel subprocess driven over its pipes, like the host does."""

    def __init__(self):
        env = dict(os.environ, PYTHONPATH=KERNEL_DIR + os.pathsep + os.environ.get("PYTHONPATH", ""), PYTHONUNBUFFERED="1")
        self.proc = subprocess.Popen([sys.executable, "-u", "-m", "pager_kernel"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
        self.events = []
        self.batching = False
        self.cv = threading.Condition()
        threading.Thread(target=self._read, daemon=True).start()
        self.ready = self.wait(lambda e: e["type"] == "ready")

    def _read(self):
        for line in self.proc.stdout:
            msg = json.loads(line)
            with self.cv:
                self.events.append(msg)
                self.cv.notify_all()

    def wait(self, pred, timeout=30):
        end = time.time() + timeout
        with self.cv:
            while True:
                for e in self.events:
                    if pred(e):
                        return e
                left = end - time.time()
                if left <= 0:
                    raise AssertionError("timeout; events: %r" % self.events[-5:])
                self.cv.wait(left)

    def send(self, **msg):
        if msg.get("type") == "execute" and not self.batching:
            time.sleep(0.12)  # past the kernel's 50 ms abort window after a failed cell
        self.proc.stdin.write((json.dumps(msg) + "\n").encode())
        self.proc.stdin.flush()

    def run(self, cid, code, **extra):
        self.send(type="execute", id=cid, code=code, **extra)
        self.wait(lambda e: e["type"] == "done" and e.get("id") == cid)
        return [e for e in self.events if e.get("id") == cid]

    def text(self, evs, name=None):
        return "".join(e["text"] for e in evs if e["type"] == "stream" and (name is None or e["name"] == name))

    def close(self):
        try:
            self.send(type="shutdown")
            self.proc.stdin.close()
        except OSError:
            pass
        try:
            self.proc.wait(5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        self.proc.stdout.close()
        self.proc.stderr.close()


class KernelProcess(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.k = Session()

    @classmethod
    def tearDownClass(cls):
        cls.k.close()

    def test_ready_announces_python_and_protocol(self):
        info = self.k.ready["info"]
        self.assertEqual(info["protocol"], 1)
        self.assertEqual(info["python"].split(".")[0], "3")
        self.assertEqual(info["kernel"], "pager_kernel")

    def test_stdout_stderr_result_and_counts(self):
        evs = self.k.run("a", 'import sys\nprint("out")\nprint("err", file=sys.stderr)\n6 * 7')
        self.assertEqual(self.k.text(evs, "stdout"), "out\n")
        self.assertEqual(self.k.text(evs, "stderr"), "err\n")
        result = next(e for e in evs if e["type"] == "result")
        self.assertEqual(result["data"]["text/plain"], "42")
        done = next(e for e in evs if e["type"] == "done")
        self.assertEqual(done["status"], "ok")
        self.assertGreaterEqual(done["ms"], 0)
        self.assertEqual(done["count"], next(e for e in evs if e["type"] == "started")["count"])

    def test_trailing_semicolon_hides_the_result(self):
        evs = self.k.run("semi", "1 + 1;")
        self.assertFalse([e for e in evs if e["type"] == "result"])

    def test_error_carries_traceback_and_aborts_the_batch(self):
        self.k.batching = True
        self.k.send(type="execute", id="e1", code="import time; time.sleep(0.2); raise KeyError('k')", stop_on_error=True)
        self.k.send(type="execute", id="e2", code="print('never')", stop_on_error=True)
        self.k.send(type="execute", id="e3", code="print('never')", stop_on_error=True)
        self.k.batching = False
        self.k.wait(lambda e: e["type"] == "done" and e.get("id") == "e3")
        err = next(e for e in self.k.events if e["type"] == "error" and e["id"] == "e1")
        self.assertEqual(err["ename"], "KeyError")
        self.assertTrue(any("KeyError" in line for line in err["traceback"]))
        self.assertEqual(next(e for e in self.k.events if e["type"] == "done" and e["id"] == "e2")["status"], "aborted")
        self.assertEqual(next(e for e in self.k.events if e["type"] == "done" and e["id"] == "e3")["status"], "aborted")
        self.assertEqual(self.k.text([e for e in self.k.events if e.get("id") in ("e2", "e3")]), "")

    def test_without_stop_on_error_the_queue_goes_on(self):
        self.k.batching = True
        self.k.send(type="execute", id="n1", code="raise ValueError()", stop_on_error=False)
        self.k.send(type="execute", id="n2", code="print('ran')", stop_on_error=False)
        self.k.batching = False
        self.k.wait(lambda e: e["type"] == "done" and e.get("id") == "n2")
        self.assertEqual(next(e for e in self.k.events if e["type"] == "done" and e["id"] == "n2")["status"], "ok")

    def test_syntax_error_is_reported_not_fatal(self):
        evs = self.k.run("syn", "def broken(:\n  pass")
        self.assertEqual(next(e for e in evs if e["type"] == "error")["ename"], "SyntaxError")
        self.assertEqual(self.k.text(self.k.run("after", "print('alive')")), "alive\n")

    def test_tqdm_style_carriage_returns_arrive_intact(self):
        evs = self.k.run("cr", 'import sys\nfor p in (0, 50, 100):\n    sys.stderr.write("\\rLoading %3d%%" % p)\n    sys.stderr.flush()\nsys.stderr.write("\\n")')
        text = self.k.text(evs, "stderr")
        self.assertIn("\rLoading   0%", text)
        self.assertTrue(text.endswith("\rLoading 100%\n"))

    def test_c_level_and_child_process_output_land_in_the_cell(self):
        evs = self.k.run("fd", 'import os, subprocess, sys\nsubprocess.run([sys.executable, "-c", "print(5)"])\nos.write(1, b"raw\\n")\nprint("py")')
        # Python-level and fd-level writes travel different paths, so their relative order is not promised.
        self.assertEqual(sorted(self.k.text(evs, "stdout").replace("\r\n", "\n").split()), ["5", "py", "raw"])

    def test_display_html_and_display_id_update(self):
        evs = self.k.run("disp", 'from IPython.display import display, HTML\nh = display(HTML("<b>one</b>"), display_id=True)\nh.update(HTML("<b>two</b>"))')
        shown = next(e for e in evs if e["type"] == "display")
        self.assertEqual(shown["data"]["text/html"], "<b>one</b>")
        update = next(e for e in self.k.events if e["type"] == "update")
        self.assertEqual(update["display_id"], shown["display_id"])
        self.assertEqual(update["data"]["text/html"], "<b>two</b>")

    def test_clear_output_and_state_persist(self):
        self.k.run("s1", "kept = 5")
        evs = self.k.run("s2", "from IPython.display import clear_output\nclear_output(wait=True)\nprint(kept)")
        self.assertEqual(next(e for e in evs if e["type"] == "clear")["wait"], True)
        self.assertEqual(self.k.text(evs), "5\n")

    def test_input_round_trip_and_interrupt_while_waiting(self):
        self.k.send(type="execute", id="in1", code='v = input("name? ")\nprint("got", v)', allow_stdin=True)
        ask = self.k.wait(lambda e: e["type"] == "input" and e.get("id") == "in1")
        self.assertEqual(ask["prompt"], "name? ")
        self.k.send(type="input_reply", value="pager")
        self.k.wait(lambda e: e["type"] == "done" and e.get("id") == "in1")
        self.assertEqual(self.k.text([e for e in self.k.events if e.get("id") == "in1"]), "got pager\n")
        self.k.send(type="execute", id="in2", code="input()", allow_stdin=True)
        self.k.wait(lambda e: e["type"] == "input" and e.get("id") == "in2")
        self.k.send(type="interrupt")
        self.k.wait(lambda e: e["type"] == "done" and e.get("id") == "in2")
        self.assertEqual(next(e for e in self.k.events if e["type"] == "error" and e["id"] == "in2")["ename"], "KeyboardInterrupt")

    def test_input_without_allow_stdin_is_an_error(self):
        evs = self.k.run("nostdin", "input()", allow_stdin=False)
        self.assertEqual(next(e for e in evs if e["type"] == "error")["ename"], "RuntimeError")

    def test_interrupt_wakes_a_sleeping_cell(self):
        self.k.send(type="execute", id="sl", code="import time\ntime.sleep(60)")
        self.k.wait(lambda e: e["type"] == "started" and e.get("id") == "sl")
        time.sleep(0.3)
        t0 = time.time()
        self.k.send(type="interrupt")
        done = self.k.wait(lambda e: e["type"] == "done" and e.get("id") == "sl", 10)
        self.assertLess(time.time() - t0, 5)
        self.assertEqual(done["status"], "error")
        self.assertEqual(next(e for e in self.k.events if e["type"] == "error" and e["id"] == "sl")["ename"], "KeyboardInterrupt")

    def test_interrupt_when_idle_does_nothing(self):
        self.k.send(type="interrupt")
        self.assertEqual(self.k.text(self.k.run("idle", "print('fine')")), "fine\n")

    def test_magics(self):
        evs = self.k.run("mg", "%config InlineBackend.figure_format = 'png'\n%pwd")
        self.assertEqual(next(e for e in evs if e["type"] == "done")["status"], "ok")
        evs = self.k.run("mg2", "%%time\nx = sum(range(10))")
        self.assertIn("Wall time", self.k.text(evs))
        evs = self.k.run("mg3", "%nosuchmagic")
        self.assertEqual(next(e for e in evs if e["type"] == "error")["ename"], "MagicError")

    def test_complete_inspect_variables_ping(self):
        self.k.run("v", "numbers = [1, 2, 3]")
        self.k.send(type="complete", id="c1", code="numb", cursor=4)
        c = self.k.wait(lambda e: e["type"] == "completions" and e.get("id") == "c1")
        self.assertIn("numbers", [m["text"] for m in c["matches"]])
        self.k.send(type="inspect", id="i1", code="len", cursor=3)
        i = self.k.wait(lambda e: e["type"] == "inspection" and e.get("id") == "i1")
        self.assertTrue(i["found"])
        self.k.send(type="variables", id="v1")
        v = self.k.wait(lambda e: e["type"] == "variables" and e.get("id") == "v1")
        entry = next(x for x in v["vars"] if x["name"] == "numbers")
        self.assertEqual((entry["type"], entry["size"]), ("list", "3"))
        self.k.send(type="ping", id="p1")
        self.k.wait(lambda e: e["type"] == "pong" and e.get("id") == "p1")

    def test_garbage_lines_are_ignored(self):
        self.k.proc.stdin.write(b"not json\n\n[1]\n")
        self.k.proc.stdin.flush()
        self.assertEqual(self.k.text(self.k.run("g", "print('ok')")), "ok\n")


class Lifecycle(unittest.TestCase):
    def test_closing_stdin_ends_the_kernel(self):
        k = Session()
        k.proc.stdin.close()
        self.assertEqual(k.proc.wait(10), 0)
        k.proc.stdout.close()
        k.proc.stderr.close()

    def test_no_listening_socket(self):
        k = Session()
        try:
            code = "import socket\nprint(hasattr(socket, 'socket') and 'ok')"
            evs = k.run("net", code)
            self.assertEqual(k.text(evs), "ok\n")
            import re

            pid = k.ready["info"]["pid"]
            if os.name == "nt":
                out = subprocess.run(["netstat", "-ano", "-p", "TCP"], capture_output=True, text=True).stdout
                self.assertFalse(re.search(r"LISTENING\s+%d\s*$" % pid, out, re.M), "the kernel must not listen on any port")
        finally:
            k.close()


if __name__ == "__main__":
    unittest.main()
