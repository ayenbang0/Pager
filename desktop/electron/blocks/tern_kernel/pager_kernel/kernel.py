"""The kernel: executes cells in one persistent namespace and reports over the wire."""

import ast
import builtins
import linecache
import os
import platform
import queue
import sys
import threading
import time
import traceback
import types
import uuid

from . import PROTOCOL_VERSION, __version__
from . import display as disp
from . import introspect
from .magics import Magics, MagicError, transform_magics
from .protocol import Channel, FdDrain, OutStream, OutputBus, decode_line

ANSI_RED = "\x1b[0;31m"
ANSI_BRED = "\x1b[1;31m"
ANSI_GREEN = "\x1b[1;32m"
ANSI_END = "\x1b[0m"


_ACTIVE = []


def active_kernel():
    """The running Kernel of this process (the inline matplotlib backend flushes figures through it)."""
    return _ACTIVE[0] if _ACTIVE else None


class DisplayHandle:
    def __init__(self, kernel, display_id):
        self._kernel = kernel
        self.display_id = display_id

    def display(self, obj, **kwargs):
        self._kernel.display(obj, display_id=self.display_id, **kwargs)

    def update(self, obj, **kwargs):
        data, meta = disp.mime_bundle(obj, self._kernel.figure_format)
        self._kernel.send({"type": "update", "display_id": self.display_id, "data": data, "metadata": meta})


class Kernel:
    def __init__(self, channel, bus=None, drains=(), stdin_stream=None):
        self.channel = channel
        self.current_id = None
        self.bus = bus or OutputBus(channel, lambda: self.current_id)
        self.drains = list(drains)
        self.count = 0
        self.figure_format = os.environ.get("PAGER_FIGURE_FORMAT", "retina")
        self.close_figures = True
        self.busy = False
        self.waiting_input = False
        self.allow_stdin = False
        self.shell_shim = disp.ShimShell(self)
        self.DisplayHandle = DisplayHandle
        self.inbox = queue.Queue()
        self.input_q = queue.Queue()
        self._displayed_figs = set()
        self._shutdown = False
        self._abort_until = 0.0
        self.main_mod = types.ModuleType("__main__")
        self.main_mod.__builtins__ = builtins
        self.ns = self.main_mod.__dict__
        self.In = [""]
        self.Out = {}
        self.magics = Magics(self)
        self._mpl_hooked = False
        self._init_namespace()
        self._hidden = set(self.ns)
        _ACTIVE[:] = [self]

    # ---- plumbing -------------------------------------------------------

    def send(self, msg):
        self.channel.send(msg)

    def _init_namespace(self):
        ns = self.ns
        ns.update(
            {
                "display": self.display,
                "clear_output": self.clear_output,
                "get_ipython": lambda: self.shell_shim,
                "__pager__": self.magics,
                "In": self.In,
                "Out": self.Out,
                "_": "",
                "__": "",
                "___": "",
            }
        )
        builtins.display = self.display
        builtins.get_ipython = lambda: self.shell_shim
        builtins.input = self._input
        try:
            import getpass

            getpass.getpass = lambda prompt="Password: ", stream=None: self._input(prompt, password=True)
        except Exception:
            pass
        disp.install_ipython_shim(self)

    def ready_info(self):
        import importlib.util

        def has(name):
            try:
                return importlib.util.find_spec(name) is not None
            except (ImportError, ValueError):
                return False

        return {
            "protocol": PROTOCOL_VERSION,
            "kernel": "pager_kernel",
            "kernel_version": __version__,
            "python": platform.python_version(),
            "implementation": platform.python_implementation(),
            "executable": sys.executable,
            "platform": sys.platform,
            "cwd": os.getcwd(),
            "pid": os.getpid(),
            "packages": {n: has(n) for n in ("numpy", "pandas", "matplotlib", "tqdm")},
        }

    # ---- matplotlib inline ----------------------------------------------

    def hook_matplotlib(self):
        """Make `import matplotlib.pyplot` pick the inline backend unless the user chose one."""
        if self._mpl_hooked or os.environ.get("MPLBACKEND"):
            return
        self._mpl_hooked = True
        kernel = self

        class _Finder:
            def find_spec(self, fullname, path=None, target=None):
                if fullname == "matplotlib.pyplot":
                    try:
                        sys.meta_path.remove(self)
                    except ValueError:
                        pass
                    try:
                        import matplotlib

                        matplotlib.use("module://pager_kernel.mpl_backend")
                    except Exception:
                        pass
                return None

        sys.meta_path.insert(0, _Finder())

    def flush_figures(self, close=True):
        """Emit every open matplotlib figure as a display, then close them."""
        plt = sys.modules.get("matplotlib.pyplot")
        if plt is None:
            return
        try:
            from matplotlib import _pylab_helpers

            managers = list(_pylab_helpers.Gcf.get_all_fig_managers())
        except Exception:
            return
        for manager in managers:
            fig = manager.canvas.figure
            if id(fig) not in self._displayed_figs:
                data, meta = disp.render_figure(fig, self.figure_format)
                if data:
                    self.send({"id": self.current_id, "type": "display", "data": data, "metadata": meta, "display_id": None})
            if close:
                try:
                    plt.close(fig)
                except Exception:
                    pass
        self._displayed_figs.clear()

    # ---- display API ----------------------------------------------------

    def display(self, *objs, display_id=None, **kwargs):
        if display_id is True:
            display_id = uuid.uuid4().hex
        for obj in objs:
            data, meta = disp.mime_bundle(obj, self.figure_format)
            fig = disp._as_figure(obj)
            if fig is not None:
                self._displayed_figs.add(id(fig))
            self.send({"id": self.current_id, "type": "display", "data": data, "metadata": meta, "display_id": display_id})
        return DisplayHandle(self, display_id) if display_id else None

    def clear_output(self, wait=False):
        self.bus.flush_now()
        self.send({"id": self.current_id, "type": "clear", "wait": bool(wait)})

    # ---- stdin ----------------------------------------------------------

    def _input(self, prompt="", password=False):
        if not self.allow_stdin:
            raise RuntimeError("input() was called but this run does not allow stdin")
        self.bus.flush_now()
        self.send({"id": self.current_id, "type": "input", "prompt": str(prompt), "password": bool(password)})
        self.waiting_input = True
        try:
            while True:
                try:
                    value = self.input_q.get(timeout=0.1)
                except queue.Empty:
                    continue
                if value is None:
                    raise KeyboardInterrupt()
                return value
        finally:
            self.waiting_input = False

    @staticmethod
    def interrupt_main():
        """KeyboardInterrupt in the main thread, also out of time.sleep() and blocking C calls (interrupt_main() only
        sets a flag that a sleeping thread never sees)."""
        import signal

        if os.name == "nt":
            signal.raise_signal(signal.SIGINT)
        else:
            signal.pthread_kill(threading.main_thread().ident, signal.SIGINT)

    # ---- shell escape / magics (used by magics.py) -----------------------

    def shell(self, cmd):
        return self.magics.shell(cmd)

    def line_magic(self, name, line=""):
        return self.magics.line(name, line)

    def cell_magic(self, name, line, body):
        return self.magics.cell(name, line, body)

    # ---- execution ------------------------------------------------------

    def _compile(self, code, filename):
        """-> (body_code | None, last_expr_code | None). Magic lines are rewritten on demand."""
        try:
            tree = ast.parse(code, filename)
        except SyntaxError as first:
            rewritten = transform_magics(code)
            if rewritten == code:
                raise
            try:
                tree = ast.parse(rewritten, filename)
            except SyntaxError:
                raise first
            code = rewritten
        last = None
        if tree.body and isinstance(tree.body[-1], ast.Expr) and not code.rstrip().endswith(";"):
            last = tree.body.pop()
        body = compile(tree, filename, "exec") if tree.body else None
        expr = None
        if last is not None:
            node = ast.Expression(last.value)
            ast.copy_location(node, last)
            ast.fix_missing_locations(node)
            expr = compile(node, filename, "eval")
        return body, expr, code

    def run_cell(self, code, count):
        """Execute; returns (status, error_dict|None)."""
        filename = "<cell %d>" % count
        lines = code.splitlines(True)
        linecache.cache[filename] = (len(code), None, lines, filename)
        self.ns["__pager_cell__"] = count
        try:
            first = code.lstrip()
            if first.startswith("%%"):
                head, _, body = code.lstrip().partition("\n")
                name, _, rest = head[2:].partition(" ")
                self.magics.cell(name.strip(), rest.strip(), body)
                return "ok", None
            body, expr, _ = self._compile(code, filename)
            if body is not None:
                exec(body, self.ns)
            if expr is not None:
                value = eval(expr, self.ns)
                if value is not None:
                    self._publish_result(value, count)
            return "ok", None
        except SystemExit as exc:
            return "error", self._error("SystemExit", str(exc.code) if exc.code is not None else "", exc, filename)
        except MagicError as exc:
            return "error", {"ename": "MagicError", "evalue": str(exc), "traceback": [ANSI_BRED + "MagicError" + ANSI_END + ": " + str(exc)]}
        except KeyboardInterrupt as exc:
            return "error", self._error("KeyboardInterrupt", "", exc, filename)
        except BaseException as exc:  # noqa: BLE001 - everything a cell raises is reported, never fatal
            return "error", self._error(type(exc).__name__, str(exc), exc, filename)

    def _publish_result(self, value, count):
        data, meta = disp.mime_bundle(value, self.figure_format)
        fig = disp._as_figure(value)
        if fig is not None:
            self._displayed_figs.add(id(fig))
        self.ns["___"], self.ns["__"], self.ns["_"] = self.ns.get("__"), self.ns.get("_"), value
        self.ns["_%d" % count] = value
        self.Out[count] = value
        self.send({"id": self.current_id, "type": "result", "count": count, "data": data, "metadata": meta})

    def _error(self, ename, evalue, exc, filename):
        return {"ename": ename, "evalue": evalue, "traceback": format_traceback(exc, self.ns.get("__pager_cell__"))}

    def execute(self, msg):
        cid = msg.get("id")
        code = msg.get("code") or ""
        silent = bool(msg.get("silent"))
        store = bool(msg.get("store_history", not silent))
        self.allow_stdin = bool(msg.get("allow_stdin", False))
        self.current_id = cid
        self.busy = True
        count = self.count
        if store and not silent:
            self.count += 1
            count = self.count
            self.In.append(code)
        if not silent:
            self.send({"id": cid, "type": "started", "count": count})
        t0 = time.perf_counter()
        status, err = "ok", None
        try:
            status, err = self.run_cell(code, count if count else 0)
        except KeyboardInterrupt:
            status, err = "error", {"ename": "KeyboardInterrupt", "evalue": "", "traceback": [ANSI_BRED + "KeyboardInterrupt" + ANSI_END + ": "]}
        finally:
            self.busy = False
        self._settle()
        if err is not None:
            self.send({"id": cid, "type": "error", **err})
        ms = int((time.perf_counter() - t0) * 1000)
        self.send({"id": cid, "type": "done", "status": status, "count": count, "ms": ms})
        if status == "error" and msg.get("stop_on_error", True):
            self._abort_queued()
            # Requests still in flight on the pipe belong to the same batch (a Run All): abort those too.
            self._abort_until = time.monotonic() + 0.05

    def _settle(self):
        """After a cell: C-level output drained in order, figures flushed, bus emptied."""
        try:
            for d in self.drains:
                d.sync()
            self.flush_figures(close=self.close_figures)
        except KeyboardInterrupt:
            pass
        self.bus.flush_now()

    def _abort_queued(self):
        keep = []
        while True:
            try:
                item = self.inbox.get_nowait()
            except queue.Empty:
                break
            if item.get("type") == "execute":
                self.send({"id": item.get("id"), "type": "done", "status": "aborted", "count": self.count, "ms": 0})
            else:
                keep.append(item)
        for item in keep:
            self.inbox.put(item)

    # ---- other requests ---------------------------------------------------

    def handle(self, msg):
        kind = msg.get("type")
        rid = msg.get("id")
        if kind == "execute":
            self.execute(msg)
        elif kind == "complete":
            matches, start, end = introspect.complete(self.ns, msg.get("code", ""), int(msg.get("cursor", 0)))
            self.send({"id": rid, "type": "completions", "matches": matches, "cursor_start": start, "cursor_end": end})
        elif kind == "inspect":
            found, data = introspect.inspect_at(self.ns, msg.get("code", ""), int(msg.get("cursor", 0)), int(msg.get("detail", 0)))
            self.send({"id": rid, "type": "inspection", "found": found, "data": data})
        elif kind == "variables":
            self.send({"id": rid, "type": "variables", "vars": introspect.variables(self.ns, self._hidden)})

    def on_reader_message(self, msg):
        """Runs on the reader thread: things that must act while a cell is running."""
        kind = msg.get("type")
        if kind == "interrupt":
            if self.waiting_input:
                self.input_q.put(None)
            elif self.busy:
                self.interrupt_main()
        elif kind == "input_reply":
            self.input_q.put(str(msg.get("value", "")))
        elif kind == "configure":
            fmt = msg.get("figure_format")
            if isinstance(fmt, str):
                self.figure_format = fmt
            if "close_figures" in msg:
                self.close_figures = bool(msg["close_figures"])
        elif kind == "ping":
            self.send({"id": msg.get("id"), "type": "pong"})
        elif kind == "shutdown":
            self._shutdown = True
            self.inbox.put({"type": "__stop__"})
        elif kind == "execute" and time.monotonic() < self._abort_until:
            self.send({"id": msg.get("id"), "type": "done", "status": "aborted", "count": self.count, "ms": 0})
        elif kind in ("execute", "complete", "inspect", "variables"):
            self.inbox.put(msg)

    def serve(self):
        self.send({"type": "ready", "info": self.ready_info()})
        while not self._shutdown:
            try:
                msg = self.inbox.get(timeout=0.2)
            except queue.Empty:
                continue
            except KeyboardInterrupt:
                continue
            if msg.get("type") == "__stop__":
                break
            try:
                self.handle(msg)
            except KeyboardInterrupt:
                pass
            except Exception:  # a bug in the kernel must not take the session down
                self.send({"id": msg.get("id"), "type": "kernel_error", "text": traceback.format_exc()})
                if msg.get("type") == "execute":
                    self.send({"id": msg.get("id"), "type": "done", "status": "error", "count": self.count, "ms": 0})


def _frame_lines(path, lineno, name, cell):
    out = []
    if path.startswith("<cell "):
        out.append("%sCell %sIn[%s]%s, %sline %d%s, in %s%s%s" % (ANSI_GREEN, ANSI_END, path[6:-1], ANSI_END, ANSI_GREEN, lineno, ANSI_END, ANSI_GREEN, name, ANSI_END)
                   if name != "<module>" else "%sCell %sIn[%s]%s, %sline %d%s" % (ANSI_GREEN, ANSI_END, path[6:-1], ANSI_END, ANSI_GREEN, lineno, ANSI_END))
    else:
        out.append("%sFile %s%s%s:%s%d%s, in %s%s%s" % (ANSI_GREEN, ANSI_END, path, ANSI_END, ANSI_GREEN, lineno, ANSI_END, ANSI_GREEN, name, ANSI_END))
    for n in range(max(1, lineno - 1), lineno + 1):
        text = linecache.getline(path, n).rstrip("\n")
        if not text and n != lineno:
            continue
        if n == lineno:
            out.append("%s----> %d %s%s" % (ANSI_GREEN, n, ANSI_END, text))
        else:
            out.append("      %d %s" % (n, text))
    return "\n".join(out)


def format_traceback(exc, cell=None, _depth=0):
    """IPython-flavoured traceback lines (ANSI coloured), one string per frame."""
    ename = type(exc).__name__
    lines = []
    if _depth < 4:
        if exc.__cause__ is not None:
            lines += format_traceback(exc.__cause__, cell, _depth + 1)
            lines.append("\nThe above exception was the direct cause of the following exception:\n")
        elif exc.__context__ is not None and not exc.__suppress_context__:
            lines += format_traceback(exc.__context__, cell, _depth + 1)
            lines.append("\nDuring handling of the above exception, another exception occurred:\n")
    if isinstance(exc, SyntaxError):
        lines.append("%s%s%s" % (ANSI_RED, "-" * 75, ANSI_END))
        lines.append("".join(traceback.format_exception_only(type(exc), exc)).rstrip("\n"))
        return lines
    here = os.path.dirname(__file__)
    frames = [
        f
        for f in traceback.extract_tb(exc.__traceback__)
        if not os.path.abspath(f.filename).startswith(os.path.abspath(here))
    ]
    lines.append("%s%s%s" % (ANSI_RED, "-" * 75, ANSI_END))
    lines.append("%s%-42s%s Traceback %s(most recent call last)%s" % (ANSI_RED, ename, ANSI_END, ANSI_RED, ANSI_END))
    for f in frames:
        lines.append(_frame_lines(f.filename, f.lineno or 0, f.name, cell))
    detail = str(exc)
    lines.append("%s%s%s: %s" % (ANSI_BRED, ename, ANSI_END, detail))
    return lines


def main():
    """Entry point for `python -u -m pager_kernel`."""
    proto_in = os.fdopen(os.dup(0), "rb")
    proto_out = os.fdopen(os.dup(1), "wb", buffering=0)
    sys.stdout.flush() if sys.stdout else None
    # fd 0 -> NUL so child processes cannot steal the protocol stream.
    nul = os.open(os.devnull, os.O_RDONLY)
    os.dup2(nul, 0)
    os.close(nul)

    channel = Channel(_Writer(proto_out))
    kernel_box = []
    bus = OutputBus(channel, lambda: kernel_box[0].current_id if kernel_box else None)
    drains = [FdDrain(bus, "stdout", 1), FdDrain(bus, "stderr", 2)]
    sys.stdout = OutStream(bus, "stdout", 1)
    sys.stderr = OutStream(bus, "stderr", 2)
    sys.stdin = _NoStdin()

    import signal

    try:
        signal.signal(signal.SIGINT, signal.default_int_handler)
    except (ValueError, OSError):
        pass
    cwd = os.environ.get("PAGER_KERNEL_CWD")
    if cwd and os.path.isdir(cwd):
        os.chdir(cwd)
    if os.getcwd() not in sys.path and "" not in sys.path:
        sys.path.insert(0, "")

    kernel = Kernel(channel, bus, drains)
    kernel_box.append(kernel)
    kernel.hook_matplotlib()

    def reader():
        while True:
            try:
                line = proto_in.readline()
            except (OSError, ValueError):
                line = b""
            if not line:
                os._exit(0)  # host closed the pipe: no one left to serve
            msg = decode_line(line)
            if msg is not None:
                kernel.on_reader_message(msg)

    threading.Thread(target=reader, name="pager-reader", daemon=True).start()
    kernel.serve()
    return 0


class _Writer:
    def __init__(self, raw):
        self._raw = raw

    def write(self, data):
        view = memoryview(data)
        while view:
            n = self._raw.write(view)
            view = view[n:]

    def flush(self):
        pass


class _NoStdin:
    """sys.stdin while running cells: reads go through input_request via input()."""

    def readline(self, *_):
        return builtins.input("")  + "\n"

    def read(self, *_):
        return ""

    def isatty(self):
        return False

    def fileno(self):
        raise OSError("stdin is not a file here")
