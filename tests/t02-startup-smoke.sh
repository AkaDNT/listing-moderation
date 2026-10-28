#!/bin/sh
set -eu

fail() { echo "T02 startup smoke failed: $*" >&2; exit 1; }
workspace=$(pwd -P)
project="listing-t02-$$"
run_pid=
run_log=/tmp/t02-startup-smoke-run.log
listing_id="t02-persist-$$"
idempotency_key="t02-key-$$"
decision_id="t02-decision-$$"

stop_run() {
  [ -n "$run_pid" ] || return 0
  if kill -0 "$run_pid" 2>/dev/null; then kill -TERM "$run_pid" 2>/dev/null || :; fi
  wait "$run_pid" 2>/dev/null || :
  run_pid=
}

cleanup() {
  status=$?
  trap - EXIT INT TERM
  stop_run
  volume="${project}-db-data"
  if docker volume inspect "$volume" >/dev/null 2>&1; then
    volume_workspace=$(docker volume inspect --format '{{index .Labels "com.listing-moderation.workspace"}}' "$volume" 2>/dev/null || :)
    volume_mode=$(docker volume inspect --format '{{index .Labels "com.listing-moderation.mode"}}' "$volume" 2>/dev/null || :)
    if [ "$volume_workspace" = "$workspace" ] && [ "$volume_mode" = run ]; then
      docker volume rm "$volume" >/dev/null || status=1
    else
      echo "T02 cleanup refused unverified volume $volume" >&2
      status=1
    fi
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

start_run() {
  port_check=$(curl --silent --show-error --max-time 1 http://127.0.0.1:18083/livez 2>/dev/null || :)
  [ -z "$port_check" ] || fail 'port 18083 already serves an HTTP response'
  RUN_PROJECT="$project" MAKEFLAGS= MAKELEVEL=0 MFLAGS= make run PORT=18083 >"$run_log" 2>&1 &
  run_pid=$!
  attempt=0
  while [ "$attempt" -lt 180 ]; do
    if curl --fail --silent --max-time 2 http://127.0.0.1:18083/livez >/tmp/t02-livez.json; then
      grep -q '"status":"ok"' /tmp/t02-livez.json || fail 'unexpected /livez response'
      return 0
    fi
    if ! kill -0 "$run_pid" 2>/dev/null; then
      cat "$run_log" >&2
      fail 'make run exited before API became live'
    fi
    api_id=$(docker ps -aq --filter "label=com.docker.compose.project=$project" --filter 'label=com.docker.compose.service=api' | head -n 1)
    if [ -n "$api_id" ] && [ "$(docker inspect --format '{{.State.Status}}' "$api_id" 2>/dev/null || :)" = exited ]; then
      cat "$run_log" >&2
      docker logs "$api_id" >&2 2>/dev/null || :
      fail 'runtime API image exited before serving /livez'
    fi
    sleep 1
    attempt=$((attempt + 1))
  done
  cat "$run_log" >&2
  fail 'API did not become live within 180 seconds'
}

assert_bootstrap_and_persisted_rows() {
  db_id=$(docker ps -q --filter "label=com.docker.compose.project=$project" --filter 'label=com.docker.compose.service=db')
  worker_id=$(docker ps -q --filter "label=com.docker.compose.project=$project" --filter 'label=com.docker.compose.service=worker')
  api_id=$(docker ps -q --filter "label=com.docker.compose.project=$project" --filter 'label=com.docker.compose.service=api')
  [ -n "$db_id" ] && [ -n "$worker_id" ] && [ -n "$api_id" ] || fail 'runtime API, worker, or PostgreSQL container is not running'
  counts=$(docker exec "$db_id" psql -U moderator -d listings -tAc \
    "SELECT (SELECT count(*) FROM sellers)||'|'||(SELECT count(*) FROM categories)||'|'||(SELECT count(*) FROM banned_keywords)||'|'||(SELECT count(*) FROM schema_migrations)")
  [ "$counts" = '8|5|6|1' ] || fail "runtime image loaded unexpected schema/seed counts: $counts"
  persisted=$(docker exec "$db_id" psql -U moderator -d listings -tAc \
    "SELECT (SELECT count(*) FROM listings l JOIN submission_keys k ON k.listing_id=l.id JOIN moderation_jobs j ON j.listing_id=l.id WHERE l.id='$listing_id' AND k.key='$idempotency_key')||'|'||(SELECT count(*) FROM listings WHERE id='$decision_id' AND status='auto_approved' AND decision->>'outcome'='approved')||'|'||(SELECT count(*) FROM moderation_history WHERE listing_id='$decision_id' AND phase='auto')||'|'||(SELECT count(*) FROM moderation_jobs WHERE listing_id='$decision_id' AND state='completed')")
  [ "$persisted" = '1|1|1|1' ] || fail "expected listing/key/job/decision/history did not survive restart: $persisted"
}

start_run
db_id=$(docker ps -q --filter "label=com.docker.compose.project=$project" --filter 'label=com.docker.compose.service=db')
[ -n "$db_id" ] || fail 'PostgreSQL container missing after API startup'
docker exec "$db_id" psql -v ON_ERROR_STOP=1 -U moderator -d listings -c \
  "BEGIN; INSERT INTO listings(id,seller_id,category_id,title,description,price_vnd) VALUES('$listing_id','s-1001','c-phones','T02 restart probe','',0); INSERT INTO submission_keys(key,request_hash,listing_id) VALUES('$idempotency_key','probe','$listing_id'); INSERT INTO moderation_jobs(id,listing_id) VALUES('$listing_id','$listing_id'); INSERT INTO listings(id,seller_id,category_id,title,description,price_vnd,status,decision,decided_at) VALUES('$decision_id','s-1001','c-phones','T02 decision probe','',0,'auto_approved','{\"outcome\":\"approved\",\"reasons\":[]}'::jsonb,'2026-01-01T00:00:00Z'); INSERT INTO moderation_history(listing_id,phase,decision) VALUES('$decision_id','auto','{\"outcome\":\"approved\",\"reasons\":[]}'); INSERT INTO moderation_jobs(id,listing_id,state,completed_at) VALUES('$decision_id','$decision_id','completed','2026-01-01T00:00:00Z'); COMMIT;" >/dev/null
assert_bootstrap_and_persisted_rows
stop_run

start_run
assert_bootstrap_and_persisted_rows
stop_run
echo 'T02 startup smoke passed: production API and worker images bootstrapped PostgreSQL, loaded seed assets, and retained listing/key/job data across Compose restart.'
