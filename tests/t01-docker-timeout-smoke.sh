#!/bin/sh
set -eu
# Fault injection: proves finite shell failure when Docker info hangs; it does
# not prove that an unavailable real daemon completed resource cleanup.
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT INT TERM
mkdir "$scratch/bin"
cat > "$scratch/bin/docker" <<'WRAPPER'
#!/bin/sh
if [ "$1" = info ]; then exec sleep 60; fi
echo "unexpected Docker call: $*" >&2
exit 99
WRAPPER
chmod +x "$scratch/bin/docker"
started=$(date +%s)
if timeout --kill-after=2s 15s env PATH="$scratch/bin:$PATH" TEST_PROJECT="listing-t01-timeout-$$" sh scripts/compose-lifecycle.sh test 8080 >"$scratch/output" 2>&1; then result=0; else result=$?; fi
elapsed=$(($(date +%s) - started))
if [ "$result" -ne 1 ] || [ "$elapsed" -gt 14 ]; then
  cat "$scratch/output" >&2
  echo "FAIL: hanging Docker info must fail within 14s, got exit=$result elapsed=${elapsed}s" >&2
  exit 1
fi
grep -q 'Docker daemon is unavailable' "$scratch/output"
echo "Docker query deadline passed in ${elapsed}s (fault injection; shell failure evidence only)."
