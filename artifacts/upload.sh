SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )

rm $SCRIPT_DIR/*.zip

zip -jr $SCRIPT_DIR/cloudwatch-custom-widget.zip $SCRIPT_DIR/../dist/lambda/cloudwatch-custom-widget/*.mjs
zip -jr $SCRIPT_DIR/restatectl.zip  $SCRIPT_DIR/../lambda/restatectl
zip -jr $SCRIPT_DIR/retirement-watcher.zip  $SCRIPT_DIR/../dist/lambda/retirement-watcher/*.mjs

aws s3 mv $SCRIPT_DIR/cloudwatch-custom-widget.zip s3://restate-byoc-artifacts-public-eu-central-1/
aws s3 mv $SCRIPT_DIR/restatectl.zip s3://restate-byoc-artifacts-public-eu-central-1/
aws s3 mv $SCRIPT_DIR/retirement-watcher.zip s3://restate-byoc-artifacts-public-eu-central-1/

CCW_VERSION=$( aws s3api head-object --bucket restate-byoc-artifacts-public-eu-central-1 --key cloudwatch-custom-widget.zip | jq -r '.VersionId')
RCTL_VERSION=$( aws s3api head-object --bucket restate-byoc-artifacts-public-eu-central-1 --key restatectl.zip | jq -r '.VersionId')
RW_VERSION=$( aws s3api head-object --bucket restate-byoc-artifacts-public-eu-central-1 --key retirement-watcher.zip | jq -r '.VersionId')

echo "Versions:"
echo "cloudwatch-custom-widget.zip: ${CCW_VERSION}"
echo "restatectl.zip: ${RCTL_VERSION}"
echo "retirement-watcher.zip: ${RW_VERSION}"
