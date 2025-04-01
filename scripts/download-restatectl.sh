#!/bin/bash
set -e

SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )

URL=${1}
OUTPUT_DIR=$SCRIPT_DIR/../.cache/restatectl
mkdir -p "$OUTPUT_DIR/lambda"

if [ -f "$OUTPUT_DIR/source" ] && [ -f "$OUTPUT_DIR/lambda/bootstrap" ] && [ "$URL" == "$(cat "$OUTPUT_DIR/source")" ] ; then
    echo "restatectl from ${URL} already exists"
    exit 0
fi

ARCHIVE_NAME=$(basename "$URL")
TEMP_DIR=$(mktemp -d)

echo "Downloading $URL to $TEMP_DIR"
curl -L "$URL" -o "$TEMP_DIR/$ARCHIVE_NAME"

echo "Extracting archive..."
tar -xf "$TEMP_DIR/$ARCHIVE_NAME" -C "$TEMP_DIR"

echo "Copying binary..."

mv $TEMP_DIR/*/restatectl "$OUTPUT_DIR/lambda/bootstrap"

echo "$URL" > "$OUTPUT_DIR/source"

echo "Cleaning up..."
rm -rf "$TEMP_DIR"

echo "Done!"
