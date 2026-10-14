#!/usr/bin/env python3
"""Run a command on a real pseudo-terminal, as typed in Cloud Shell, and optionally
interrupt it: when TRIGGER (a regex) shows up in its output, send Ctrl-C (mode int)
or drop the terminal (mode hup). Default signal handling is restored in the child, so
a harness started in the background still tests real Ctrl-C.
Usage: ptyrun.py OUTFILE MODE TRIGGER TIMEOUT -- cmd args...     (MODE: none|int|hup)
Exit status: the command's, or 124 if it outlived TIMEOUT."""
import os, pty, re, select, signal, sys, time
out, mode, trig, tmo = sys.argv[1], sys.argv[2], sys.argv[3], float(sys.argv[4])
cmd = sys.argv[sys.argv.index('--') + 1:]
pid, fd = pty.fork()
if pid == 0:
    for sg in (signal.SIGINT, signal.SIGHUP, signal.SIGTERM, signal.SIGQUIT, signal.SIGPIPE):
        signal.signal(sg, signal.SIG_DFL)
    os.execvp(cmd[0], cmd)
buf = b''; fired = False; t0 = time.time(); closed = False
while True:
    if time.time() - t0 > tmo:
        os.kill(pid, signal.SIGKILL); os.waitpid(pid, 0); open(out, 'wb').write(buf); sys.exit(124)
    if not closed:
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try: d = os.read(fd, 65536)
            except OSError: d = b''
            if not d: closed = True
            buf += d
    else:
        time.sleep(0.2)
    if mode != 'none' and not fired and re.search(trig.encode(), buf):
        fired = True; time.sleep(0.5)
        if mode == 'int': os.write(fd, b'\x03')
        else: os.close(fd); closed = True
    w, st = os.waitpid(pid, os.WNOHANG)
    if w:
        if not closed:
            try:
                while True:
                    r, _, _ = select.select([fd], [], [], 0.2)
                    if not r: break
                    d = os.read(fd, 65536)
                    if not d: break
                    buf += d
            except OSError: pass
        open(out, 'wb').write(buf.replace(b'\r\n', b'\n'))
        sys.exit(os.waitstatus_to_exitcode(st) if os.WIFEXITED(st) else 128 + os.WTERMSIG(st))
