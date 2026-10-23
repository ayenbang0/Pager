"""pager_kernel: a Jupyter-style execution kernel on a plain Python, stdlib only.

It speaks newline-delimited JSON over the process's original stdin/stdout
(see ``protocol.py``). No IPython, no ipykernel, no ZeroMQ, no sockets.
"""

PROTOCOL_VERSION = 1
__version__ = "1.0.0"
