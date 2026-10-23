"""The small set of IPython-style magics and `!shell` escapes a plain Python can honour."""

import ast
import os
import queue
import shlex
import subprocess
import sys
import threading
import time


class MagicError(Exception):
    pass


def transform_magics(code):
    """Rewrite `%magic args` and `!cmd` lines into calls on __pager__ (only used after a SyntaxError)."""
    out = []
    for raw in code.splitlines(True):
        body = raw.rstrip("\r\n")
        tail = raw[len(body):]
        stripped = body.lstrip()
        indent = body[: len(body) - len(stripped)]
        if stripped.startswith("%") and not stripped.startswith("%%"):
            name, _, rest = stripped[1:].partition(" ")
            out.append("%s__pager__.line(%r, %r)%s" % (indent, name.strip(), rest.strip(), tail))
        elif stripped.startswith("!") and not stripped.startswith("!="):
            out.append("%s__pager__.shell(%r)%s" % (indent, stripped[1:], tail))
        else:
            out.append(raw)
    return "".join(out)


def _note(text):
    sys.stderr.write(text.rstrip("\n") + "\n")


class Magics:
    def __init__(self, kernel):
        self.k = kernel

    # ---- dispatch ---------------------------------------------------------

    def line(self, name, rest=""):
        handler = getattr(self, "m_" + name, None)
        if handler is None:
            raise MagicError("Unknown magic %%%s" % name)
        return handler(rest)

    def cell(self, name, rest, body):
        handler = getattr(self, "c_" + name, None)
        if handler is None:
            raise MagicError("Unknown cell magic %%%%%s" % name)
        return handler(rest, body)

    # ---- line magics ------------------------------------------------------

    def m_config(self, rest):
        if not rest.strip():
            sys.stdout.write("InlineBackend.figure_format = %r\nInlineBackend.close_figures = %r\n" % (self.k.figure_format, self.k.close_figures))
            return
        key, eq, value = rest.partition("=")
        key = key.strip()
        if not eq:
            raise MagicError("Usage: %config Class.option = value")
        try:
            val = ast.literal_eval(value.strip())
        except (ValueError, SyntaxError):
            val = value.strip()
        if key == "InlineBackend.figure_format":
            fmt = str(val).lower()
            if fmt not in ("png", "retina", "svg", "jpg", "jpeg"):
                raise MagicError("InlineBackend.figure_format must be png, retina, svg or jpeg, not %r" % val)
            self.k.figure_format = fmt
        elif key == "InlineBackend.close_figures":
            self.k.close_figures = bool(val)
        else:
            raise MagicError("Unsupported option %r; supported: InlineBackend.figure_format, InlineBackend.close_figures" % key)

    def m_matplotlib(self, rest):
        arg = rest.strip()
        if arg in ("", "inline", "--list") or arg.endswith("inline"):
            self.k.hook_matplotlib()
            return
        _note("%%matplotlib %s: only the inline backend exists here; figures show under the cell." % arg)

    def _unsupported_ext(self, name):
        def go(rest):
            _note("%%%s %s: extensions aren't supported on a plain Python; restart the kernel after editing modules." % (name, rest))

        return go

    def m_load_ext(self, rest):
        self._unsupported_ext("load_ext")(rest)

    m_reload_ext = m_load_ext

    def m_autoreload(self, rest):
        self._unsupported_ext("autoreload")(rest)

    def m_cd(self, rest):
        path = os.path.expanduser(rest.strip() or "~")
        try:
            os.chdir(path)
        except OSError as exc:
            raise MagicError("cd: %s" % exc)
        sys.stdout.write(os.getcwd() + "\n")

    def m_pwd(self, rest):
        sys.stdout.write(os.getcwd() + "\n")

    def m_ls(self, rest):
        target = rest.strip() or "."
        try:
            names = sorted(os.listdir(target))
        except OSError as exc:
            raise MagicError("ls: %s" % exc)
        sys.stdout.write("\n".join(names) + ("\n" if names else ""))

    def m_env(self, rest):
        rest = rest.strip()
        if not rest:
            for key in sorted(os.environ):
                sys.stdout.write("%s=%s\n" % (key, os.environ[key]))
        elif "=" in rest:
            key, _, value = rest.partition("=")
            os.environ[key.strip()] = value.strip()
        else:
            sys.stdout.write(os.environ.get(rest, "") + "\n")

    def m_pip(self, rest):
        self.stream([sys.executable, "-m", "pip"] + shlex.split(rest, posix=os.name != "nt"))

    def m_who(self, rest):
        names = [n for n in sorted(self.k.ns) if not n.startswith("_") and n not in self.k._hidden]
        sys.stdout.write("   ".join(names) + "\n" if names else "Interactive namespace is empty.\n")

    def m_reset(self, rest):
        for name in [n for n in self.k.ns if n not in self.k._hidden and not n.startswith("__")]:
            del self.k.ns[name]

    def m_time(self, rest):
        t0 = time.perf_counter()
        self._exec_text(rest)
        sys.stdout.write("Wall time: %s\n" % _fmt_time(time.perf_counter() - t0))

    def m_timeit(self, rest):
        import timeit

        stmt = rest.strip()
        timer = timeit.Timer(stmt, globals=self.k.ns)
        number, _ = timer.autorange()
        runs = [t / number for t in timer.repeat(repeat=5, number=number)]
        best = min(runs)
        mean = sum(runs) / len(runs)
        sys.stdout.write("%s ± %s per loop (best of 5, %d loops each)\n" % (_fmt_time(mean), _fmt_time(max(runs) - best), number))

    def _exec_text(self, text):
        tree = ast.parse(text, "<magic>")
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            last = tree.body.pop()
            exec(compile(tree, "<magic>", "exec"), self.k.ns)
            value = eval(compile(ast.Expression(last.value), "<magic>", "eval"), self.k.ns)
            if value is not None:
                self.k.display(value)
        else:
            exec(compile(tree, "<magic>", "exec"), self.k.ns)

    # ---- cell magics ------------------------------------------------------

    def c_time(self, rest, body):
        t0 = time.perf_counter()
        status, err = self.k.run_cell(body, self.k.count)
        if err is not None:
            raise _Reraise(err)
        sys.stdout.write("Wall time: %s\n" % _fmt_time(time.perf_counter() - t0))

    def c_bash(self, rest, body):
        self.stream(["bash", "-c", body])

    c_sh = c_bash

    def c_powershell(self, rest, body):
        self.stream(["powershell", "-NoProfile", "-Command", body])

    def c_cmd(self, rest, body):
        self.stream(body, shell=True)

    def c_writefile(self, rest, body):
        parts = shlex.split(rest, posix=os.name != "nt")
        append = "-a" in parts
        parts = [p for p in parts if p != "-a"]
        if len(parts) != 1:
            raise MagicError("Usage: %%writefile [-a] path")
        with open(parts[0], "a" if append else "w", encoding="utf-8", newline="") as fh:
            fh.write(body)
        sys.stdout.write("%s %s\n" % ("Appending to" if append else "Writing", parts[0]))

    def c_html(self, rest, body):
        self.k.display(__import__("pager_kernel.display", fromlist=["HTML"]).HTML(body))

    def c_markdown(self, rest, body):
        self.k.display(__import__("pager_kernel.display", fromlist=["Markdown"]).Markdown(body))

    # ---- subprocess streaming ------------------------------------------

    def shell(self, cmd):
        self.stream(cmd.strip(), shell=True)

    def stream(self, args, shell=False):
        env = dict(os.environ, PYTHONUNBUFFERED="1", PYTHONIOENCODING="utf-8")
        try:
            proc = subprocess.Popen(
                args,
                shell=shell,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                cwd=os.getcwd(),
                env=env,
            )
        except OSError as exc:
            raise MagicError(str(exc))
        chunks = queue.Queue()

        def pump():
            while True:
                data = os.read(proc.stdout.fileno(), 4096)
                chunks.put(data)
                if not data:
                    return

        threading.Thread(target=pump, daemon=True).start()
        import codecs

        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        try:
            while True:
                try:
                    data = chunks.get(timeout=0.1)
                except queue.Empty:
                    continue
                if not data:
                    break
                sys.stdout.write(decoder.decode(data))
            sys.stdout.write(decoder.decode(b"", True))
            code = proc.wait()
        except BaseException:
            _kill_tree(proc)
            raise
        if code:
            _note("[exit status %d]" % code)


class _Reraise(Exception):
    """Carries an already-formatted error from a nested run_cell."""

    def __init__(self, err):
        super().__init__(err["evalue"])
        self.err = err


def _kill_tree(proc):
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], capture_output=True)
        else:
            proc.kill()
    except Exception:
        pass


def _fmt_time(seconds):
    if seconds < 1e-6:
        return "%.0f ns" % (seconds * 1e9)
    if seconds < 1e-3:
        return "%.3g µs" % (seconds * 1e6)
    if seconds < 1:
        return "%.3g ms" % (seconds * 1e3)
    return "%.3g s" % seconds
