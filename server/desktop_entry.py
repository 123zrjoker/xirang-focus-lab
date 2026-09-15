from __future__ import annotations

import argparse
import os

import uvicorn


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Xirang local desktop API service")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--log-level", default=os.environ.get("XIRANG_API_LOG_LEVEL", "info"))
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.host not in {"127.0.0.1", "localhost"}:
        raise SystemExit("Desktop API must bind to loopback.")
    if not 1 <= args.port <= 65535:
        raise SystemExit("Desktop API port is outside the valid range.")
    uvicorn.run(
        "server.main:app",
        host="127.0.0.1",
        port=args.port,
        log_level=args.log_level,
        access_log=False,
    )


if __name__ == "__main__":
    main()
