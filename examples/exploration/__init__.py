"""NeuroTheater utilities."""

# @author: @franckPrts

from typing import TYPE_CHECKING, Any

__all__ = ["XdfExplorer"]

if TYPE_CHECKING:
    from .xdf_explorer import XdfExplorer as XdfExplorer


def __getattr__(name: str) -> Any:
    if name == "XdfExplorer":
        from .xdf_explorer import XdfExplorer

        return XdfExplorer
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
