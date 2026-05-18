#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )
REPO_ROOT="$SCRIPT_DIR/.."
ARTIFACTS_PKG="$REPO_ROOT/byoc-artifacts"
VERSION=$1

rm -f "$ARTIFACTS_PKG"/*.zip

zip -jr "$ARTIFACTS_PKG/cloudwatch-custom-widget.zip" "$REPO_ROOT"/dist/lambda/cloudwatch-custom-widget/*.mjs
zip -jr "$ARTIFACTS_PKG/restatectl.zip"               "$REPO_ROOT"/lib/lambda/restatectl
zip -jr "$ARTIFACTS_PKG/retirement-watcher.zip"       "$REPO_ROOT"/dist/lambda/retirement-watcher/*.mjs

aws s3 cp "$ARTIFACTS_PKG/cloudwatch-custom-widget.zip" "s3://restate-byoc-artifacts-public-eu-central-1/${VERSION}/assets/"
aws s3 cp "$ARTIFACTS_PKG/restatectl.zip"               "s3://restate-byoc-artifacts-public-eu-central-1/${VERSION}/assets/"
aws s3 cp "$ARTIFACTS_PKG/retirement-watcher.zip"       "s3://restate-byoc-artifacts-public-eu-central-1/${VERSION}/assets/"
