#!/bin/sh
# Alertmanager does not expand environment variables in its config file, so
# the Slack webhook is written to a file that the config reads via api_url_file.
set -e

printf '%s' "${SLACK_WEBHOOK_URL:-https://hooks.slack.com/services/REPLACE/WITH/YOURS}" \
  > /tmp/slack_webhook_url

exec /bin/alertmanager "$@"
