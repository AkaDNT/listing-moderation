.DEFAULT_GOAL := help
.PHONY: help run test smoke

PORT ?= 8080

help:
	@printf '%s\n' 'make run [PORT=8080]  Start the API, worker and PostgreSQL in the foreground.' 'make test             Run the isolated containerized test suite.'

run:
	@exec sh scripts/compose-lifecycle.sh run "$(PORT)"

test:
	@exec sh scripts/compose-lifecycle.sh test "$(PORT)"

smoke:
	@sh tests/t01-smoke.sh
	@sh tests/t02-startup-smoke.sh
