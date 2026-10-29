#!/bin/sh
set -eu

fail() { echo "T11 health smoke failed: $*" >&2; exit 1; }
case "$(timeout --version 2>/dev/null)" in *'GNU coreutils'*) ;; *) fail 'GNU timeout is required';; esac
workspace=$(pwd -P)
invocation="$$-$(date +%s)"
project="listing-t11-$invocation"
port=${T11_SMOKE_PORT:-18084}
mode=t11-smoke
export COMPOSE_PROJECT_NAME="$project" LM_WORKSPACE="$workspace" LM_MODE="$mode" LM_INVOCATION="$invocation" PORT="$port"
docker_q() { timeout --foreground --signal=TERM --kill-after=2s 20s docker "$@"; }
compose_q() { timeout --foreground --signal=TERM --kill-after=3s 240s docker compose -f compose.yaml "$@"; }

owned() {
  kind=$1 id=$2
  case "$kind" in
    container) docker_q inspect --format '{{index .Config.Labels "com.listing-moderation.workspace"}}|{{index .Config.Labels "com.listing-moderation.mode"}}|{{index .Config.Labels "com.listing-moderation.invocation"}}' "$id" ;;
    volume|network) docker_q "$kind" inspect --format '{{index .Labels "com.listing-moderation.workspace"}}|{{index .Labels "com.listing-moderation.mode"}}|{{index .Labels "com.listing-moderation.invocation"}}' "$id" ;;
  esac
}
verify_owned() {
  kind=$1 id=$2
  [ "$(owned "$kind" "$id")" = "$workspace|$mode|$invocation" ] || fail "refusing unverified $kind $id"
}
cleanup() {
  status=$?
  trap - EXIT
  trap '' INT TERM
  if [ "${started:-0}" = 1 ]; then
    safe=1
    container_ids=$(docker_q ps -aq --filter "label=com.docker.compose.project=$project" 2>/dev/null) || safe=0
    network_ids=$(docker_q network ls -q --filter "label=com.docker.compose.project=$project" 2>/dev/null) || safe=0
    for id in $container_ids; do
      [ "$(owned container "$id" 2>/dev/null || :)" = "$workspace|$mode|$invocation" ] || safe=0
    done
    for id in $network_ids; do
      [ "$(owned network "$id" 2>/dev/null || :)" = "$workspace|$mode|$invocation" ] || safe=0
    done
    volume="$project-db-data"
    volume_names=$(docker_q volume ls --format '{{.Name}}' --filter "name=$volume" 2>/dev/null) || safe=0
    for name in $volume_names; do
      if [ "$name" = "$volume" ]; then
        [ "$(owned volume "$volume" 2>/dev/null || :)" = "$workspace|$mode|$invocation" ] || safe=0
      fi
    done
    if [ "$safe" = 1 ]; then compose_q down -v --remove-orphans >/dev/null || status=1
    else echo 'T11 cleanup refused resources with mismatched ownership labels' >&2; status=1; fi
  fi
  rm -f "/tmp/t11-health-smoke-body-$$" "/tmp/t11-health-smoke-submit-$$"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

existing_containers=$(docker_q ps -aq --filter "label=com.docker.compose.project=$project") || fail 'cannot inspect project containers'
[ -z "$existing_containers" ] || fail 'project containers already exist'
existing_networks=$(docker_q network ls -q --filter "label=com.docker.compose.project=$project") || fail 'cannot inspect project networks'
[ -z "$existing_networks" ] || fail 'project network already exists'
volume_names=$(docker_q volume ls --format '{{.Name}}' --filter "name=$project-db-data") || fail 'cannot inspect project volumes'
for name in $volume_names; do
  [ "$name" != "$project-db-data" ] || fail 'project volume already exists'
done
network_names=$(docker_q network ls --format '{{.Name}}' --filter "name=${project}_default") || fail 'cannot inspect network name collisions'
for name in $network_names; do
  [ "$name" != "${project}_default" ] || fail 'project network name already exists'
done
if curl --silent --show-error --max-time 1 "http://127.0.0.1:$port/livez" >/dev/null 2>&1; then fail 'smoke port already serves HTTP'; fi
started=1
compose_q up --build -d
db_id=$(compose_q ps -q db)
api_id=$(compose_q ps -q api)
worker_id=$(compose_q ps -q worker)
[ -n "$db_id" ] && [ -n "$api_id" ] && [ -n "$worker_id" ] || fail 'one or more services did not start'
verify_owned container "$db_id"
verify_owned container "$api_id"
verify_owned container "$worker_id"
verify_owned volume "$project-db-data"
api_pid=$(docker_q inspect --format '{{.State.Pid}}' "$api_id")

probe() {
  path=$1
  curl --silent --show-error --max-time 8 --output /tmp/t11-health-smoke-body-$$ --write-out '%{http_code}' "http://127.0.0.1:$port/$path" || :
}
wait_status() {
  path=$1 expected=$2
  count=0
  while [ "$count" -lt 60 ]; do
    actual=$(probe "$path")
    if [ "$actual" = "$expected" ]; then return 0; fi
    sleep 1
    count=$((count + 1))
  done
  fail "$path did not become HTTP $expected; last=${actual:-none}"
}
wait_status readyz 200
grep -q '"status":"ok"' /tmp/t11-health-smoke-body-$$ || fail 'healthy readiness body mismatch'
echo "T11 healthy ready=200 api=$api_id pid=$api_pid"

# Stop only this smoke project's worker so accepted work remains pending across the DB outage.
docker_q stop "$worker_id" >/dev/null
body='{"seller_id":"s-1002","category_id":"c-phones","title":"T11 accepted before database outage","description":"clean listing","price_vnd":6000000}'
response=$(curl --silent --show-error --max-time 8 --output /tmp/t11-health-smoke-submit-$$ --write-out '%{http_code}' \
  -H 'content-type: application/json' -H 'Idempotency-Key: t11-accepted-before-outage' -d "$body" "http://127.0.0.1:$port/v1/listings")
[ "$response" = 202 ] || fail "pre-outage submission returned HTTP $response"
listing_id=$(sed -n 's/.*"id":"\([^"]*\)".*/\1/p' /tmp/t11-health-smoke-submit-$$)
printf '%s' "$listing_id" | grep -Eq '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$' || fail 'pre-outage submission returned an invalid listing ID'
pending_body=$(curl --silent --show-error --max-time 8 "http://127.0.0.1:$port/v1/listings/$listing_id") || fail 'could not GET accepted listing before outage'
case "$pending_body" in *'"status":"pending"'*) ;; *) fail 'accepted listing was not pending before outage';; esac
pending_db=$(docker_q exec "$db_id" psql -v ON_ERROR_STOP=1 -U moderator -d listings -Atc \
  "SELECT l.status||'|'||j.state||'|'||j.attempts||'|'||COALESCE(l.decision::text,'NULL')||'|'||(SELECT count(*) FROM moderation_history h WHERE h.listing_id=l.id) FROM listings l JOIN moderation_jobs j ON j.listing_id=l.id WHERE l.id='$listing_id'")
[ "$pending_db" = 'pending|queued|0|NULL|0' ] || fail "pre-outage DB state mismatch: $pending_db"
echo "T11 accepted before outage listing=$listing_id pending=1 worker_stopped=1"

docker_q stop "$db_id" >/dev/null
wait_status readyz 503
grep -q '"status":"not_ready"' /tmp/t11-health-smoke-body-$$ || fail 'unavailable readiness body mismatch'
[ "$(probe livez)" = 200 ] || fail 'liveness did not remain 200 during DB outage'
[ "$(docker_q inspect --format '{{.State.Pid}}' "$api_id")" = "$api_pid" ] || fail 'API process changed during DB outage'
echo "T11 outage ready=503 live=200 same_api_pid=$api_pid"

docker_q start "$db_id" >/dev/null
wait_status readyz 200
pending_after_restore=$(curl --silent --show-error --max-time 8 "http://127.0.0.1:$port/v1/listings/$listing_id") || fail 'could not GET accepted listing after DB restore'
case "$pending_after_restore" in *'"status":"pending"'*) ;; *) fail 'accepted work did not remain pending until worker restart';; esac
docker_q start "$worker_id" >/dev/null
count=0
while [ "$count" -lt 60 ]; do
  result=$(curl --silent --show-error --max-time 8 "http://127.0.0.1:$port/v1/listings/$listing_id" || :)
  case "$result" in *'"status":"published"'*) break;; esac
  sleep 1
  count=$((count + 1))
done
[ "$count" -lt 60 ] || fail 'accepted work did not advance after DB restore'
final_db=$(docker_q exec "$db_id" psql -v ON_ERROR_STOP=1 -U moderator -d listings -Atc \
  "SELECT l.status||'|'||j.state||'|'||j.attempts||'|'||(SELECT count(*) FROM moderation_history h WHERE h.listing_id=l.id)||'|'||l.version FROM listings l JOIN moderation_jobs j ON j.listing_id=l.id WHERE l.id='$listing_id'")
[ "$final_db" = 'published|completed|1|1|2' ] || fail "recovered work final DB state mismatch: $final_db"
[ "$(docker_q inspect --format '{{.State.Pid}}' "$api_id")" = "$api_pid" ] || fail 'API process changed after DB restore'
echo "T11 restored ready=200 listing=$listing_id progressed=1 final=$final_db same_api_pid=$api_pid"
