#!/bin/sh
set -eu
# Real lifecycle, fault-injected Docker boundary. No daemon/DB correctness evidence.
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
mkdir "$scratch/bin"
cat > "$scratch/bin/docker" <<'DOCKER'
#!/bin/sh
case "$1" in
  info) exit 0 ;;
  ps)
    if [ -e "$CASE_ROOT/up-finished" ] && [ "$SCENARIO" = ownership ]; then
      touch "$CASE_ROOT/barrier"
      sleep 2
      exit 42
    fi
    exit 0 ;;
  network|volume) exit 0 ;;
  compose)
    case " $* " in
      *' up '*)
        if [ "$SCENARIO" = up_signal ]; then
          trap 'touch "$CASE_ROOT/up-stopped"; exit 0' TERM
          touch "$CASE_ROOT/barrier"
          while :; do sleep 0.1; done
        fi
        touch "$CASE_ROOT/up-finished"
        exit "${UP_RC:-0}" ;;
      *' down '*)
        printf 'down\n' >> "$CASE_ROOT/down-calls"
        trap 'touch "$CASE_ROOT/down-killed"; exit 46' TERM
        case "$SCENARIO" in
          down_signal|repeat_signal) touch "$CASE_ROOT/barrier"; sleep 2 ;;
        esac
        touch "$CASE_ROOT/down-completed"
        exit "${DOWN_RC:-0}" ;;
    esac ;;
esac
exit 99
DOCKER
chmod +x "$scratch/bin/docker"
failed=0
for spec in 'success 0 0 0' 'up_failure 23 0 1' 'down_failure 0 45 1' 'both_failure 23 45 1' 'up_signal 0 0 143' 'down_signal 0 0 143' 'repeat_signal 0 0 143' 'ownership 0 0 143'; do
  set -- $spec
  scenario=$1 up_rc=$2 down_rc=$3 expected=$4
  case_root="$scratch/$scenario"
  mkdir "$case_root"
  PATH="$scratch/bin:$PATH" CASE_ROOT="$case_root" SCENARIO="$scenario" UP_RC="$up_rc" DOWN_RC="$down_rc" TMPDIR="$case_root" TEST_PROJECT="listing-review-$scenario-$$" sh scripts/compose-lifecycle.sh test 8080 >"$case_root/output" 2>&1 &
  lifecycle=$!
  case "$scenario" in
    *_signal|ownership)
      ticks=0
      while [ ! -e "$case_root/barrier" ] && kill -0 "$lifecycle" 2>/dev/null && [ "$ticks" -lt 100 ]; do sleep 0.1; ticks=$((ticks + 1)); done
      if [ ! -e "$case_root/barrier" ]; then cat "$case_root/output"; echo "FAIL barrier: $scenario"; exit 1; fi
      kill -TERM "$lifecycle"
      if [ "$scenario" = repeat_signal ]; then sleep 0.1; kill -TERM "$lifecycle" 2>/dev/null || :; fi ;;
  esac
  if wait "$lifecycle"; then actual=0; else actual=$?; fi
  ok=1
  [ "$actual" -eq "$expected" ] || ok=0
  if [ "$scenario" = ownership ]; then
    [ ! -e "$case_root/down-calls" ] || ok=0
    grep -q 'Cleanup skipped' "$case_root/output" || ok=0
  else
    [ -e "$case_root/down-completed" ] || ok=0
    [ ! -e "$case_root/down-killed" ] || ok=0
    [ "$(wc -l < "$case_root/down-calls")" -eq 1 ] || ok=0
  fi
  if [ "$down_rc" -ne 0 ]; then grep -q 'cleanup failed' "$case_root/output" || ok=0; fi
  if [ "$down_rc" -eq 0 ] && [ "$scenario" != ownership ]; then
    if grep -q 'cleanup failed' "$case_root/output"; then ok=0; fi
  fi
  if [ "$scenario" = up_signal ]; then [ -e "$case_root/up-stopped" ] || ok=0; fi
  if [ "$ok" -eq 1 ]; then echo "PASS $scenario (exit=$actual)"; else cat "$case_root/output"; echo "FAIL $scenario (exit=$actual expected=$expected)"; failed=1; fi
done
exit "$failed"
