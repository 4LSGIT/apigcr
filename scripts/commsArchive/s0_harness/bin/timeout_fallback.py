#!/usr/bin/env python3
# Harness-only stand-in for coreutils `timeout --foreground SECS CMD...` (macOS has none;
# Cloud Shell has the real one). Mirrors coreutils where it matters to the script:
#  - expiry: TERM the command, exit 124;
#  - a signal (Ctrl-C) reaches timeout: pass it to the command and wait;
#  - the command died BY a signal: timeout re-raises that signal on itself, so the calling
#    bash sees a signal death and runs its INT trap (an exit status of 130 would not do that:
#    bash would treat the Ctrl-C as handled by the child and carry on).
import os, signal, subprocess, sys
a = sys.argv[1:]
while a and a[0].startswith('--'): a = a[1:]
secs = float(a[0].rstrip('s')); cmd = a[1:]
p = subprocess.Popen(cmd)
def fwd(sig, _frame):
    try: p.send_signal(sig)
    except ProcessLookupError: pass
for sg in (signal.SIGINT, signal.SIGHUP, signal.SIGTERM, signal.SIGQUIT):
    signal.signal(sg, fwd)
try:
    rc = p.wait(timeout=secs)
except subprocess.TimeoutExpired:
    p.terminate()
    try: p.wait(5)
    except subprocess.TimeoutExpired: p.kill(); p.wait()
    sys.exit(124)
if rc < 0:
    signal.signal(-rc, signal.SIG_DFL)
    os.kill(os.getpid(), -rc)
sys.exit(rc)
