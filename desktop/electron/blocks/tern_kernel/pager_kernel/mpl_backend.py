"""Inline matplotlib backend: Agg drawing; ``plt.show()`` and the end of every cell emit open figures as displays."""

from matplotlib.backend_bases import FigureManagerBase, _Backend
from matplotlib.backends.backend_agg import FigureCanvasAgg


def _flush():
    from .kernel import active_kernel

    kernel = active_kernel()
    if kernel is not None:
        kernel.flush_figures(close=True)


class FigureManagerPager(FigureManagerBase):
    def show(self):
        _flush()


@_Backend.export
class _BackendPager(_Backend):
    FigureCanvas = FigureCanvasAgg
    FigureManager = FigureManagerPager

    @staticmethod
    def show(*args, **kwargs):
        _flush()

    @staticmethod
    def draw_if_interactive():
        pass
