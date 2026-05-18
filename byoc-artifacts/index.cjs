"use strict";

const path = require("node:path");

const here = (file) => path.join(__dirname, file);

module.exports = {
  retirementWatcher: here("retirement-watcher.zip"),
  restatectl: here("restatectl.zip"),
  cloudwatchCustomWidget: here("cloudwatch-custom-widget.zip"),
};
