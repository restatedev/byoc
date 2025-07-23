#!/usr/bin/env bash

args=""; for arg; do args=$(printf '%s"%s"' "$args", "$arg"); done;
args=${args#,}
payload="{\"args\":[$args]}"
lambda_out=$(mktemp)
aws lambda invoke --function-name FargateClusterStack-restatebyocrestatectllambda255-WVcqzMBWlhv6 --region us-east-1 \
    --payload "${payload}" --cli-binary-format raw-in-base64-out ${lambda_out} > /dev/null

stderr=$(jq -r '.stderr' ${lambda_out})
stdout=$(jq -r '.stdout' ${lambda_out})

if [ -n "$stdout" ]; then
    echo "${stdout}"
fi
if [ -n "$stderr" ]; then
    echo "${stderr}" 2>&1
fi
