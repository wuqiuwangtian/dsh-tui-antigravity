"""Opt-in real dsh-TUI smoke test. Set DSH_HOME to an installed test profile."""
import argparse
import json
import secrets
import os
from pathlib import Path
import shlex
import shutil
import tempfile
import time

import pexpect
import pyte

profile = Path(os.environ["DSH_HOME"]).resolve()
if not (profile / "profiles/dsh-tui").is_dir():
    raise SystemExit("DSH_HOME must contain a dsh-tui test profile with this plugin installed")
native = shutil.which("agy")
if not native:
    raise SystemExit("agy is required")


def run(work, test_home, executable, scenario, marker=None):
    env = dict(os.environ, DSH_HOME=str(profile), HOME=str(test_home),
               TERM="xterm-256color", ANTIGRAVITY_EXECUTABLE=str(executable))
    p = pexpect.spawn("dsh-tui", ["--backend", "antigravity"], cwd=str(work), env=env,
                      dimensions=(45, 150), encoding="utf-8", codec_errors="replace")
    screen = pyte.Screen(150, 45)
    stream = pyte.Stream(screen)

    def wait(label, seconds=35):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            try:
                stream.feed(p.read_nonblocking(65536, timeout=0.2))
            except pexpect.TIMEOUT:
                pass
            if label in "\n".join(screen.display):
                return
        raise AssertionError("Missing UI label: " + label)

    def choose(index):
        for _ in range(index):
            p.send("\x1b[B")
            time.sleep(0.12)
        p.send("\r")
        time.sleep(0.25)

    try:
        wait("Antigravity")
        time.sleep(3)
        commands = {
            "config": "/agy config", "usage": "/usage", "login": "/login",
            "skill": "/agy parity-word",
            "timer": "/agy schedule Set a native one-shot timer for 10 seconds, then end this turn. "
                     "When it fires, read proof.txt in the current workspace with your file-reading tool. "
                     "Reply with WAKE- immediately followed by the file's contents, with no spaces. "
                     "Do not read the file before the timer fires. Do not use shell commands.",
        }
        p.send(commands[scenario])
        time.sleep(0.35)
        p.send("\r")
        if scenario == "config":
            wait("编辑全局设置")
            choose(2)
            wait("选择要编辑的字段")
            choose(0)
            wait("继承原生默认值")
            choose(2)
            wait("将此项写入 agy 全局设置")
            choose(1)
            file = test_home / ".gemini/antigravity-cli/settings.json"
            end = time.monotonic() + 5
            while time.monotonic() < end and not file.exists():
                time.sleep(0.1)
            assert json.loads(file.read_text()) == {"agentMode": "plan"}
        elif scenario in ("skill", "timer"):
            wait(("WAKE-" if scenario == "timer" else "") + marker, 90)
            if scenario == "timer":
                p.send("/agy tasks")
                time.sleep(0.35)
                p.send("\r")
                wait("计时器 · 已完成")
        else:
            wait("一次性授权码" if scenario == "login" else "剩余")
            p.send("\x1b")
        print("PASS: real dsh-TUI " + scenario, flush=True)
    finally:
        p.close(force=True)


args = argparse.ArgumentParser()
args.add_argument("--workflows", action="store_true", help="exercise an authenticated custom skill and a one-shot timer")
workflows = args.parse_args().workflows
with tempfile.TemporaryDirectory(prefix="agy-tui-smoke-") as temp:
    root = Path(temp)
    # Only the agy process uses the current login for read-only quota/config.
    # The TUI and its settings writer use test_home in all three scenarios.
    wrapper = root / "authenticated-agy"
    wrapper.write_text("#!/bin/sh\nexport HOME=" + shlex.quote(str(Path.home())) +
                       "\nexec " + shlex.quote(native) + ' "$@"\n')
    wrapper.chmod(0o700)
    for mode in (("skill", "timer") if workflows else ("usage", "config", "login")):
        home = root / mode
        home.mkdir()
        work = root / ("work-" + mode)
        work.mkdir()
        marker = secrets.token_hex(8)
        if mode == "skill":
            skill = work / ".agents/skills/parity-word"
            skill.mkdir(parents=True)
            (skill / "SKILL.md").write_text("---\nname: parity-word\ndescription: Return the test phrase.\n---\n"
                                           "When invoked, reply exactly " + marker + ".")
        if mode == "timer":
            (work / "proof.txt").write_text(marker)
        run(work, home, native if mode == "login" else wrapper, mode, marker)
