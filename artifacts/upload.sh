#!/usr/bin/env bash

SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )
VERSION=$1

rm $SCRIPT_DIR/*.zip

zip -jr $SCRIPT_DIR/cloudwatch-custom-widget.zip $SCRIPT_DIR/../dist/lambda/cloudwatch-custom-widget/*.mjs
zip -jr $SCRIPT_DIR/restatectl.zip  $SCRIPT_DIR/../lib/lambda/restatectl
zip -jr $SCRIPT_DIR/retirement-watcher.zip  $SCRIPT_DIR/../dist/lambda/retirement-watcher/*.mjs

aws s3 mv $SCRIPT_DIR/cloudwatch-custom-widget.zip s3://restate-byoc-artifacts-public-eu-central-1/${VERSION}/assets/
aws s3 mv $SCRIPT_DIR/restatectl.zip s3://restate-byoc-artifacts-public-eu-central-1/${VERSION}/assets/
aws s3 mv $SCRIPT_DIR/retirement-watcher.zip s3://restate-byoc-artifacts-public-eu-central-1/${VERSION}/assets/
