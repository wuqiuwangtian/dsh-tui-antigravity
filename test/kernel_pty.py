"""Opt-in WSL regression using an isolated DSH_HOME, installed Codex and a mock agy."""

import os
import tempfile
import time
from pathlib import Path

import pexpect
import pyte

profile = Path(os.environ["DSH_HOME"]).resolve()
fixture = Path(__file__).with_name("agent.mjs").resolve()
with tempfile.TemporaryDirectory() as home:
    env = dict(
        os.environ,
        HOME=home,
        DSH_HOME=str(profile),
        TERM="xterm-256color",
        DSH_TUI_LANG="en",
        ANTIGRAVITY_EXECUTABLE=str(fixture),
        DSH_TUI_IMAGE_PROTOCOL="none",
    )
    for key in [
        "CODEX_HOME",
        "AGENTS_HOME",
        "XDG_CONFIG_HOME",
        "XDG_STATE_HOME",
        "XDG_DATA_HOME",
        "XDG_CACHE_HOME",
    ]:
        env.pop(key, None)
    ch = pexpect.spawn(
        "dsh-tui",
        ["--backend", "codex"],
        cwd=home,
        env=env,
        dimensions=(40, 130),
        encoding="utf8",
        codec_errors="replace",
    )
    screen = pyte.Screen(130, 40)
    stream = pyte.Stream(screen)

    def wait(label, timeout=25):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            try:
                stream.feed(ch.read_nonblocking(65536, timeout=0.15))
            except pexpect.TIMEOUT:
                pass
            if label in "\n".join(screen.display):
                return
        raise RuntimeError(label + "\n" + "\n".join(screen.display))

    def send(s):
        ch.send(s)
        time.sleep(0.3)

    try:
        wait("Say something")
        send("/ant")
        wait("Switch to the Antigravity kernel")
        send("\t")
        wait("/antigravity")
        send("\r")
        wait("Kernel · Antigravity")
        print("PASS installed Codex launchpad completion and switch", flush=True)
        send("/codex")
        wait("Switch to the Codex kernel")
        send("\r")
        wait("Kernel · Codex")
        print("PASS reverse switch", flush=True)
        send("/Antigravity")
        send("\r")
        wait("Kernel · Antigravity")
        print("PASS mixed-case forward switch", flush=True)
        send("/resume")
        send("\r")
        wait("fixture")
        send("\x1b[C")
        send("\x1b[B")
        send("\x04")
        wait("/resume, select")
        print("PASS native delete guide", flush=True)
        assert "Delete session" not in "\n".join(screen.display)
    finally:
        ch.close(force=True)
