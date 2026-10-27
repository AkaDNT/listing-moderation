#!/bin/sh
set -u

MODE=${1:-}
RAW_PORT=${2:-8080}
case "$MODE" in run|test) ;; *) echo "usage: $0 run|test [PORT]" >&2; exit 2 ;; esac
case "$RAW_PORT" in ''|*[!0-9]*) echo "PORT must be a decimal integer from 1 through 65535" >&2; exit 2 ;; esac
PORT=$(awk -v value="$RAW_PORT" 'BEGIN { n=value+0; if (n < 1 || n > 65535 || int(n) != n) exit 1; printf "%.0f", n }') || {
  echo "PORT must be a decimal integer from 1 through 65535" >&2; exit 2;
}
if [ "$MODE" = test ]; then PORT=8080; fi
case "$(timeout --version 2>/dev/null)" in
  *'GNU coreutils'*) ;;
  *) echo 'GNU timeout (coreutils) is required for bounded Docker operations.' >&2; exit 2 ;;
esac

docker_query() {
  timeout --foreground --signal=TERM --kill-after=2s 10s docker "$@"
}

WORKSPACE=$(pwd -P) || exit 2
set -- $(printf '%s' "$WORKSPACE" | cksum)
WORKSPACE_HASH=$1
INVOCATION="$$-$(date +%s)"
case "$MODE" in
  run) PROJECT=${RUN_PROJECT:-"listing-$WORKSPACE_HASH"} ;;
  test) PROJECT=${TEST_PROJECT:-"listing-$WORKSPACE_HASH-test-$INVOCATION"} ;;
esac
case "$PROJECT" in ''|[!a-z0-9]*|*[!a-z0-9_-]*) echo "Invalid Compose project name: $PROJECT" >&2; exit 2 ;; esac
if [ "${#PROJECT}" -gt 55 ]; then echo "Compose project name is too long: $PROJECT" >&2; exit 2; fi

LOCK="${TMPDIR:-/tmp}/listing-moderation-$PROJECT.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "Lifecycle lock exists at $LOCK; refusing to reuse a possibly active or stale project." >&2
  exit 2
fi
printf '%s\n' "$$" > "$LOCK/pid"
LOCK_OWNED=1
COMPOSE_FILE=compose.yaml
if [ "$MODE" = test ]; then COMPOSE_FILE=compose.test.yaml; fi
export COMPOSE_PROJECT_NAME="$PROJECT" LM_WORKSPACE="$WORKSPACE" LM_MODE="$MODE" LM_INVOCATION="$INVOCATION" PORT

PHASE=preflight
UP_PID=
DOWN_PID=
UP_STARTED=0
REQUESTED_SIGNAL=
SIGNAL_COUNT=0
CLEANUP_STATE=not_started
CLEANUP_RC=0
FAILED=0
label_value() {
  kind=$1 id=$2 key=$3
  case "$kind" in
    container) docker_query inspect --format "{{ index .Config.Labels \"$key\" }}" "$id" 2>/dev/null ;;
    network|volume) docker_query "$kind" inspect --format "{{ index .Labels \"$key\" }}" "$id" 2>/dev/null ;;
  esac
}
ids_for() {
  kind=$1
  case "$kind" in
    container) docker_query ps -aq --filter "label=com.docker.compose.project=$PROJECT" ;;
    network) docker_query network ls -q --filter "label=com.docker.compose.project=$PROJECT" ;;
    volume) docker_query volume ls -q --filter "label=com.docker.compose.project=$PROJECT" ;;
  esac
}
owned() {
  kind=$1 id=$2
  [ "$(label_value "$kind" "$id" com.listing-moderation.workspace)" = "$WORKSPACE" ] &&
    [ "$(label_value "$kind" "$id" com.listing-moderation.mode)" = "$MODE" ] &&
    [ "$(label_value "$kind" "$id" com.listing-moderation.invocation)" = "$INVOCATION" ]
}
report_ids() {
  kind=$1
  values=$(ids_for "$kind") || return 1
  for id in $values; do printf '%s %s\n' "$kind" "$id" >&2; done
  [ -z "$values" ]
}
preflight() {
  if ! docker_query info >/dev/null 2>&1; then echo "Docker daemon is unavailable or its query timed out." >&2; return 1; fi
  for kind in container network; do
    existing=$(ids_for "$kind") || return 1
    if [ -n "$existing" ]; then
      echo "Refusing pre-existing Compose $kind resources for $PROJECT:" >&2
      for id in $existing; do echo "  $id" >&2; done
      return 1
    fi
  done
  expected_volume="${PROJECT}-db-data"
  if [ "$MODE" = test ]; then expected_volume="${PROJECT}-test-data"; fi
  volumes=$(ids_for volume) || return 1
  volume_exists=0
  named_volumes=$(docker_query volume ls -q --filter "name=$expected_volume") || return 1
  for candidate in $named_volumes; do
    if [ "$candidate" = "$expected_volume" ]; then volume_exists=1; fi
  done
  if [ "$MODE" = test ] && [ -n "$volumes" ]; then
    echo "Refusing pre-existing test volume resources for $PROJECT:" >&2
    for id in $volumes; do echo "  $id" >&2; done
    return 1
  fi
  if [ "$MODE" = test ] && [ "$volume_exists" -eq 1 ]; then
    echo "Refusing volume name collision: $expected_volume" >&2
    return 1
  fi
  if [ "$MODE" = run ]; then
    for id in $volumes; do
      if [ "$id" != "$expected_volume" ] ||
        [ "$(label_value volume "$id" com.listing-moderation.workspace)" != "$WORKSPACE" ] ||
        [ "$(label_value volume "$id" com.listing-moderation.mode)" != run ]; then
        echo "Refusing unowned run volume $id for $PROJECT." >&2
        return 1
      fi
    done
    if [ "$volume_exists" -eq 1 ]; then
      if [ "$(label_value volume "$expected_volume" com.listing-moderation.workspace)" != "$WORKSPACE" ] ||
        [ "$(label_value volume "$expected_volume" com.listing-moderation.mode)" != run ]; then
        echo "Refusing volume name collision: $expected_volume" >&2
        return 1
      fi
    fi
  fi
  named_networks=$(docker_query network ls --format '{{.Name}}' --filter "name=${PROJECT}_default") || return 1
  for candidate in $named_networks; do
    if [ "$candidate" = "${PROJECT}_default" ]; then
      echo "Refusing network name collision: ${PROJECT}_default" >&2
      return 1
    fi
  done
}
verify_owned_resources() {
  valid=1
  for kind in container network volume; do
    values=$(ids_for "$kind") || return 1
    for id in $values; do
      if [ "$kind" = volume ] && [ "$MODE" = run ]; then
        if [ "$id" = "${PROJECT}-db-data" ] &&
          [ "$(label_value volume "$id" com.listing-moderation.workspace)" = "$WORKSPACE" ] &&
          [ "$(label_value volume "$id" com.listing-moderation.mode)" = run ]; then continue; fi
      fi
      if ! owned "$kind" "$id"; then
        echo "Refusing cleanup: ownership is unverified for $kind $id" >&2
        valid=0
      fi
    done
  done
  [ "$valid" -eq 1 ]
}
# wait may return early when a trapped signal arrives. Retry only when a new
# signal interrupted wait; otherwise preserve the actual child exit status.
wait_child() {
  while :; do
    wait_signal_count=$SIGNAL_COUNT
    wait "$1"; wait_rc=$?
    if [ "$wait_rc" -gt 128 ] && [ "$SIGNAL_COUNT" -ne "$wait_signal_count" ]; then continue; fi
    return "$wait_rc"
  done
}
stop_up() {
  [ -n "$UP_PID" ] || return 0
  if kill -0 "$UP_PID" 2>/dev/null; then
    kill -TERM "$UP_PID" 2>/dev/null || :
    stop_ticks=0
    while kill -0 "$UP_PID" 2>/dev/null && [ "$stop_ticks" -lt 50 ]; do sleep 0.2; stop_ticks=$((stop_ticks + 1)); done
    if kill -0 "$UP_PID" 2>/dev/null; then
      echo "Compose up child $UP_PID exceeded TERM grace; sending KILL to that child only." >&2
      kill -KILL "$UP_PID" 2>/dev/null || :
    fi
  fi
  wait_child "$UP_PID" || :
  UP_PID=
}
cleanup_work() {
  [ "$UP_STARTED" -eq 1 ] || return 0
  PHASE=verify_ownership
  if ! verify_owned_resources; then
    echo "Cleanup skipped because resource ownership could not be proven; inspect project $PROJECT invocation $INVOCATION." >&2
    return 1
  fi
  PHASE=running_down
  set -- timeout --foreground --signal=TERM --kill-after=2s 15s docker compose -p "$PROJECT" -f "$COMPOSE_FILE" down --timeout 10
  if [ "$MODE" = test ]; then set -- "$@" --volumes; fi
  "$@" &
  DOWN_PID=$!
  # Poll first so signals normally interrupt only a short sleep. The separate
  # wait helper still handles a signal delivered at the final wait boundary.
  down_ticks=0
  while kill -0 "$DOWN_PID" 2>/dev/null && [ "$down_ticks" -lt 100 ]; do sleep 0.2; down_ticks=$((down_ticks + 1)); done
  if kill -0 "$DOWN_PID" 2>/dev/null; then
    echo "Scoped Compose cleanup exceeded 20s; terminating cleanup child $DOWN_PID." >&2
    kill -TERM "$DOWN_PID" 2>/dev/null || :
    sleep 2
    kill -KILL "$DOWN_PID" 2>/dev/null || :
    wait_child "$DOWN_PID" || :
    DOWN_PID=
    return 1
  fi
  wait_child "$DOWN_PID"; down_rc=$?; DOWN_PID=
  if [ "$down_rc" -ne 0 ]; then echo "Scoped Compose cleanup failed with exit $down_rc." >&2; return 1; fi
  PHASE=postcheck
  for kind in container network; do
    remaining=$(ids_for "$kind") || return 1
    if [ -n "$remaining" ]; then echo "Cleanup left $kind resources: $remaining" >&2; return 1; fi
  done
  if [ "$MODE" = test ]; then
    remaining=$(docker_query volume ls -q --filter "name=$PROJECT-test-data") || return 1
    if [ -n "$remaining" ]; then echo "Test cleanup left volume resources: $remaining" >&2; return 1; fi
  fi
  return 0
}
cleanup() {
  case "$CLEANUP_STATE" in
    succeeded) return 0 ;;
    failed) return "$CLEANUP_RC" ;;
    running) echo 'Refusing reentrant cleanup.' >&2; return 1 ;;
  esac
  CLEANUP_STATE=running
  cleanup_work; CLEANUP_RC=$?
  if [ "$CLEANUP_RC" -eq 0 ]; then CLEANUP_STATE=succeeded; else
    CLEANUP_STATE=failed
    echo "Scoped Compose cleanup failed: project=$PROJECT invocation=$INVOCATION phase=$PHASE; resource state requires inspection." >&2
  fi
  return "$CLEANUP_RC"
}
release_lock() {
  if [ "${LOCK_OWNED:-0}" -eq 1 ]; then rm -f "$LOCK/pid"; rmdir "$LOCK" 2>/dev/null || :; LOCK_OWNED=0; fi
}
on_signal() {
  SIGNAL_COUNT=$((SIGNAL_COUNT + 1))
  if [ -z "$REQUESTED_SIGNAL" ]; then
    REQUESTED_SIGNAL=$1
    echo "Received $1 during $PHASE; shutdown is coordinated by the main lifecycle." >&2
  fi
}
trap 'on_signal INT' INT
trap 'on_signal TERM' TERM
trap 'release_lock' EXIT

if ! preflight; then
  case "$REQUESTED_SIGNAL" in INT) exit 130 ;; TERM) exit 143 ;; esac
  exit 1
fi
case "$REQUESTED_SIGNAL" in INT) exit 130 ;; TERM) exit 143 ;; esac
if [ "$MODE" = run ]; then
  set -- docker compose -p "$PROJECT" -f "$COMPOSE_FILE" up --build --abort-on-container-exit
else
  set -- docker compose -p "$PROJECT" -f "$COMPOSE_FILE" up --build --abort-on-container-exit --exit-code-from runner
fi
echo "Starting $MODE project $PROJECT for workspace $WORKSPACE"
PHASE=running_up
UP_STARTED=1
"$@" &
UP_PID=$!
while kill -0 "$UP_PID" 2>/dev/null && [ -z "$REQUESTED_SIGNAL" ]; do sleep 0.2; done
if [ -n "$REQUESTED_SIGNAL" ]; then
  PHASE=stopping_up
  stop_up
  compose_rc=1
else
  wait_child "$UP_PID"; compose_rc=$?
  UP_PID=
fi
if [ "$MODE" = run ] && [ -z "$REQUESTED_SIGNAL" ]; then
  for service in api worker; do
    id=$(docker_query compose -p "$PROJECT" -f "$COMPOSE_FILE" ps -a -q "$service" 2>/dev/null)
    if [ -z "$id" ]; then echo "Expected $service container was never created." >&2; compose_rc=1; continue; fi
    state=$(docker_query inspect --format '{{.State.Status}} {{.State.ExitCode}}' "$id" 2>/dev/null) || { compose_rc=1; continue; }
    case "$state" in running\ *) ;; *) echo "$service exited unexpectedly: $state" >&2; compose_rc=1 ;; esac
  done
fi
if [ "$compose_rc" -ne 0 ] && [ "$MODE" = test ]; then echo "Test Compose run failed with exit $compose_rc." >&2; fi
if ! cleanup; then FAILED=1; fi
PHASE=finalize
release_lock
case "$REQUESTED_SIGNAL" in INT) exit 130 ;; TERM) exit 143 ;; esac
if [ "$compose_rc" -ne 0 ] || [ "$FAILED" -ne 0 ]; then exit 1; fi
