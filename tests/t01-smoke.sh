#!/bin/sh
set -eu

fail() { echo "T01 smoke failed: $*" >&2; exit 1; }
make_pid=
run_pidfile=/tmp/t01-active-run-make.pid
test_pidfile=/tmp/t01-active-test-make.pid
sentinel_container=
run_collision_volume=
test_collision_volume=
collision_network=
cleanup_smoke_child() {
  status=$?
  trap - EXIT INT TERM
  for active_pid in "$(cat "$run_pidfile" 2>/dev/null || echo "$make_pid")" "$(cat "$test_pidfile" 2>/dev/null || :)"; do
    if [ -n "$active_pid" ] && kill -0 "$active_pid" 2>/dev/null; then
      kill -TERM "$active_pid" 2>/dev/null || :
      attempt=0
      while kill -0 "$active_pid" 2>/dev/null && [ "$attempt" -lt 20 ]; do sleep 1; attempt=$((attempt + 1)); done
      if kill -0 "$active_pid" 2>/dev/null; then kill -KILL "$active_pid" 2>/dev/null || :; fi
      wait "$active_pid" 2>/dev/null || :
    fi
  done
  rm -f "$run_pidfile" "$test_pidfile"
  if [ -n "$sentinel_container" ] && [ "$(docker inspect --format '{{index .Config.Labels "com.listing-moderation.mode"}}' "$sentinel_container" 2>/dev/null || :)" = smoke-sentinel ] && [ "$(docker inspect --format '{{index .Config.Labels "com.listing-moderation.workspace"}}' "$sentinel_container" 2>/dev/null || :)" = "$workspace" ]; then docker rm -f "$sentinel_container" >/dev/null || status=1; fi
  if [ -n "$run_collision_volume" ] && [ "$(docker volume inspect --format '{{index .Labels "com.listing-moderation.workspace"}}' "$run_collision_volume" 2>/dev/null || :)" = smoke-fixture ]; then docker volume rm "$run_collision_volume" >/dev/null || status=1; fi
  if [ -n "$test_collision_volume" ] && [ "$(docker volume inspect --format '{{index .Labels "com.listing-moderation.workspace"}}' "$test_collision_volume" 2>/dev/null || :)" = smoke-fixture ]; then docker volume rm "$test_collision_volume" >/dev/null || status=1; fi
  if [ -n "$collision_network" ] && [ "$(docker network inspect --format '{{index .Labels "com.listing-moderation.workspace"}}' "$collision_network" 2>/dev/null || :)" = smoke-fixture ]; then docker network rm "$collision_network" >/dev/null || status=1; fi
  exit "$status"
}
trap cleanup_smoke_child EXIT INT TERM
if MAKEFLAGS= MAKELEVEL=0 MFLAGS= make run PORT=0 >/tmp/t01-invalid-port.log 2>&1; then fail 'invalid PORT was accepted'; fi
grep -q 'PORT must be a decimal integer' /tmp/t01-invalid-port.log || fail 'invalid PORT was not rejected before Docker startup'
sh tests/t01-cleanup-signal-smoke.sh
sh tests/t01-lifecycle-faults.sh
sh tests/docker-context-smoke.sh
sh tests/t01-unlabelled-volume-smoke.sh
sh tests/t01-docker-timeout-smoke.sh

workspace=$(pwd -P)
set -- $(printf '%s' "$workspace" | cksum)
project="listing-$1"
sentinel_container="listing-t01-sentinel-$$"
if docker inspect "$sentinel_container" >/dev/null 2>&1; then fail "sentinel name collision: $sentinel_container"; fi
docker run -d --name "$sentinel_container" --label "com.listing-moderation.workspace=$workspace" --label com.listing-moderation.mode=smoke-sentinel busybox:1.36 sleep 600 >/dev/null
compose_run_start() {
  port=$1
  MAKEFLAGS= MAKELEVEL=0 MFLAGS= make run PORT="$port" >/tmp/t01-make-run.log 2>&1 &
  make_pid=$!
  printf '%s\n' "$make_pid" > "$run_pidfile"
  printf 'compose-start make_pid=%s\n' "$make_pid" >>/tmp/t01-signal-debug.log
  attempt=0
  while [ "$attempt" -lt 180 ]; do
    if curl --fail --silent "http://127.0.0.1:$port/livez" >/tmp/t01-livez.json; then break; fi
    if ! kill -0 "$make_pid" 2>/dev/null; then cat /tmp/t01-make-run.log >&2; fail "make run exited before /livez on $port"; fi
    sleep 1; attempt=$((attempt + 1))
  done
  [ "$attempt" -lt 180 ] || { cat /tmp/t01-make-run.log >&2; fail "API did not become live on $port within 180s"; }
  grep -q '"status":"ok"' /tmp/t01-livez.json || fail 'unexpected /livez response body'
}
stop_make() {
  signal=${1:-TERM}
  make_pid=$(cat "$run_pidfile")
  printf 'make_pid=%s lock_pid=%s\n' "$make_pid" "$(cat "/tmp/listing-moderation-$project.lock/pid" 2>/dev/null || echo missing)" >/tmp/t01-signal-debug.log
  ps -o pid,ppid,comm,args -p "$make_pid" >>/tmp/t01-signal-debug.log 2>&1 || :
  kill -"$signal" "$make_pid" 2>/dev/null || :
  wait "$make_pid" 2>/dev/null || :
  make_pid=
  rm -f "$run_pidfile"
  attempt=0
  count=$(docker ps -aq --filter "label=com.docker.compose.project=$project" | wc -l)
  while { [ "$count" -ne 0 ] || docker network inspect "${project}_default" >/dev/null 2>&1; } && [ "$attempt" -lt 20 ]; do
    sleep 1; attempt=$((attempt + 1)); count=$(docker ps -aq --filter "label=com.docker.compose.project=$project" | wc -l)
  done
  [ "$count" -eq 0 ] || { cat /tmp/t01-signal-debug.log >&2; cat /tmp/t01-make-run.log >&2; fail "run containers remain after Make $signal: $count"; }
  if docker network inspect "${project}_default" >/dev/null 2>&1; then fail 'run network remains after Make TERM'; fi
  docker inspect --format '{{.State.Status}}' "$sentinel_container" | grep -qx running || fail "unrelated sentinel was affected by Make $signal"
}
compose_run_start 8080
api_id=$(docker ps -q --filter "label=com.docker.compose.project=$project" --filter 'label=com.docker.compose.service=api')
mapping=$(docker inspect --format '{{(index (index .NetworkSettings.Ports "8080/tcp") 0).HostPort}}' "$api_id")
[ "$mapping" = '8080' ] || fail "unexpected default port mapping: $mapping"
RUN_INVOCATION_ID=$(docker ps -q --filter "label=com.docker.compose.project=$project" --filter 'label=com.docker.compose.service=db')
[ -n "$RUN_INVOCATION_ID" ] || fail 'run database container missing'
docker exec "$RUN_INVOCATION_ID" psql -U moderator -d listings -c "DROP TABLE IF EXISTS t01_persistence_probe; CREATE TABLE t01_persistence_probe (value text); INSERT INTO t01_persistence_probe VALUES ('preserved');" >/dev/null
stop_make TERM
if [ "${T01_STOP_AFTER_TERM:-0}" = 1 ]; then echo 'T01 TERM smoke passed.'; exit 0; fi

compose_run_start 8081
api_id=$(docker ps -q --filter "label=com.docker.compose.project=$project" --filter 'label=com.docker.compose.service=api')
mapping=$(docker inspect --format '{{(index (index .NetworkSettings.Ports "8080/tcp") 0).HostPort}}' "$api_id")
[ "$mapping" = '8081' ] || fail "unexpected custom port mapping: $mapping"
RUN_INVOCATION_ID=$(docker ps -q --filter "label=com.docker.compose.project=$project" --filter 'label=com.docker.compose.service=db')
docker exec "$RUN_INVOCATION_ID" psql -U moderator -d listings -tAc 'SELECT value FROM t01_persistence_probe' | grep -q preserved || fail 'run DB volume did not preserve its sentinel'

MAKEFLAGS= MAKELEVEL=0 MFLAGS= make test >/tmp/t01-make-test.log 2>&1 &
make_pid=$!
printf '%s\n' "$make_pid" > "$test_pidfile"
if wait "$make_pid"; then test_rc=0; else test_rc=$?; fi
make_pid=
rm -f "$test_pidfile"
[ "$test_rc" -eq 0 ] || { cat /tmp/t01-make-test.log >&2; fail 'make test failed'; }
curl --fail --silent http://127.0.0.1:8081/livez >/dev/null || fail 'test cleanup interrupted the production API'
if docker ps -aq --filter "label=com.listing-moderation.workspace=$workspace" --filter 'label=com.listing-moderation.mode=test' | grep -q .; then fail 'test containers remain after successful make test'; fi
docker inspect --format '{{.State.Status}}' "$sentinel_container" | grep -qx running || fail 'successful make test stopped unrelated sentinel'

concurrent_project="${project}-concurrent-$$"
TEST_PROJECT="$concurrent_project" MAKEFLAGS= MAKELEVEL=0 MFLAGS= make test >/tmp/t01-make-test-concurrent.log 2>&1 &
make_pid=$!
printf '%s\n' "$make_pid" > "$test_pidfile"
attempt=0
while [ ! -d "/tmp/listing-moderation-$concurrent_project.lock" ] && [ "$attempt" -lt 20 ]; do
  if ! kill -0 "$make_pid" 2>/dev/null; then cat /tmp/t01-make-test-concurrent.log >&2; fail 'first shared-project test exited before acquiring its lock'; fi
  sleep 1; attempt=$((attempt + 1))
done
[ -d "/tmp/listing-moderation-$concurrent_project.lock" ] || fail 'first shared-project test did not acquire its lock'
if TEST_PROJECT="$concurrent_project" MAKEFLAGS= MAKELEVEL=0 MFLAGS= make test >/tmp/t01-make-test-concurrent-rejected.log 2>&1; then fail 'concurrent same-project test bypassed lifecycle lock'; fi
grep -q 'Lifecycle lock exists' /tmp/t01-make-test-concurrent-rejected.log || fail 'concurrent same-project refusal lacked lock diagnostic'
if wait "$make_pid"; then test_rc=0; else test_rc=$?; fi
make_pid=
rm -f "$test_pidfile"
[ "$test_rc" -eq 0 ] || { cat /tmp/t01-make-test-concurrent.log >&2; fail 'first shared-project test failed'; }
curl --fail --silent http://127.0.0.1:8081/livez >/dev/null || fail 'same-project test refusal affected production API'

stop_make TERM

run_failure_case() {
  failed_service=$1
  MAKEFLAGS= MAKELEVEL=0 MFLAGS= make run PORT=8080 >/tmp/t01-make-abnormal.log 2>&1 &
  make_pid=$!
  printf '%s\n' "$make_pid" > "$run_pidfile"
  attempt=0
  while [ "$attempt" -lt 180 ]; do
    if curl --fail --silent http://127.0.0.1:8080/livez >/dev/null; then break; fi
    if ! kill -0 "$make_pid" 2>/dev/null; then cat /tmp/t01-make-abnormal.log >&2; fail "run exited before abnormal-$failed_service probe"; fi
    sleep 1; attempt=$((attempt + 1))
  done
  [ "$attempt" -lt 180 ] || fail "run did not start for abnormal-$failed_service probe"
  failed_id=$(docker ps -q --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=$failed_service")
  [ -n "$failed_id" ] || fail "missing $failed_service container"
  if [ "$failed_service" = worker ]; then docker stop "$failed_id" >/dev/null; else docker kill "$failed_id" >/dev/null; fi
  if wait "$make_pid"; then make_pid=; fail "unexpected $failed_service exit was reported as success"; fi
  make_pid=
  rm -f "$run_pidfile"
  count=$(docker ps -aq --filter "label=com.docker.compose.project=$project" | wc -l)
  [ "$count" -eq 0 ] || fail "$failed_service exit left run containers: $count"
  if docker network inspect "${project}_default" >/dev/null 2>&1; then fail "$failed_service exit left run network"; fi
  docker inspect --format '{{.State.Status}}' "$sentinel_container" | grep -qx running || fail "$failed_service exit stopped unrelated sentinel"
}
run_failure_case api
run_failure_case worker

foreign_project="${project}-collision-$$"
collision_network="${foreign_project}_default"
docker network create --label "com.docker.compose.project=$foreign_project" \
  --label com.listing-moderation.workspace=smoke-fixture \
  --label com.listing-moderation.mode=run --label com.listing-moderation.invocation=foreign \
  "$collision_network" >/dev/null
if RUN_PROJECT="$foreign_project" MAKEFLAGS= MAKELEVEL=0 MFLAGS= make run >/tmp/t01-network-collision.log 2>&1; then fail 'run adopted a pre-existing network-only collision'; fi
grep -q 'Refusing pre-existing Compose network resources' /tmp/t01-network-collision.log || fail 'network-only collision lacked an ownership diagnostic'
docker network inspect "$collision_network" >/dev/null || fail 'network-only collision was removed'
docker network rm "$collision_network" >/dev/null
collision_network=

run_collision_volume="${foreign_project}-db-data"
docker volume create --name "$run_collision_volume" \
  --label "com.docker.compose.project=$foreign_project" \
  --label com.listing-moderation.workspace=smoke-fixture \
  --label com.listing-moderation.mode=run --label com.listing-moderation.invocation=foreign >/dev/null
docker run --rm --mount "type=volume,src=$run_collision_volume,dst=/sentinel" busybox:1.36 sh -c 'printf untouched > /sentinel/value'
if RUN_PROJECT="$foreign_project" MAKEFLAGS= MAKELEVEL=0 MFLAGS= make run >/tmp/t01-volume-collision.log 2>&1; then fail 'run adopted a pre-existing volume-only collision'; fi
grep -q 'Refusing unowned run volume' /tmp/t01-volume-collision.log || fail 'volume-only collision lacked an ownership diagnostic'
docker run --rm --mount "type=volume,src=$run_collision_volume,dst=/sentinel,readonly" busybox:1.36 cat /sentinel/value | grep -qx untouched || fail 'volume-only collision data changed'
docker volume rm "$run_collision_volume" >/dev/null
run_collision_volume=

test_collision_volume="${foreign_project}-test-data"
docker volume create --name "$test_collision_volume" \
  --label "com.docker.compose.project=$foreign_project" \
  --label com.listing-moderation.workspace=smoke-fixture \
  --label com.listing-moderation.mode=test --label com.listing-moderation.invocation=foreign >/dev/null
docker run --rm --mount "type=volume,src=$test_collision_volume,dst=/sentinel" busybox:1.36 sh -c 'printf untouched > /sentinel/value'
if TEST_PROJECT="$foreign_project" MAKEFLAGS= MAKELEVEL=0 MFLAGS= make test >/tmp/t01-test-volume-collision.log 2>&1; then fail 'test adopted a pre-existing volume-only collision'; fi
grep -q 'Refusing pre-existing test volume resources' /tmp/t01-test-volume-collision.log || fail 'test volume-only collision lacked an ownership diagnostic'
docker run --rm --mount "type=volume,src=$test_collision_volume,dst=/sentinel,readonly" busybox:1.36 cat /sentinel/value | grep -qx untouched || fail 'test volume-only collision data changed'
docker volume rm "$test_collision_volume" >/dev/null
test_collision_volume=

TEST_FORCE_FAILURE=1 MAKEFLAGS= MAKELEVEL=0 MFLAGS= make test >/tmp/t01-make-test-fail.log 2>&1 &
make_pid=$!
printf '%s\n' "$make_pid" > "$test_pidfile"
if wait "$make_pid"; then test_rc=0; else test_rc=$?; fi
make_pid=
rm -f "$test_pidfile"
[ "$test_rc" -ne 0 ] || fail 'forced test assertion unexpectedly passed'
grep -q 'T01_FORCED_ASSERTION_FAILURE' /tmp/t01-make-test-fail.log || fail 'forced assertion marker did not reach make test output'
if docker ps -aq --filter "label=com.listing-moderation.workspace=$workspace" --filter 'label=com.listing-moderation.mode=test' | grep -q .; then fail 'test containers remain after failing make test'; fi
docker inspect --format '{{.State.Status}}' "$sentinel_container" | grep -qx running || fail 'failing make test stopped unrelated sentinel'
echo 'T01 smoke passed: context exclusion, ports, TERM cleanup, DB persistence, run/test isolation, concurrent-project locking, abnormal service exits, foreign-resource refusal, unrelated resource safety, and forced assertion propagation.'
