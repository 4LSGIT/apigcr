/* Harness-only stand-in for coreutils `timeout --foreground SECS CMD...` (macOS has none).
   The parts of coreutils 9.5 src/timeout.c the script depends on: run CMD in timeout's own
   process group (--foreground); pass INT/HUP/TERM on to it; on expiry send TERM and exit 124;
   if CMD died BY a signal, re-raise that signal on itself so the calling shell sees the same.
   Build: cc -O2 -o timeout timeout.c   (lib.sh builds it on first use) */
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>
static pid_t child; static volatile sig_atomic_t timed_out;
static void on_sig(int sig) { if (sig == SIGALRM) { timed_out = 1; sig = SIGTERM; } if (child > 0) kill(child, sig); }
int main(int argc, char **argv) {
  int i = 1; while (i < argc && strncmp(argv[i], "--", 2) == 0) i++;
  if (argc - i < 2) { fprintf(stderr, "usage: timeout [--foreground] SECS CMD...\n"); return 125; }
  unsigned secs = (unsigned)atof(argv[i]);
  struct sigaction sa; memset(&sa, 0, sizeof sa); sa.sa_handler = on_sig; sigemptyset(&sa.sa_mask);
  int sigs[] = {SIGALRM, SIGINT, SIGHUP, SIGTERM, SIGQUIT};
  sigset_t block, orig; sigemptyset(&block);
  for (int k = 0; k < 5; k++) { sigaction(sigs[k], &sa, NULL); sigaddset(&block, sigs[k]); }
  sigprocmask(SIG_BLOCK, &block, &orig);          /* no handler runs before the child exists */
  child = fork();
  if (child == 0) {
    signal(SIGINT, SIG_DFL); signal(SIGHUP, SIG_DFL); signal(SIGTERM, SIG_DFL); signal(SIGQUIT, SIG_DFL); signal(SIGALRM, SIG_DFL);
    sigprocmask(SIG_SETMASK, &orig, NULL);
    execvp(argv[i + 1], &argv[i + 1]); perror(argv[i + 1]); _exit(127);
  }
  if (child < 0) { perror("fork"); return 125; }
  alarm(secs);
  sigprocmask(SIG_SETMASK, &orig, NULL);
  int st; while (waitpid(child, &st, 0) < 0) { /* EINTR: a signal was passed on; keep waiting */ }
  if (timed_out) return 124;
  if (WIFSIGNALED(st)) { int sig = WTERMSIG(st); signal(sig, SIG_DFL); kill(getpid(), sig); }
  return WIFEXITED(st) ? WEXITSTATUS(st) : 125;
}
