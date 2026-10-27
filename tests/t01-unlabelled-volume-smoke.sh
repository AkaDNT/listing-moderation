#!/bin/sh
set -eu

# Real Docker inventory; Compose mutations are intercepted so RED cannot adopt
# the deliberately foreign volume. This proves preflight ordering only.
scratch=$(mktemp -d)
fixture_project="listing-t01-unlabelled-$$"
fixture_volume="$fixture_project-test-data"
fixture_token="t01-$$"
real_docker=$(command -v docker)
cleanup_fixture() {
  result=$?
  trap - EXIT INT TERM
  if [ "$("$real_docker" volume inspect --format '{{index .Labels "com.listing-moderation.test-fixture"}}' "$fixture_volume" 2>/dev/null || :)" = "$fixture_token" ]; then
    "$real_docker" volume rm "$fixture_volume" >/dev/null || result=1
  fi
  rm -rf "$scratch"
  exit "$result"
}
trap cleanup_fixture EXIT INT TERM
if "$real_docker" volume inspect "$fixture_volume" >/dev/null 2>&1; then echo 'fixture name collision' >&2; exit 1; fi
"$real_docker" volume create --label "com.listing-moderation.test-fixture=$fixture_token" "$fixture_volume" >/dev/null
mkdir "$scratch/bin"
cat > "$scratch/bin/docker" <<'WRAPPER'
#!/bin/sh
if [ "$1" = compose ]; then
  printf '%s\n' "$*" >> "$COMPOSE_MUTATION_LOG"
  exit 77
fi
exec "$REAL_DOCKER" "$@"
WRAPPER
chmod +x "$scratch/bin/docker"
if PATH="$scratch/bin:$PATH" REAL_DOCKER="$real_docker" COMPOSE_MUTATION_LOG="$scratch/compose-called" TEST_PROJECT="$fixture_project" sh scripts/compose-lifecycle.sh test 8080 >"$scratch/output" 2>&1; then
  echo 'preflight accepted a foreign test volume' >&2; exit 1
fi
if [ -e "$scratch/compose-called" ]; then
  cat "$scratch/output" >&2
  echo 'FAIL: reached Compose before rejecting the unlabelled exact-name volume collision' >&2
  exit 1
fi
grep -q 'Refusing volume name collision' "$scratch/output"
"$real_docker" volume inspect "$fixture_volume" >/dev/null
echo 'Unlabelled exact-name volume preflight passed (real inventory; Compose mutations intercepted).'
