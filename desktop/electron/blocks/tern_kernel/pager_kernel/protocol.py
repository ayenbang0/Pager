"""Wire layer: line-delimited JSON on the original stdin/stdout, plus the output bus.

Requests (host -> kernel), every one a single JSON object per line with a ``type``:
  execute{id,code,silent,store_history,allow_stdin,stop_on_error}
  complete{id,code,cursor}   inspect{id,code,cursor,detail}   variables{id}
  input_reply{value}   interrupt   configure{figure_format}   ping{id}   shutdown

Events (kernel -> host):
  ready{info}  started{id,count}  stream{id,name,text}  display{id,data,metadata,display_id}
  result{id,count,data,metadata}  error{id,ename,evalue,traceback}  clear{id,wait}
  update{display_id,data,metadata}  input{id,prompt,password}
  done{id,status ok|error|aborted,count,ms}  completions{id,matches,cursor_start,cursor_end}
  inspection{id,found,data}  variables{id,vars}  pong{id}
"""

import codecs
import json
import os
import threading
import time

SYNC = "\x1b]pager-sync\x07"


def _default(obj):
    try:
        return str(obj)
    except Exception:
        return "<unprintable>"


def encode_message(msg):
    """One JSON line, UTF-8, no raw newlines (json escapes them)."""
    try:
        text = json.dumps(msg, ensure_ascii=False, default=_default, allow_nan=False)
    except ValueError:
        text = json.dumps(msg, ensure_ascii=False, default=_default)
        text = text.replace("NaN", "null").replace("Infinity", "null")
    return (text + "\n").encode("utf-8")


def decode_line(line):
    """Parse one request line; returns a dict or None for blank/garbage lines."""
    if isinstance(line, bytes):
        line = line.decode("utf-8", "replace")
    line = line.strip()
    if not line:
        return None
    try:
        msg = json.loads(line)
    except ValueError:
        return None
    return msg if isinstance(msg, dict) and isinstance(msg.get("type"), str) else None


class Channel:
    """Writes events to the duplicated original stdout. Thread safe."""

    def __init__(self, out):
        self._out = out
        self._lock = threading.Lock()

    def send(self, msg):
        data = encode_message(msg)
        with self._lock:
            try:
                self._out.write(data)
                self._out.flush()
            except (OSError, ValueError):
                # Host is gone; nothing left to serve.
                os._exit(0)


class OutputBus:
    """Orders every piece of cell output (Python-level and fd-level) into stream events.

    Adjacent writes to the same stream merge; a flusher thread emits at most every
    ``interval`` seconds so a chatty loop does not flood the host, while ``flush_now``
    (end of cell, tqdm's flush) stays ordered with everything before it.
    """

    def __init__(self, channel, get_id, interval=0.02):
        self._channel = channel
        self._get_id = get_id
        self._interval = interval
        self._lock = threading.Lock()
        self._pending = []
        self._wake = threading.Event()
        self._last = 0.0
        t = threading.Thread(target=self._run, name="pager-output-flusher", daemon=True)
        t.start()

    def write(self, name, text):
        if not text:
            return
        with self._lock:
            if self._pending and self._pending[-1][0] == name:
                self._pending[-1][1].append(text)
            else:
                self._pending.append((name, [text]))
            big = sum(len(p) for _, parts in self._pending for p in parts) > 16384
        if big:
            self.flush_now()
        else:
            self._wake.set()

    def request_flush(self):
        self._wake.set()

    def flush_now(self):
        with self._lock:
            pending, self._pending = self._pending, []
        if not pending:
            return
        cid = self._get_id()
        for name, parts in pending:
            self._channel.send({"id": cid, "type": "stream", "name": name, "text": "".join(parts)})
        self._last = time.monotonic()

    def _run(self):
        while True:
            self._wake.wait()
            self._wake.clear()
            delay = self._interval - (time.monotonic() - self._last)
            if delay > 0:
                time.sleep(delay)
            self.flush_now()


class OutStream:
    """Replacement for sys.stdout / sys.stderr."""

    encoding = "utf-8"
    errors = "replace"
    line_buffering = True

    def __init__(self, bus, name, fd):
        self._bus = bus
        self.name = name
        self._fd = fd
        self.closed = False

    def write(self, text):
        if not isinstance(text, str):
            raise TypeError("write() argument must be str, not %s" % type(text).__name__)
        self._bus.write(self.name, text)
        return len(text)

    def writelines(self, lines):
        for line in lines:
            self.write(line)

    def flush(self):
        self._bus.request_flush()

    def isatty(self):
        return False

    def fileno(self):
        return self._fd

    def writable(self):
        return True

    def readable(self):
        return False

    def seekable(self):
        return False

    def close(self):
        pass


class FdDrain:
    """Captures C-level output: fds 1 and 2 point at pipes this class empties into the bus.

    A sentinel written into each pipe lets ``sync`` prove everything written before it
    (by C extensions or child processes) has reached the bus.
    """

    def __init__(self, bus, name, target_fd):
        self._bus = bus
        self.name = name
        self.target_fd = target_fd
        self._read_fd, self.write_fd = os.pipe()
        os.dup2(self.write_fd, target_fd)
        self._synced = threading.Event()
        self._thread = threading.Thread(target=self._run, name="pager-drain-" + name, daemon=True)
        self._thread.start()

    def _run(self):
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        held = ""
        while True:
            try:
                chunk = os.read(self._read_fd, 65536)
            except OSError:
                return
            if not chunk:
                return
            held += decoder.decode(chunk)
            while True:
                at = held.find(SYNC)
                if at < 0:
                    break
                self._bus.write(self.name, held[:at])
                held = held[at + len(SYNC):]
                self._synced.set()
            keep = 0
            for n in range(min(len(SYNC) - 1, len(held)), 0, -1):
                if SYNC.startswith(held[-n:]):
                    keep = n
                    break
            emit = held[: len(held) - keep]
            held = held[len(held) - keep:]
            self._bus.write(self.name, emit)

    def sync(self, timeout=2.0):
        self._synced.clear()
        try:
            os.write(self.write_fd, SYNC.encode("ascii"))
        except OSError:
            return False
        return self._synced.wait(timeout)
