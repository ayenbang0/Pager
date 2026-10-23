"""Rich output: mime bundles, display helpers, matplotlib figures, a tiny IPython.display shim."""

import base64
import json
import pprint
import struct
import sys
import types

_REPR_METHODS = (
    ("text/html", "_repr_html_"),
    ("text/markdown", "_repr_markdown_"),
    ("image/svg+xml", "_repr_svg_"),
    ("image/png", "_repr_png_"),
    ("image/jpeg", "_repr_jpeg_"),
    ("text/latex", "_repr_latex_"),
    ("application/json", "_repr_json_"),
)
_BINARY = ("image/png", "image/jpeg")


def _plain(obj):
    try:
        text = repr(obj)
    except Exception as exc:  # a broken __repr__ must not kill the cell
        return "<repr failed: %s: %s>" % (type(exc).__name__, exc)
    if isinstance(obj, (dict, list, tuple, set, frozenset)) and len(text) > 79:
        try:
            return pprint.pformat(obj, width=79, compact=True)
        except Exception:
            return text
    return text


def _png_size(raw):
    if len(raw) >= 24 and raw[:8] == b"\x89PNG\r\n\x1a\n":
        return struct.unpack(">II", raw[16:24])
    return None


def mime_bundle(obj, figure_format="retina"):
    """Return (data, metadata) for one object: always has text/plain."""
    data, meta = {}, {}
    if not isinstance(obj, type):
        figure = _as_figure(obj)
        if figure is not None:
            fdata, fmeta = render_figure(figure, figure_format)
            if fdata:
                data.update(fdata)
                meta.update(fmeta)
        method = getattr(obj, "_repr_mimebundle_", None)
        if callable(method) and not data:
            try:
                got = method(include=None, exclude=None)
            except TypeError:
                try:
                    got = method()
                except Exception:
                    got = None
            except Exception:
                got = None
            if isinstance(got, tuple) and len(got) == 2:
                got, extra = got
                if isinstance(extra, dict):
                    meta.update(extra)
            if isinstance(got, dict):
                for key, value in got.items():
                    data[key] = _encode(key, value)
        if not data:
            for mime, name in _REPR_METHODS:
                method = getattr(obj, name, None)
                if not callable(method):
                    continue
                try:
                    value = method()
                except Exception:
                    continue
                if isinstance(value, tuple) and len(value) == 2:
                    value, extra = value
                    if isinstance(extra, dict):
                        meta[mime] = extra
                if value is None:
                    continue
                data[mime] = _encode(mime, value)
    data.setdefault("text/plain", _plain(obj))
    return data, meta


def _encode(mime, value):
    if mime in _BINARY and isinstance(value, (bytes, bytearray)):
        return base64.b64encode(bytes(value)).decode("ascii")
    if mime == "application/json" and not isinstance(value, str):
        return value
    if isinstance(value, (bytes, bytearray)):
        return bytes(value).decode("utf-8", "replace")
    return value


# ---- matplotlib -------------------------------------------------------------


def _as_figure(obj):
    mod = type(obj).__module__ or ""
    if mod.startswith("matplotlib") and hasattr(obj, "savefig") and hasattr(obj, "canvas"):
        return obj
    return None


def render_figure(fig, figure_format="retina"):
    """PNG (1x or retina 2x with logical size metadata), SVG or JPEG for a Figure."""
    import io

    fmt = (figure_format or "retina").lower()
    kwargs = {"bbox_inches": "tight", "facecolor": fig.get_facecolor(), "edgecolor": fig.get_edgecolor()}
    buf = io.BytesIO()
    try:
        if fmt == "svg":
            fig.savefig(buf, format="svg", **kwargs)
            return {"image/svg+xml": buf.getvalue().decode("utf-8", "replace"), "text/plain": _plain(fig)}, {}
        if fmt in ("jpg", "jpeg"):
            fig.savefig(buf, format="jpeg", **kwargs)
            return {"image/jpeg": base64.b64encode(buf.getvalue()).decode("ascii"), "text/plain": _plain(fig)}, {}
        scale = 2 if fmt == "retina" else 1
        fig.savefig(buf, format="png", dpi=fig.dpi * scale, **kwargs)
    except Exception:
        return {}, {}
    raw = buf.getvalue()
    meta = {}
    size = _png_size(raw)
    if size and scale > 1:
        meta = {"image/png": {"width": size[0] // scale, "height": size[1] // scale}}
    elif size:
        meta = {"image/png": {"width": size[0], "height": size[1]}}
    return {"image/png": base64.b64encode(raw).decode("ascii"), "text/plain": _plain(fig)}, meta


# ---- IPython.display look-alikes ---------------------------------------------


class DisplayObject:
    def __init__(self, data=None, **kwargs):
        self.data = data
        self.metadata = kwargs


class HTML(DisplayObject):
    def _repr_html_(self):
        return self.data


class Markdown(DisplayObject):
    def _repr_markdown_(self):
        return self.data


class Latex(DisplayObject):
    def _repr_latex_(self):
        return self.data


class SVG(DisplayObject):
    def _repr_svg_(self):
        return self.data


class JSON(DisplayObject):
    def _repr_json_(self):
        return self.data if not isinstance(self.data, str) else json.loads(self.data)


class Image(DisplayObject):
    def __init__(self, data=None, filename=None, format=None, width=None, height=None, **kw):
        if data is None and filename:
            with open(filename, "rb") as fh:
                data = fh.read()
        if isinstance(data, str):
            data = data.encode("latin-1", "ignore")
        self.data = data
        self.format = (format or ("jpeg" if data[:3] == b"\xff\xd8\xff" else "png")).lower()
        self.width, self.height = width, height

    def _repr_png_(self):
        return self.data if self.format == "png" else None

    def _repr_jpeg_(self):
        return self.data if self.format in ("jpg", "jpeg") else None

    def _repr_mimebundle_(self, include=None, exclude=None):
        mime = "image/png" if self.format == "png" else "image/jpeg"
        meta = {}
        if self.width:
            meta["width"] = self.width
        if self.height:
            meta["height"] = self.height
        return {mime: base64.b64encode(self.data).decode("ascii")}, ({mime: meta} if meta else {})


class _Events:
    """IPython's ``events`` registry: libraries (matplotlib among them) register callbacks; this kernel keeps them but never needs to fire them."""

    def __init__(self):
        self._callbacks = {}

    def register(self, name, func):
        self._callbacks.setdefault(name, []).append(func)

    def unregister(self, name, func):
        try:
            self._callbacks.get(name, []).remove(func)
        except ValueError:
            pass

    def trigger(self, name, *args, **kwargs):
        for func in list(self._callbacks.get(name, [])):
            try:
                func(*args, **kwargs)
            except Exception:
                pass


class ShimShell:
    """What ``get_ipython()`` returns: enough for libraries that probe it."""

    config = {}

    def __init__(self, kernel):
        self._kernel = kernel
        self.events = _Events()

    @property
    def user_ns(self):
        return self._kernel.ns

    def run_line_magic(self, name, line=""):
        return self._kernel.line_magic(name, line)

    def run_cell_magic(self, name, line, cell):
        return self._kernel.cell_magic(name, line, cell)

    def magic(self, text):
        text = text.lstrip("%")
        name, _, rest = text.partition(" ")
        return self._kernel.line_magic(name, rest)

    def enable_gui(self, gui=None):
        return None

    def system(self, cmd):
        return self._kernel.shell(cmd)

    def __bool__(self):
        return True


def install_ipython_shim(kernel):
    """Make ``from IPython.display import display, HTML`` work without IPython.

    A real IPython, when installed, keeps its classes (they are plain repr objects) but
    its ``display``/``clear_output`` are pointed at this kernel.
    """
    import importlib.util

    members = {
        "display": kernel.display,
        "clear_output": kernel.clear_output,
        "HTML": HTML,
        "Markdown": Markdown,
        "Latex": Latex,
        "SVG": SVG,
        "JSON": JSON,
        "Image": Image,
        "DisplayHandle": kernel.DisplayHandle,
    }
    get_ipython = lambda: kernel.shell_shim  # noqa: E731
    try:
        real = importlib.util.find_spec("IPython") is not None
    except (ImportError, ValueError):
        real = False
    if not real:
        pkg = types.ModuleType("IPython")
        pkg.__path__ = []
        pkg.get_ipython = get_ipython
        pkg.version_info = (8, 30, 0, "")
        pkg.__version__ = "8.30.0"
        disp = types.ModuleType("IPython.display")
        for key, value in members.items():
            setattr(disp, key, value)
        sys.modules["IPython"] = pkg
        sys.modules["IPython.display"] = disp
        # Like the real package: `IPython.display` is a module; `from IPython.display import display` is the function.
        pkg.display = disp
        return
    try:
        import IPython  # noqa: F401
        import IPython.display as disp

        for key in ("display", "clear_output"):
            setattr(disp, key, members[key])
        try:
            import IPython.core.display_functions as fn

            fn.display = members["display"]
            fn.clear_output = members["clear_output"]
        except Exception:
            pass
        IPython.get_ipython = get_ipython
    except Exception:
        pass
