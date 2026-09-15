from __future__ import annotations

import atexit
import os
import tempfile
from pathlib import Path


_agent_test_directory = tempfile.TemporaryDirectory(prefix="xirang-agent-tests-")
atexit.register(_agent_test_directory.cleanup)
os.environ.setdefault(
    "XIRANG_DATA_DIR",
    str(Path(_agent_test_directory.name) / "runtime"),
)
os.environ.setdefault(
    "XIRANG_AGENT_CHECKPOINT_PATH",
    str(Path(_agent_test_directory.name) / "checkpoints.sqlite3"),
)
