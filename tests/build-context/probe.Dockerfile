FROM busybox:1.36 AS context-probe
WORKDIR /probe
COPY . /context
RUN for base in /context /context/nested; do \
      for name in .aws .codex .agents .local-docs .git node_modules dist coverage reports; do \
        test ! -e "$base/$name" || exit 1; \
      done; \
    done \
 && test -f /context/positive-input.txt \
 && test ! -e /context/.env \
 && test ! -e /context/nested/.env.production \
 && test ! -e /context/.aws/credentials \
 && test ! -e /context/nested/.codex/settings.json \
 && test ! -e /context/nested/.agents/config.toml \
 && test ! -e /context/nested/.local-docs/plan.md \
 && test ! -e /context/nested/.git/config \
 && test ! -e /context/nested/node_modules/sentinel \
 && test ! -e /context/nested/dist/sentinel \
 && test ! -e /context/nested/coverage/sentinel \
 && test ! -e /context/nested/reports/sentinel
