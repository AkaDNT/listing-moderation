#!/bin/sh
set -eu
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM
cp .dockerignore "$tmp/.dockerignore"
cp tests/build-context/probe.Dockerfile "$tmp/Dockerfile"
for base in "$tmp" "$tmp/nested"; do
  for name in .aws .codex .agents .local-docs .git node_modules dist coverage reports; do
    mkdir -p "$base/$name"
    printf 'synthetic sentinel only\n' > "$base/$name/sentinel"
  done
done
printf 'positive build input\n' > "$tmp/positive-input.txt"
printf 'synthetic sentinel only\n' > "$tmp/.env"
printf 'synthetic sentinel only\n' > "$tmp/nested/.env.production"
printf 'synthetic sentinel only\n' > "$tmp/nested/.aws/credentials"
printf 'synthetic sentinel only\n' > "$tmp/nested/.codex/settings.json"
printf 'synthetic sentinel only\n' > "$tmp/nested/.agents/config.toml"
printf 'synthetic sentinel only\n' > "$tmp/nested/.local-docs/plan.md"
printf 'synthetic sentinel only\n' > "$tmp/nested/.git/config"
printf 'synthetic sentinel only\n' > "$tmp/nested/node_modules/sentinel"
printf 'synthetic sentinel only\n' > "$tmp/nested/dist/sentinel"
printf 'synthetic sentinel only\n' > "$tmp/nested/coverage/sentinel"
printf 'synthetic sentinel only\n' > "$tmp/nested/reports/sentinel"
docker build --no-cache --progress=plain --target context-probe -f "$tmp/Dockerfile" "$tmp"
