"""python -m yuvi_mem0"""

from __future__ import annotations

import multiprocessing

from yuvi_mem0.runtime_paths import prepare_runtime_environment


def main() -> None:
    multiprocessing.freeze_support()
    prepare_runtime_environment()

    # Keep application imports after path/environment preparation.  Importing
    # the app also imports config, logging, and Mem0-related modules.
    import uvicorn

    from yuvi_mem0.app import app
    from yuvi_mem0.config import get_settings

    settings = get_settings()
    uvicorn.run(
        app,
        host=settings.mem0_sidecar_host,
        port=settings.mem0_sidecar_port,
        reload=False,
    )


if __name__ == "__main__":
    main()
