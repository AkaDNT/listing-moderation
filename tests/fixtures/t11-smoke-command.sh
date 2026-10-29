#!/bin/sh
# Test-only command boundary: never delegates to a real Docker executable.
command=${0##*/}
if [ "$command" = timeout ]; then
  if [ "$1" = --version ]; then echo 'timeout (GNU coreutils) test fixture'; exit 0; fi
  while [ "${1#-}" != "$1" ]; do shift; done
  shift
  exec "$@"
fi
if [ "$command" = curl ]; then
  [ -e "$CASE_ROOT/started" ] || exit 7
  while [ "$#" -gt 0 ]; do
    case "$1" in --output) shift; printf '{"status":"ok"}' > "$1";; esac
    shift
  done
  printf 200
  exit 0
fi
printf '%s\n' "$*" >> "$CASE_ROOT/trace"
case "$*" in
  'ps -aq '*)
    if [ ! -e "$CASE_ROOT/started" ] && [ "$SCENARIO" = preflight_container ]; then exit 42; fi
    if [ -e "$CASE_ROOT/cleanup" ] && [ "$SCENARIO" = cleanup_container ]; then exit 42; fi
    [ ! -e "$CASE_ROOT/started" ] || printf 'db-id\napi-id\nworker-id\n'; exit 0 ;;
  'network ls '*)
    if [ ! -e "$CASE_ROOT/started" ] && [ "$SCENARIO" = preflight_network ]; then exit 42; fi
    if [ -e "$CASE_ROOT/cleanup" ] && [ "$SCENARIO" = cleanup_network ]; then exit 42; fi
    if [ ! -e "$CASE_ROOT/started" ] && [ "$SCENARIO" = foreign_network ]; then
      case "$*" in *--format*) echo "${COMPOSE_PROJECT_NAME}_default";; esac
      exit 0
    fi
    [ ! -e "$CASE_ROOT/started" ] || echo network-id; exit 0 ;;
  'volume ls '*)
    if [ ! -e "$CASE_ROOT/started" ] && [ "$SCENARIO" = preflight_volume ]; then exit 42; fi
    if [ -e "$CASE_ROOT/cleanup" ] && [ "$SCENARIO" = cleanup_volume ]; then exit 42; fi
    if [ ! -e "$CASE_ROOT/started" ] && [ "$SCENARIO" = foreign_volume ]; then echo "$COMPOSE_PROJECT_NAME-db-data"; exit 0; fi
    [ ! -e "$CASE_ROOT/started" ] || echo "$COMPOSE_PROJECT_NAME-db-data"; exit 0 ;;
  'volume inspect '*)
    if [ ! -e "$CASE_ROOT/started" ]; then
      [ "$SCENARIO" != preflight_volume ] || exit 124
      exit 1
    fi
    if [ -e "$CASE_ROOT/cleanup" ]; then
      [ "$SCENARIO" != cleanup_volume ] || exit 124
      case "$*" in *--format*) [ "$SCENARIO" != cleanup_label ] || exit 124;; esac
      if [ "$SCENARIO" = cleanup_foreign_label ]; then echo 'foreign|foreign|foreign'; exit 0; fi
    fi
    printf '%s|%s|%s\n' "$LM_WORKSPACE" "$LM_MODE" "$LM_INVOCATION"; exit 0 ;;
  'inspect --format '*)
    case "$*" in *State.Pid*) echo 42;; *) printf '%s|%s|%s\n' "$LM_WORKSPACE" "$LM_MODE" "$LM_INVOCATION";; esac; exit 0 ;;
  'network inspect --format '*) printf '%s|%s|%s\n' "$LM_WORKSPACE" "$LM_MODE" "$LM_INVOCATION"; exit 0 ;;
  *' up --build -d') touch "$CASE_ROOT/started"; exit 0 ;;
  *' ps -q db') echo db-id; exit 0 ;;
  *' ps -q api') echo api-id; exit 0 ;;
  *' ps -q worker') echo worker-id; exit 0 ;;
  *' down -v --remove-orphans') exit 0 ;;
  'stop worker-id')
    touch "$CASE_ROOT/cleanup" "$CASE_ROOT/barrier"
    case "$SCENARIO" in signal_*) sleep 0.4; exit 0;; esac
    exit 42 ;;
esac
exit 99
