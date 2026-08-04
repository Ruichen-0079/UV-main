"""python -m yuvi_mem0"""

from __future__ import annotations

import uvicorn

from yuvi_mem0.config import get_settings


def main() -> None:
    settings = get_settings()
    uvicorn.run(
        "yuvi_mem0.app:app",
        host=settings.mem0_sidecar_host,
        port=settings.mem0_sidecar_port,
        reload=False,
    )


if __name__ == "__main__":
    main()
