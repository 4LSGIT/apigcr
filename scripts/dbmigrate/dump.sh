#!/usr/bin/env bash
# scripts/dbmigrate/dump.sh
#
# Consistent dump of the YisraCase MySQL database for import into another
# server (written for the SiteGround → Cloud SQL move; nothing in here is
# SiteGround- or Cloud-SQL-specific).
#
# Produces, in $OUT (default: current directory):
#
#   yc_data.sql.gz    schema + data, NO triggers. One --single-transaction
#                     snapshot, so it is internally consistent even while the
#                     app is live. Import this first (e.g. gcloud sql import).
#
#   yc_triggers.sql   triggers only, DEFINER clauses stripped. Apply this
#                     second, logged in AS THE ACCOUNT THAT SHOULD OWN THE
#                     TRIGGERS: with no DEFINER clause MySQL stamps the creating
#                     user, so the owner is deterministic instead of being
#                     whatever account an import service happens to run as.
#
# WHY TRIGGERS ARE SPLIT OUT
#   The source's trigger DEFINERs are host-specific accounts that do not exist
#   on the target. Importing them verbatim fails at CREATE TRIGGER (or, worse,
#   succeeds and then every write to that table fails at run time with "the
#   user specified as a definer does not exist"). Stripping DEFINER from a file
#   that contains nothing but trigger DDL also means the sed below can never
#   touch table data that merely mentions the word.
#
# USAGE
#   SRC_HOST=… SRC_USER=… SRC_DB=… [SRC_PORT=3306] [OUT=.] scripts/dbmigrate/dump.sh
#
#   The password is read from $SRC_PW, or prompted for (never pass it as an
#   argument). The source account needs SELECT, SHOW VIEW, TRIGGER and
#   LOCK TABLES on the database — the app's read-write account has them.
#
# CLIENT VERSION MATTERS
#   mysqldump must be the same major.minor as the server (8.4): an older or
#   MariaDB mysqldump mis-writes generated columns and functional indexes. The
#   default therefore runs the official mysql:8.4 image via docker. Override
#   for a host that already has matching client tools:
#     MYSQLDUMP="mysqldump" MYSQL="mysql" scripts/dbmigrate/dump.sh
#
# The script checks its own output and exits non-zero if the dump is
# incomplete: a truncated dump that imports "successfully" is the failure this
# guards against. Exit codes: 0 ok, 1 a verification failed, 2 usage/tooling.
#
#   VERIFY_ONLY=1   skip dumping; re-run the checks on the files already in
#                   $OUT against the live source inventory (use after copying
#                   the files somewhere, before importing them).

set -euo pipefail

die()  { echo "dump.sh: $*" >&2; exit 2; }
fail() { echo "dump.sh: VERIFY FAILED — $*" >&2; exit 1; }

: "${SRC_HOST:?set SRC_HOST}" "${SRC_USER:?set SRC_USER}" "${SRC_DB:?set SRC_DB}"
SRC_PORT="${SRC_PORT:-3306}"
OUT="${OUT:-.}"
[ -d "$OUT" ] || die "OUT directory does not exist: $OUT"

if [ -z "${SRC_PW:-}" ]; then
  read -rsp "Password for ${SRC_USER}@${SRC_HOST}: " SRC_PW; echo >&2
fi
[ -n "$SRC_PW" ] || die "empty password"
# MYSQL_PWD keeps the password out of argv / ps; `docker run -e MYSQL_PWD`
# forwards it by NAME, so it is not in the docker command line either.
export MYSQL_PWD="$SRC_PW"

IMAGE="${MYSQL_IMAGE:-mysql:8.4}"
MYSQLDUMP="${MYSQLDUMP:-docker run --rm -e MYSQL_PWD $IMAGE mysqldump}"
MYSQL="${MYSQL:-docker run --rm -e MYSQL_PWD $IMAGE mysql}"

# --get-server-public-key: a caching_sha2_password account can only do its full
# (first, uncached) login over a secure channel OR an RSA key exchange. Over
# plain TCP with no TLS — a server with TLS off, or any connection through the
# Cloud SQL Auth Proxy's local port — the client otherwise fails with
#   ERROR 2061 … Authentication requires secure connection.
# The flag is ignored when the channel is already secure or the account uses
# another plugin, so it is safe to pass always.
conn=(--get-server-public-key -h "$SRC_HOST" -P "$SRC_PORT" -u "$SRC_USER")
sql() { $MYSQL "${conn[@]}" -N -B "$SRC_DB" -e "$1"; }

# Shared by both dumps. --column-statistics=0: never ask the source for
# histogram stats (needs privileges shared hosting does not grant).
# --no-tablespaces: no PROCESS privilege needed. --set-gtid-purged=OFF: no
# GTID bookkeeping in the file (the target assigns its own).
common=(--single-transaction --no-tablespaces --set-gtid-purged=OFF --hex-blob
        --default-character-set=utf8mb4 --max-allowed-packet=512M --column-statistics=0)

DATA="$OUT/yc_data.sql.gz"
TRIG="$OUT/yc_triggers.sql"

# ── source inventory (what the dump must contain) ────────────────────────────
echo "[dump] source: ${SRC_USER}@${SRC_HOST}:${SRC_PORT}/${SRC_DB}" >&2
SRC_VERSION=$(sql "SELECT VERSION()") || die "cannot connect to the source"
N_TABLES=$(sql "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'")
N_VIEWS=$(sql "SELECT COUNT(*) FROM information_schema.views WHERE table_schema = DATABASE()")
N_TRIGGERS=$(sql "SELECT COUNT(*) FROM information_schema.triggers WHERE trigger_schema = DATABASE()")
N_ROUTINES=$(sql "SELECT COUNT(*) FROM information_schema.routines WHERE routine_schema = DATABASE()")
N_EVENTS=$(sql "SELECT COUNT(*) FROM information_schema.events WHERE event_schema = DATABASE()")
echo "[dump] server $SRC_VERSION — tables=$N_TABLES views=$N_VIEWS triggers=$N_TRIGGERS routines=$N_ROUTINES events=$N_EVENTS (as visible to $SRC_USER)" >&2

# information_schema only shows triggers/routines this account may see. A
# count of 0 here does NOT prove there are none — confirm as the account owner.
if [ -n "${EXPECT_TRIGGERS:-}" ] && [ "$N_TRIGGERS" != "$EXPECT_TRIGGERS" ]; then
  fail "source shows $N_TRIGGERS triggers to $SRC_USER, EXPECT_TRIGGERS=$EXPECT_TRIGGERS — this account cannot see them all; dump as an account that can"
fi
if [ "$N_ROUTINES" != "0" ] || [ "$N_EVENTS" != "0" ]; then
  echo "[dump] NOTE: $N_ROUTINES routine(s) / $N_EVENTS event(s) exist and are NOT in these files — export them separately." >&2
fi

t0=$(date +%s); t1=$t0
if [ "${VERIFY_ONLY:-0}" = "1" ]; then
  echo "[dump] VERIFY_ONLY — checking existing files in $OUT" >&2
  [ -f "$DATA" ] && [ -f "$TRIG" ] || die "VERIFY_ONLY needs $DATA and $TRIG"
else
  # ── 1. schema + data, no triggers ──────────────────────────────────────────
  echo "[dump] writing $DATA …" >&2
  $MYSQLDUMP "${conn[@]}" "${common[@]}" --skip-triggers "$SRC_DB" | gzip -1 > "$DATA"
  t1=$(date +%s)

  # ── 2. triggers only, DEFINER stripped ─────────────────────────────────────
  echo "[dump] writing $TRIG …" >&2
  # --add-drop-trigger: each CREATE is preceded by DROP TRIGGER IF EXISTS, so
  # the file can be applied again on its own (after a failed or text-mode
  # apply) without first dropping the triggers by hand.
  $MYSQLDUMP "${conn[@]}" "${common[@]}" --no-data --no-create-info --triggers --add-drop-trigger --skip-routines "$SRC_DB" \
    | sed -E 's/DEFINER=`[^`]+`@`[^`]+`//g' > "$TRIG"
fi

# ── verify ───────────────────────────────────────────────────────────────────
# Every check COUNTS (grep -c reads its whole input) rather than using
# `… | grep -q`: under `set -o pipefail`, grep -q exiting at the first match
# kills the upstream zcat with SIGPIPE, the pipeline reports failure, and a
# check written as `zcat | grep -q X && fail` then passes exactly when X IS
# present. Counting has no early exit, so there is no such inversion.
count() { grep -c -E "$1" || true; }   # grep -c exits 1 on a zero count

gzip -t "$DATA" 2>/dev/null || fail "$DATA is not a valid gzip stream (truncated or corrupt)"

# mysqldump writes this trailer only after the last table; its absence means
# the dump died mid-stream (dropped connection, quota, killed process).
[ "$(zcat "$DATA" | tail -n 5 | count '^-- Dump completed')" = "1" ] \
  || fail "$DATA has no '-- Dump completed' trailer — the dump was cut short"
[ "$(tail -n 5 "$TRIG" | count '^-- Dump completed')" = "1" ] \
  || fail "$TRIG has no '-- Dump completed' trailer — the dump was cut short"

D_TABLES=$(zcat "$DATA" | count '^CREATE TABLE ')
[ "$D_TABLES" = "$N_TABLES" ] || fail "data dump has $D_TABLES CREATE TABLE statements, source has $N_TABLES tables"

D_STRAY=$(zcat "$DATA" | count '^/\*![0-9]+ CREATE\*/.*TRIGGER |^CREATE .*TRIGGER ')
[ "$D_STRAY" = "0" ] || fail "$DATA contains $D_STRAY CREATE TRIGGER statement(s) — it must contain none (--skip-triggers)"

D_TRIGGERS=$(grep -oE 'TRIGGER `[^`]+`' "$TRIG" | sort -u | wc -l | tr -d ' ')
[ "$D_TRIGGERS" = "$N_TRIGGERS" ] || fail "trigger file has $D_TRIGGERS triggers, source shows $N_TRIGGERS"

[ "$(count 'DEFINER=' < "$TRIG")" = "0" ] || fail "$TRIG still contains a DEFINER clause"
[ "$(count '^(INSERT INTO|CREATE TABLE) ' < "$TRIG")" = "0" ] || fail "$TRIG contains table DDL or data — expected triggers only"

echo "[dump] OK" >&2
echo "[dump]   $DATA  $(du -h "$DATA" | cut -f1)  ($D_TABLES tables, dumped in $((t1 - t0))s)" >&2
echo "[dump]   $TRIG  $(du -h "$TRIG" | cut -f1)  ($D_TRIGGERS triggers, DEFINER stripped)" >&2
echo "[dump] sha256:" >&2
sha256sum "$DATA" "$TRIG" >&2
