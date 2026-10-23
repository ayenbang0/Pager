"""Tab completion, object inspection and the variable list, over the live namespace (stdlib only)."""

import builtins
import inspect
import keyword
import re
import sys

_TOKEN = re.compile(r"[A-Za-z_][A-Za-z_0-9]*(?:\s*\.\s*[A-Za-z_][A-Za-z_0-9]*)*\s*\.?\s*[A-Za-z_0-9]*$")
_WORD_RIGHT = re.compile(r"[A-Za-z_0-9]*")


def _kind(obj):
    if inspect.ismodule(obj):
        return "module"
    if inspect.isclass(obj):
        return "class"
    if inspect.isbuiltin(obj) or inspect.isroutine(obj):
        return "function"
    return "instance"


def _resolve(ns, chain):
    """Walk ``a.b.c`` through the namespace; None when any step is missing."""
    parts = [p.strip() for p in chain.split(".")]
    if not parts or not parts[0]:
        return None, False
    if parts[0] in ns:
        obj = ns[parts[0]]
    elif hasattr(builtins, parts[0]):
        obj = getattr(builtins, parts[0])
    else:
        return None, False
    for part in parts[1:]:
        try:
            obj = getattr(obj, part)
        except Exception:
            return None, False
    return obj, True


def _signature(obj):
    try:
        return str(inspect.signature(obj))
    except (TypeError, ValueError):
        return ""


_IMPORT_LINE = re.compile(r"^\s*(?:import\s+(?:[\w.]+\s*(?:as\s+\w+\s*)?,\s*)*|from\s+)([A-Za-z_]\w*)?$")
_MODULES = []


def _module_names():
    """Top-level importable names (stdlib, built-in, installed); computed once, never imports anything."""
    if not _MODULES:
        import pkgutil

        stdlib = set(getattr(sys, "stdlib_module_names", ())) | set(sys.builtin_module_names)
        names = set(stdlib)
        try:
            names |= {m.name for m in pkgutil.iter_modules()}
        except Exception:
            pass
        shown = [n for n in names if not n.startswith("_")]
        _MODULES.extend(sorted(shown, key=lambda n: (n not in stdlib, n.lower())))
    return _MODULES


def _complete_import(line, cursor):
    m = _IMPORT_LINE.match(line)
    if not m:
        return None
    prefix = m.group(1) or ""
    out = [{"text": n, "type": "module"} for n in _module_names() if n.startswith(prefix)]
    return out[:200], cursor - len(prefix), cursor


def complete(ns, code, cursor):
    """-> (matches[{text,type,signature?}], start, end) in code offsets."""
    cursor = max(0, min(cursor, len(code)))
    before = code[:cursor]
    line_start = before.rfind("\n") + 1
    line = before[line_start:]
    imported = _complete_import(line, cursor)
    if imported is not None:
        return imported
    m = _TOKEN.search(line)
    if not m:
        return [], cursor, cursor
    token = m.group(0)
    start = line_start + m.start()
    if "." in token:
        base, _, prefix = token.rpartition(".")
        base = re.sub(r"\s+", "", base)
        prefix = prefix.strip()
        obj, ok = _resolve(ns, base)
        if not ok:
            return [], cursor, cursor
        try:
            names = dir(obj)
        except Exception:
            names = []
        show_private = prefix.startswith("_")
        out = []
        for name in sorted(names, key=lambda n: (n.startswith("_"), n.lower())):
            if not name.startswith(prefix) or (name.startswith("_") and not show_private):
                continue
            try:
                attr = inspect.getattr_static(obj, name)
            except AttributeError:
                attr = None
            kind = _kind(attr) if attr is not None else "instance"
            if isinstance(attr, property):
                kind = "instance"
            out.append({"text": name, "type": kind})
        return out, cursor - len(prefix), cursor
    prefix = token
    start = cursor - len(prefix)
    seen, out = set(), []
    for kw in keyword.kwlist:
        if kw.startswith(prefix):
            seen.add(kw)
            out.append({"text": kw, "type": "keyword"})
    for source in (ns, vars(builtins)):
        for name in sorted(source, key=str.lower):
            if name.startswith(prefix) and name not in seen and (not name.startswith("_") or prefix.startswith("_")):
                seen.add(name)
                try:
                    kind = _kind(source[name])
                except Exception:
                    kind = "instance"
                out.append({"text": name, "type": kind})
    return out[:200], start, cursor


def inspect_at(ns, code, cursor, detail=0):
    """-> (found, data) for the dotted name under the cursor."""
    cursor = max(0, min(cursor, len(code)))
    right = _WORD_RIGHT.match(code, cursor)
    end = right.end() if right else cursor
    before = code[:end]
    line = before[before.rfind("\n") + 1:]
    m = re.search(r"[A-Za-z_][A-Za-z_0-9]*(?:\s*\.\s*[A-Za-z_][A-Za-z_0-9]*)*$", line)
    if not m:
        return False, {}
    chain = re.sub(r"\s+", "", m.group(0))
    obj, ok = _resolve(ns, chain)
    if not ok:
        return False, {}
    head = chain
    sig = _signature(obj)
    parts = ["%s%s" % (head, sig) if sig else head, "Type: %s" % type(obj).__name__]
    doc = inspect.getdoc(obj)
    if doc:
        parts.append("")
        parts.append(doc)
    if detail and (inspect.isfunction(obj) or inspect.isclass(obj) or inspect.ismethod(obj)):
        try:
            parts += ["", "Source:", inspect.getsource(obj)]
        except (OSError, TypeError):
            pass
    return True, {"text/plain": "\n".join(parts)}


def variables(ns, hidden):
    """User-visible names with a short type/repr/size line each."""
    out = []
    for name in sorted(ns):
        if name.startswith("_") or name in hidden:
            continue
        value = ns[name]
        if inspect.ismodule(value):
            kind, rep = "module", getattr(value, "__name__", "")
        else:
            kind = type(value).__name__
            try:
                rep = repr(value)
            except Exception:
                rep = "<unprintable>"
        if len(rep) > 120:
            rep = rep[:117] + "..."
        item = {"name": name, "type": kind, "repr": rep.replace("\n", " ")}
        shape = getattr(value, "shape", None)
        if shape is not None:
            try:
                item["size"] = "x".join(str(int(d)) for d in shape)
            except Exception:
                pass
        elif hasattr(value, "__len__") and not inspect.isclass(value):
            try:
                item["size"] = str(len(value))
            except Exception:
                pass
        out.append(item)
    return out
