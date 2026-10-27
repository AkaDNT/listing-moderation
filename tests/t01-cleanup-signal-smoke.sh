#!/bin/sh
set -eu
# Fault injection: tests signal-handler control flow, not real Docker cleanup.
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT INT TERM
mkdir "$scratch/bin"
cat > "$scratch/bin/docker" <<'WRAPPER'
#!/bin/sh
case "$1" in
  info|ps|network|volume) exit 0 ;;
  compose)
    case " $* " in
      *' down '*) touch "$CLEANUP_BARRIER"; sleep 2; touch "$CLEANUP_COMPLETE"; exit 0 ;;
      *' up '*) exit 0 ;;
    esac ;;
esac
exit 99
WRAPPER
chmod +x "$scratch/bin/docker"
PATH="$scratch/bin:$PATH" CLEANUP_BARRIER="$scratch/started" CLEANUP_COMPLETE="$scratch/completed" TEST_PROJECT="listing-t01-cleanup-signal-$$" sh scripts/compose-lifecycle.sh test 8080 >"$scratch/output" 2>&1 &
lifecycle_pid=$!
ticks=0
while [ ! -e "$scratch/started" ] && [ "$ticks" -lt 100 ]; do sleep 0.1; ticks=$((ticks + 1)); done
[ -e "$scratch/started" ] || { cat "$scratch/output" >&2; exit 1; }
kill -TERM "$lifecycle_pid"
if wait "$lifecycle_pid"; then result=0; else result=$?; fi
if [ "$result" -ne 143 ] || [ ! -e "$scratch/completed" ] || grep -Eq 'cleanup failed|cleanup exceeded|Cleanup skipped' "$scratch/output"; then
  cat "$scratch/output" >&2
  echo "FAIL: TERM during cleanup aborted cleanup (exit=$result)" >&2
  exit 1
fi
echo 'TERM during cleanup waits for cleanup completion (fault-injected Docker; control-flow evidence only).'
