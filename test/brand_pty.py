"""Check actual launchpad layouts without terminal image protocols or credentials."""
import os
from pathlib import Path
import sys
import tempfile
import time

import pexpect
import pyte

for columns, rows in [(80, 24), (144, 52)]:
    with tempfile.TemporaryDirectory() as home:
        env = dict(os.environ, HOME=home, TERM="xterm-256color", DSH_TUI_LANG="en",
                   DSH_TUI_BRAND="auto", DSH_TUI_IMAGE_PROTOCOL="none", DSH_TUI_SPLASH_FONT="bold",
                   ANTIGRAVITY_EXECUTABLE=str(Path(sys.argv[1]).resolve()))
        screen = pyte.Screen(columns, rows)
        stream = pyte.Stream(screen)
        child = pexpect.spawn("dsh-tui", ["--backend", "antigravity"], env=env, cwd=home,
                              dimensions=(rows, columns), encoding="utf8", codec_errors="replace")
        try:
            deadline = time.monotonic() + 40
            while time.monotonic() < deadline:
                try:
                    stream.feed(child.read_nonblocking(65536, timeout=0.25))
                except pexpect.TIMEOUT:
                    pass
                text = "\n".join(screen.display)
                title = "Antigravity Harness" in text if rows == 24 else text.count("▀") > 80
                if title and "Antigravity" in text and "Say something" in text:
                    break
            else:
                raise AssertionError(f"Missing launchpad at {columns}×{rows}\n{text}")
        finally:
            child.close(force=True)
        print(f"PASS {columns}×{rows}")
