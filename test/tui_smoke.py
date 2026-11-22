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
from urllib.parse import urlsplit

import pexpect
import pyte

profile = Path(os.environ["DSH_HOME"]).resolve()
if not (profile / "profiles/dsh-tui").is_dir():
    raise SystemExit("DSH_HOME must contain a dsh-tui test profile with this plugin installed")
native = shutil.which("agy")



def run(work, test_home, executable, scenario, marker=None):
    env = dict(os.environ, DSH_HOME=str(profile), HOME=str(test_home),
               TERM="xterm-256color", DSH_TUI_LANG="zh", ANTIGRAVITY_EXECUTABLE=str(executable))
    if scenario == "accounts":
        env.update(AGY_FIXTURE_IDENTITIES=str(test_home / "account"), BROWSER="true")
    if scenario == "login":
        # Record desktop dispatches without opening an OAuth page during tests.
        log = test_home / "launches"
        browser = test_home / "record-browser"
        browser.write_text("#!/bin/sh\nprintf '%s\\n' \"$1\" >> " + shlex.quote(str(log)) + "\n")
        browser.chmod(0o700)
        env["BROWSER"] = str(browser)
        clipboard = test_home / "clipboard"
        for tool in ("clip.exe", "pbcopy", "wl-copy"):
            helper = test_home / tool
            helper.write_text("#!/bin/sh\ncat > " + shlex.quote(str(clipboard)) + "\n")
            helper.chmod(0o700)
        env["PATH"] = str(test_home) + os.pathsep + env["PATH"]
    p = pexpect.spawn("dsh-tui", ["--backend", "antigravity"], cwd=str(work), env=env,
                      dimensions=(24, 80) if scenario == "login" else (45, 150), encoding="utf-8", codec_errors="replace")
    screen = pyte.Screen(80, 24) if scenario == "login" else pyte.Screen(150, 45)
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

    def send(text):
        p.send(text)
        time.sleep(0.35)
        p.send("\r")
        time.sleep(0.35)

    def choose(index):
        for _ in range(index):
            p.send("\x1b[B")
            time.sleep(0.12)
        p.send("\r")
        time.sleep(0.25)

    try:
        wait("Antigravity")
        authenticated = scenario in ("usage", "config", "stack", "skill", "timer")
        if authenticated:
            p.send("/usage")
            wait("模型组配额", 45)
            # Reach chat through a read-only command and wait for actual output.
            # The first Enter can hit the launchpad's startup gate on a cold boot.
            deadline = time.monotonic() + 55
            retry = 0
            while time.monotonic() < deadline:
                try:
                    stream.feed(p.read_nonblocking(65536, timeout=0.2))
                except pexpect.TIMEOUT:
                    pass
                visible = "\n".join(screen.display)
                if "/usage refresh 重新查询" in visible:
                    break
                if "⌘ /usage" in visible and time.monotonic() >= retry:
                    p.send("\r")
                    retry = time.monotonic() + 2
            else:
                raise AssertionError("No quota transcript row on startup")
        else:
            time.sleep(3)
        commands = {
            "stack": "/plan /grill-me Design a two-line greeting. Ask me to pick the audience first; after I answer, write an implementation plan for my review. Do not implement or run shell commands.",
            "config": "/agy config", "usage": "/usage", "login": "/login", "accounts": "/login",
            "skill": "/agy parity-word",
            "timer": "/agy schedule Set a native one-shot timer for 10 seconds, then end this turn. "
                     "When it fires, read proof.txt in the current workspace with your file-reading tool. "
                     "Reply with WAKE- immediately followed by the file's contents, with no spaces. "
                     "Do not read the file before the timer fires. Do not use shell commands.",
        }
        if scenario != "usage":
            p.send("\x1b[200~" + commands[scenario] + "\x1b[201~")
            wait(commands[scenario][:12])
            time.sleep(0.35)
            p.send("\r")
        if scenario == "accounts":
            for account in ("A", "B"):
                if account == "B":
                    send("/login")
                wait("复制完整授权链接")
                # Bracketed paste also works when a link action has focus.
                send("\x1b[200~code-" + account + "\x1b[201~")
                wait("已登录。运行 /new" if account == "A" else "原会话")
                send("/new")
                time.sleep(1)
                send("identify")
                wait("CONFIRMED-ACCOUNT-" + account)
        elif scenario == "stack":
            wait("提问", 75)
            choose(0)
            brain = test_home / ".gemini/antigravity-cli/brain"
            deadline = time.monotonic() + 85
            while time.monotonic() < deadline:
                try:
                    stream.feed(p.read_nonblocking(65536, timeout=0.3))
                except pexpect.TIMEOUT:
                    pass
                if any(f.stat().st_size for f in brain.glob("*/*plan*.md")):
                    assert not list(work.iterdir())
                    break
                if "提问" in "\n".join(screen.display):
                    choose(0)
            else:
                raise AssertionError("No native plan artifact after the interview: " + str([p.name for p in brain.glob("*/*.md")]))
        elif scenario == "config":
            wait("编辑全局设置")
            choose(2)
            wait("选择要编辑的字段")
            choose(0)
            wait("继承原生默认值")
            choose(2)
            wait("将此项写入 agy 全局设置")
            choose(1)
            file = test_home / ".gemini/antigravity-cli/settings.json"
            wait("全局设置已保存")
            assert json.loads(file.read_text()) == {"agentMode": "plan"}
        elif scenario in ("skill", "timer"):
            wait(("WAKE-" if scenario == "timer" else "") + marker, 90)
            if scenario == "timer":
                p.send("/agy tasks")
                time.sleep(0.35)
                p.send("\r")
                wait("计时器 · 已完成")
        elif scenario == "login":
            wait("一次性授权码")
            wait("https://accounts.google.com/")
            wait("复制完整授权链接")
            wait("重新打开浏览器")
            first = log.read_text().splitlines()
            assert len(first) == 1 and urlsplit(first[0]).hostname == "accounts.google.com"
            choose(0)
            wait("已复制链接")
            assert clipboard.read_text() == first[0]
            choose(1)
            wait("已再次请求打开浏览器")
            assert log.read_text().splitlines() == [first[0], first[0]]
            p.send("\x1b")
        else:
            wait("/usage refresh 重新查询")
            assert "第 1/1 题" not in "\n".join(screen.display)
            send("/quota")
            wait("缓存 ·")
            send("/usage refresh")
            wait("正在查询 /usage")
        print("PASS: real dsh-TUI " + scenario, flush=True)
    finally:
        p.close(force=True)


args = argparse.ArgumentParser()
args.add_argument("--accounts", action="store_true", help="exercise account switching with two fixture identities")
args.add_argument("--login", action="store_true", help="only check the sign-in screen with an isolated home")
args.add_argument("--workflows", action="store_true", help="exercise an authenticated custom skill and a one-shot timer")
args.add_argument("--stack", action="store_true", help="exercise the native plan interview in a temporary authenticated HOME")
options = args.parse_args()
if not native and not options.accounts:
    raise SystemExit("agy is required")
with tempfile.TemporaryDirectory(prefix="agy-tui-smoke-") as temp:
    root = Path(temp)
    modes = ("usage", "config", "login")
    if options.accounts:
        modes = ("accounts",)
    elif options.login:
        modes = ("login",)
    elif options.stack:
        modes = ("stack",)
    elif options.workflows:
        modes = ("skill", "timer")
    for mode in modes:
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
        executable = native
        if mode not in ("login", "accounts"):
            # Keep generated histories, artifacts, settings and credential refreshes isolated.
            state = home / ".gemini/antigravity-cli"
            state.mkdir(parents=True, mode=0o700)
            shutil.copy2(Path.home() / ".gemini/antigravity-cli/antigravity-oauth-token", state)
        if mode == "accounts":
            executable = Path(__file__).resolve().with_name("agent.mjs")
        run(work, home, executable, mode, marker)
