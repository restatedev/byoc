import type { Context } from "aws-lambda";
import { EMBER_BOLD, EMBER_ITALIC, EMBER_REGULAR } from "./static.mjs";
import { ControlPanelWidgetEvent } from "./index.mjs";

const FLEX_IF_PAGE = (i: number) => `--a${i}`;
const CONTENTS_IF_PAGE = (i: number) => `--b${i}`;
const BLOCK_IF_SORT_COLUMN = (i: number) => `--c${i}`;
const NONE_IF_SORT_COLUMN = (i: number) => `--d${i}`;
const EMPTY_IF_NOT_SORT_COLUMN = (i: number) => `--e${i}`;
const LABEL_COLOR_IF_TAB = (i: number) => `--f${i}`;
const ONE_IF_TAB = (i: number) => `--g${i}`;
const BLOCK_IF_TAB = (i: number) => `--h${i}`;
const EMPTY_VAR = "--i";

export function css(
  maxTabs: number,
  maxTableRows: number,
  maxTableColumns: number,
): string {
  return `
<div class="cwdb-no-default-styles"></div>
<style>
@charset "UTF-8";
@font-face{
  font-family:'Amazon Ember';
  font-style: normal;
  font-weight: 400;
  src: url(data:font/woff;base64,${EMBER_REGULAR}) format("woff");
}
@font-face{
  font-family:'Amazon Ember';
  font-style: italic;
  font-weight: 500;
  src: url(data:font/woff;base64,${EMBER_ITALIC}) format("woff");
}
@font-face{
  font-family:'Amazon Ember';
  font-style: normal;
  font-weight: 700;
  src: url(data:font/woff;base64,${EMBER_BOLD}) format("woff");
}
</style>
<style type="text/css">
body {
  ${EMPTY_VAR}: var(--thisvariabledoesnotexist,);
  font-size: 14px;
  font-family:
      Amazon Ember,
      Helvetica Neue,
      Roboto,
      Arial,
      sans-serif;
}

table {
  font-size: 14px;
}

.awsui_header.awsui_with-paddings {
  padding-block-start: 12px;
  padding-block-end: 8px;
  padding-inline: 20px;
}

.awsui_heading {
  margin-block: 0;
  margin-inline: 0;
  display: inline;
}

h2.awsui_heading {
  font-size: 20px;
  line-height: 24px;
  letter-spacing: normal;
}

h3.awsui_heading {
  font-size: 18px;
  line-height: 22px;
  letter-spacing: normal;
}

.cwdb-custom-inner h3 {
  font-weight: bold;
  border-bottom: 0;
}

.cwdb-custom-inner h2 {
  font-weight: bold;
  border-bottom: 0;
}

.awsui_link {
  font-weight: normal;
  color: #006ce0;
}

.awsui_link:hover {
  color: #002b66;
}

.awsui_content-wrapper {
  display: flex;
  flex-direction: column;
  inline-size: 100%;
  overflow: hidden;
}

.awsui_border {
  border-block: solid 1px #c6c6cd;
  border-inline: solid 1px #c6c6cd;
  border-start-start-radius: 16px;
  border-start-end-radius: 16px;
  border-end-start-radius: 16px;
  border-end-end-radius: 16px;
  box-sizing: border-box;
}

.awsui_content {
  flex: 1;
}

.awsui_content-inner.awsui_with-paddings {
  padding-block: 20px;
  padding-inline: 20px;
}

.awsui_content-inner.awsui_with-paddings.awsui_with-header {
  padding-block-start: 4px;
}

.awsui_css-grid {
  display: grid;
  gap: 20px;
}

.awsui_css-grid > .awsui_item {
  padding-inline: 20px;
  position: relative;
}

.awsui_css-grid > .awsui_item:before {
  content: "";
  position: absolute;
  inset-block-start: 0;
  inset-block-end: 0;
  inset-inline-start: 0;
  border-inline-start: 1px solid #c6c6cd;
  transform: translate(-10px);
}

.awsui_css-grid > .awsui_item.awsui_first-column {
  padding-inline-start: 0;
}

.awsui_css-grid > .awsui_item.awsui_first-column:before {
  display: none;
}

.awsui_vertical {
  display: flex;
  flex-direction: column;
}

.awsui_vertical-l {
  row-gap: 20px;
}

.awsui_vertical-m {
  row-gap: 16px;
}

.awsui_vertical-s {
  row-gap: 12px;
}

.awsui_horizontal {
  display: flex;
  flex-flow: wrap;
}

.awsui_horizontal-l {
  gap: 20px;
}

.awsui_horizontal-m {
  gap: 16px;
}

.awsui_horizontal-s {
  gap: 12px;
}

.awsui_horizontal-xs {
  gap: 8px;
}

.awsui_key-label {
  font-weight: bold;
}

.awsui_tabs [type="radio"] {
  display: none;
}

.awsui_tabs-header {
  margin-block: 0;
  margin-inline: 0;
  padding-block: 0;
  padding-inline: 0;
  display: flex;
  flex-wrap: wrap;
}

.awsui_tabs-header-with-divider {
  border-block-end: 1px solid #c6c6cd;
}

.awsui_tabs-header-scroll-container {
  display: flex;
  flex-grow: 1;
  max-inline-size: 100%;
}

.awsui_tabs-header-list {
  margin-block: 0;
  margin-inline: 0;
  padding-block: 0;
  padding-inline: 0;
  display: flex;
  overflow-x: scroll;
  overflow-y: hidden;
  position: relative;
  inline-size: 100%;
  scroll-snap-type: inline proximity;
  -ms-overflow-style: none;
  scrollbar-width: none;
}

.awsui_tabs-tab {
  margin-inline-start: 1px;
  scroll-margin-inline-start: 1px;
  list-style: none;
  padding-block: 0;
  padding-inline: 0;
  flex-shrink: 0;
  display: flex;
  max-inline-size: calc(90% - 20px);
  scroll-snap-align: start;
}

.awsui_tabs-tab > .awsui_tabs-tab-header-container {
  padding-inline-start: 7px;
  margin-inline-end: -1px;
  position: relative;
  border-block: 1px solid transparent;
  border-inline: 1px solid transparent;
  padding-inline: 8px;
  display: flex;
  align-items: stretch;
}

.awsui_tabs-tab > .awsui_tabs-tab-header-container {
  padding-inline-start: 7px;
  margin-inline-end: -1px;
  position: relative;
  border-block: 1px solid transparent;
  border-inline: 1px solid transparent;
  padding-inline: 8px;
  display: flex;
  align-items: stretch;
}

.awsui_tabs-tab-header-container > button {
  background-color: transparent;
}

.awsui_tabs-tab:not(:last-child)>.awsui_tabs-tab-header-container:before {
  content: "";
  position: absolute;
  border-inline-end: 1px solid #c6c6cd;
  inset: 12px 0;
  opacity: 1;
}

.awsui_tabs-tab-header-container:after {
  content: "";
  position: absolute;
  inset-inline-start: 0;
  inline-size: calc(100% - 1px);
  inset-block-end: -1px;
  block-size: 4px;
  border-start-start-radius: 20px;
  border-start-end-radius: 20px;
  border-end-start-radius: 20px;
  border-end-end-radius: 20px;
  background: #006ce0;
  opacity: var(--after-opacity);
}

.awsui_tabs-tab-link {
  padding-block-start: 7px;
  padding-block-end: 7px;
  margin-block-start: 0;
  position: relative;
  display: flex;
  align-items: stretch;
  text-decoration: none;
  cursor: pointer;
  padding-inline: 0;
  margin-block-start: 1px;
  border-block: 1px solid transparent;
  border-inline: 1px solid transparent;
  font-size: 16px;
  line-height: 20px;
  font-weight: bold;
  padding-inline-start: 3px;
  padding-inline-end: 4px;
}

.awsui_tabs-tab-label {
  display: flex;
  align-items: center;
  padding-inline: 8px;
  padding-block: 4px;
  text-align: start;
  position: relative;
  min-inline-size: 0;
  word-break: break-word;
}

.awsui_tabs-content {
  display: none;
}

${[...Array(maxTabs).keys()]
  .map(
    (i) =>
      `.tab-radio-${i}:checked ~ .awsui_tabs-header { ${LABEL_COLOR_IF_TAB(i)}: #006ce0; ${ONE_IF_TAB(i)}: 1 }`,
  )
  .join("\n")}

${[...Array(maxTabs).keys()]
  .map(
    (i) =>
      `.tab-radio-${i}:checked ~ .awsui_tabs-content-wrapper { ${BLOCK_IF_TAB(i)}: block }`,
  )
  .join("\n")}

.awsui_tabs-content-wrapper > .awsui_tabs-content {
  padding-block: 16px;
  padding-inline: 0;
}

.awsui_paginated-table [type="radio"] {
  display: none;
}


${[...Array(Math.ceil(maxTableRows / 10)).keys()]
  .map(
    (i) =>
      `.page-radio-${i}:checked ~ .awsui_content-wrapper { ${FLEX_IF_PAGE(i)}: flex; ${CONTENTS_IF_PAGE(i)}: contents }`,
  )
  .join("\n")}

${[...Array(maxTableColumns * 2).keys()]
  .map(
    (i) =>
      `.sort-column-radio-${i}:checked ~ .awsui_content-wrapper {` +
      [...Array(maxTableColumns * 2).keys()]
        .map(
          (j) =>
            j == i
              ? `${BLOCK_IF_SORT_COLUMN(j)}: block; ${NONE_IF_SORT_COLUMN(j)}: none;`
              : `${EMPTY_IF_NOT_SORT_COLUMN(j)}: var(${EMPTY_VAR});`, // set all but the selected col to an empty value
        )
        .join("") +
      `}`,
  )
  .join("\n")}

.awsui_icon-wrapper {
  white-space: nowrap;
}

.awsui_icon {
  display: inline-block;
}

.awsui_icon-inner {
  color: currentColor;
  inline-size: 16px;
  box-sizing: border-box;
}

.awsui_icon-inner > svg .filled {
  fill: currentColor;
}

.awsui_icon-inner > svg.stroke-linejoin-round {
  stroke-linejoin: round;
}

.awsui_icon-inner > svg {
  fill: none;
  stroke: currentColor;
  stroke-width: 2px;
  inline-size: 16px;
  block-size: 16px;
  vertical-align: top;
}

.awsui_icon-inner {
  position: relative;
  display: inline-block;
  vertical-align: middle;
}

.awsui_icon-flex-height {
  display: inline-flex;
  align-items: center;
}

.awsui_sorting_icon {
  padding-inline-start: 10px;
  cursor: pointer;
}

.ecs-horizontal-attachment {
  width: 100%;
  display: flex;
  align-items: center;
}
.ecs-horizontal-attachment > .ecs-horizontal-attachment__main {
  flex: 1 1 auto;
  min-width: 0;
}
.ecs-horizontal-attachment > .ecs-horizontal-attachment__attachment {
  margin-right: 0;
}
.ecs-horizontal-attachment-gap-n {
  gap: 0;
}
.ecs-horizontal-attachment-gap-xxxs {
  gap: 2px;
}
.ecs-horizontal-attachment-gap-xxs {
  gap: 4px;
}
.ecs-horizontal-attachment-gap-xs {
  gap: 8px;
}
.ecs-horizontal-attachment-gap-s {
  gap: 12px;
}
.ecs-horizontal-attachment-gap-m {
  gap: 16px;
}
.ecs-horizontal-attachment-gap-l {
  gap: 20px;
}
.ecs-horizontal-attachment-gap-xl {
  gap: 24px;
}
.ecs-horizontal-attachment-gap-xxl {
  gap: 32px;
}
.ecs-horizontal-attachment-gap-xxxl {
  gap: 40px;
}

.ecs-task-stats .ecs-status-bar {
  min-width: 40px;
}

.ecs-task-stats__wrap {
  flex-wrap: wrap;
}
.ecs-task-stats__wrap .ecs-task-stats__attachment {
  flex-wrap: wrap;
}
.ecs-task-stats__no-wrap {
  flex-wrap: nowrap;
  overflow: hidden;
}
.ecs-task-stats__no-wrap .ecs-task-stats__attachment {
  flex-wrap: nowrap;
}
.ecs-task-stats__no-wrap .ecs-task-stats__attachment > * {
  overflow: hidden;
  text-overflow: ellipsis;
}
.ecs-task-stats__attachment {
  overflow: hidden;
  align-items: center;
  display: inline-flex;
  gap: 4px;
}
.ecs-task-stats__horizontal {
  flex-direction: row;
}
.ecs-task-stats__horizontal-reversed {
  flex-direction: row-reverse;
}
.ecs-task-stats__vertical {
  flex-direction: column;
}
.ecs-task-stats__vertical-reversed {
  flex-direction: column-reverse;
}

.ecs-status-bar {
  align-items: stretch;
  background: #d5dbdb;
  display: inline-flex;
  height: 10px;
  opacity: 0.85;
  overflow: hidden;
  width: 100%;
}
.ecs-status-bar div:not(:first-child) {
  margin-left: 2px;
}
.ecs-status-bar__error {
  background: #d13212;
}
.ecs-status-bar__info {
  background: #0073bb;
}
.ecs-status-bar__success {
  background: #1d8102;
}

.awsui_color-text-status-info {
  color: #006ce0;
}

.awsui_color-text-status-success {
  color: #00802f;
}

.awsui_color-text-status-warning {
  color: #855900;
}

.awsui_color-text-status-error {
  color: #db0000;
}

.awsui_wrapper {
  box-sizing: border-box;
  inline-size: 100%;
  overflow-x: auto;
  position: relative;
  scrollbar-width: none;
}

.awsui_table {
  border-spacing: 0;
  box-sizing: border-box;
  inline-size: 100%;
  position: relative;
  padding-inline: 20px;
  overflow-y: hidden;
}

.awsui_table-layout-fixed {
  table-layout: fixed;
}

.awsui_table-header, .awsui_table-body {
  display: contents;
}

.awsui_header-cell {
  background: #ffffff;
  border-block-end: 1px solid #c6c6cd;
  box-sizing: border-box;
  color: #424650;
  font-weight: bold;
  position: relative;
  text-align: start;
  border-inline-start: 1px solid #0000;
  padding-block: 8px;
  padding-inline-start: 20px;
  padding-inline-end: 10px;
  resize: horizontal;
  overflow: auto;
}

.awsui_header-cell::-webkit-resizer {
  display: none;
}

.awsui_header-cell:not(:last-child) > .awsui_divider {
    position: absolute;
    outline: none;
    pointer-events: none;
    inset-inline-end: 0;
    inset-block-end: 0;
    inset-block-start: 0;
    min-block-size: 18px;
    max-block-size: calc(100% - 18px);
    margin-block: auto;
    margin-inline: auto;
    border-inline-start: 2px solid #8c8c94;
    box-sizing: border-box;
}

.awsui_header-cell-content {
  display: flex;
  justify-content: space-between;
}

.awsui_body-cell {
  border-block-end: 1px solid #ebebf0;
  border-block-start: 1px solid #0000;
  box-sizing: border-box;
  word-wrap: break-word;
  font-weight: inherit;
  text-align: start;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  box-sizing: border-box;
  margin-block-end: -2px;
  margin-block-start: -2px;
  padding-block-end: 19px;
  padding-block-start: 9px;
  padding-inline-start: 19px;
  padding-inline-end: 19px;
  order: inherit;
}

.awsui_button {
  background: #ffffff;
  color: #006ce0;
  border-color: #006ce0;
  position: relative;
  text-decoration: none;
  border-start-start-radius: 20px;
  border-start-end-radius: 20px;
  border-end-start-radius: 20px;
  border-end-end-radius: 20px;
  border-block: 2px solid;
  border-inline: 2px solid;
  padding-block: 4px;
  padding-inline: 20px;
  display: inline-block;
  cursor: pointer;
  font-weight: bold;
}

.awsui_button.awsui_button-no-text {
  padding-inline: 6px;
}

.awsui_button.awsui_button-no-text>.awsui_icon-inner {
    margin-inline-start: auto;
    margin-inline-end: auto;
    padding-block-start: 2px;
    padding-block-end: 2px;
    inset-inline: 0;
}

.awsui_header_container {
  display: flex;
  justify-content: space-between;
  flex-wrap: wrap;
  padding-inline-end: 20px;
}

.awsui_actions {
  padding-top: 15px;
}

.awsui_counter {
  color: #656871;
  font-weight: normal;
}

.awsui_page-item {
  box-sizing: border-box;
  margin-block: 4px;
  margin-inline: 4px;
  padding-block: 0;
  padding-inline: 0;
  text-align: center;
  list-style: none;
  line-height: 20px;
}

.awsui_tools-pagination {
  display: flex;
  flex-direction: row;
  margin-block: 0;
}

.awsui_page-button {
  color: #424650;
  background: #0000;
  box-sizing: border-box;
  cursor: pointer;
  line-height: inherit;
  padding-block: 0;
  padding-inline: 0;
  border-block: 2px solid #0000;
  border-inline: 2px solid #0000;
  min-inline-size: 20px;
}

.awsui_page-button-disabled {
  color: #b4b4bb;
  cursor: default;
}

.awsui_page-number {
  font-size: 14px;
  background: #0000;
  box-sizing: border-box;
  cursor: pointer;
  line-height: inherit;
  padding-block: 0;
  padding-inline: 0;
  text-align: center;
  border-block: 2px solid #0000;
  border-inline: 2px solid #0000;
  min-inline-size: 20px;
  display: inline-block;
}

.awsui_dots {
  box-sizing: border-box;
  line-height: inherit;
  padding-block: 0;
  padding-inline: 0;
  text-align: center;
  border-block: 2px solid #0000;
  border-inline: 2px solid #0000;
  min-inline-size: 20px;
  display: inline-block;
}

.awsui_page-number-active {
  font-weight: bold;
}

.awsui_no-rows {
  margin: 12px auto 12px auto;
  display: table;
  color: #0f141a;
  font-weight: bold;
}
</style>`;
}

export function vertical(size: "s" | "m" | "l", ...inner: string[]): string {
  const items = inner.map((inner) => `<div class="awsui_child">${inner}</div>`);
  return `<div class="awsui_vertical awsui_vertical-${size}">${items.join("")}</div>`;
}

export function horizontal(
  size: "xs" | "s" | "m" | "l",
  ...inner: string[]
): string {
  const items = inner.map((inner) => `<div class="awsui_child">${inner}</div>`);
  return `<div class="awsui_horizontal awsui_horizontal-${size}">${items.join("")}</div>`;
}

export function list(...inner: string[]): string {
  const items = inner.map((inner) => `<div role="listitem">${inner}</div>`);
  return `<div role="list">${items.join("")}</div>`;
}

export function contentWrapper(
  border: boolean,
  header: string,
  inner: string,
  padding: boolean = true,
  actions: string[] = [],
): string {
  return (
    `<div class="awsui_content-wrapper ${border ? "awsui_border" : ""}">` +
    `<div class="awsui_header_container">` +
    `<div class="awsui_title">` +
    `<div class="awsui_header awsui_with-paddings">` +
    heading("h2", header) +
    `</div>` +
    `</div>` +
    `<div class="awsui_actions awsui_horizontal awsui_horizontal-xs">` +
    actions.join("") +
    `</div>` +
    `</div>` +
    `<div class="awsui_content">` +
    `<div class="awsui_content-inner ${padding ? "awsui_with-paddings" : ""} awsui_with-header">` +
    inner +
    `</div>` +
    `</div>` +
    `</div>`
  );
}

export function heading(typ: "h2" | "h3" | "h4", inner: string): string {
  return `<${typ} class="awsui_heading">${inner}</${typ}>`;
}

export function columns(...inner: string[]): string {
  if (!inner.length) {
    throw new Error("Need at least one column");
  }

  const items = [
    `<div class="awsui_item awsui_first-column">${inner[0]}</div>`,
    ...inner
      .slice(1)
      .filter((inner) => inner.length > 0)
      .map((inner) => `<div class="awsui_item">${inner}</div>`),
  ];

  return (
    `<div class="awsui_css-grid" style="grid-template-columns: repeat(${inner.length},minmax(0px, 1fr));">` +
    items.join("") +
    `</div>`
  );
}

export function keyValue(key: string, inner: string): string {
  return `<div><div class="awsui_key-label">${key}</div><div>${inner}</div></div>`;
}

export function tabs(
  name: string,
  checkedRadios: { [name: string]: string | undefined },
  ...inner: { header: string; inner: string }[]
): string {
  const ids = inner.map((_, i) => `${name}${i}`);
  const checked = checkedRadios[name] ?? ids[0];

  const radios = ids.map(
    (id, i) =>
      `<input type="radio" class="tab-radio-${i}" id="${id}" name="${name}" ${id === checked ? "checked" : ""} />`,
  );

  const tabButtons = inner.map(
    ({ header }, i) =>
      `<li role="presentation" class="awsui_tabs-tab">` +
      `<label for="${name}${i}" class="awsui_tabs-tab-header-container awsui_tabs-tab-focusable" style="color: var(${LABEL_COLOR_IF_TAB(i)}, #424650); --after-opacity: var(${ONE_IF_TAB(i)}, 0)">` +
      `<div class="awsui_tabs-tab-link awsui_tabs-tab-focusable">` +
      `<span class="awsui_tabs-tab-label awsui_tab-label">` +
      header +
      `</span>` +
      `</div>` +
      `</label>` +
      `</li>`,
  );

  const tabContent = inner.map(
    ({ inner }, i) =>
      `<div class="awsui_tabs-content" style="display: var(${BLOCK_IF_TAB(i)}, none)">${inner}</div>`,
  );
  return (
    `<div class="awsui_tabs">` +
    radios.join("") +
    `<header class="awsui_tabs-header awsui_tabs-header-with-divider">` +
    `<div class="awsui_tabs-header-scroll-container">` +
    `<ul role="tablist" class="awsui_tabs-header-list">` +
    tabButtons.join("") +
    `</ul>` +
    `</div>` +
    `</header>` +
    `<div class="awsui_tabs-content-wrapper">` +
    tabContent.join("") +
    `</div>` +
    `</div>`
  );
}

export function link(href: string, inner: string): string {
  return `<a class="awsui_link" href="${href}" target="_blank">${inner}${NEW_TAB_ICON}</a>`;
}

export function buttonLink(href: string, inner: string): string {
  return `<a class="awsui_button awsui_link" href="${href}" target="_blank">${inner}${NEW_TAB_ICON}</a>`;
}

const NEW_TAB_ICON =
  `<span class="awsui_icon-wrapper">&nbsp;<span class="awsui_icon" aria-label="Opens in new tab" role="img">` +
  `<span class="awsui_icon-inner awsui_icon-flex-height" style="height: 20px;">` +
  `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" focusable="false" aria-hidden="true">` +
  `<path d="M14 8.01v-6H8M14.02 2 8 8.01M6 2.01H2v12h12v-3.99" class="stroke-linejoin-round">` +
  `</path>` +
  `</svg>` +
  `</span>` +
  `</span>` +
  `</span>`;

export function taskStats(
  name: string,
  {
    desired,
    pending,
    running,
  }: {
    desired: number;
    pending: number;
    running: number;
  },
): string {
  const percent = (num: number) => (desired == 0 ? 0 : (100 * num) / desired);

  return keyValue(
    `${name} (${desired} Desired)`,
    `<div class="ecs-horizontal-attachment ecs-task-stats ecs-task-stats__horizontal ecs-task-stats__wrap ecs-horizontal-attachment-gap-xs">` +
      `<div class="ecs-horizontal-attachment__main ecs-task-stats__main">` +
      `<div data-testid="ecs-status-bar" class="ecs-status-bar">` +
      `${pending > 0 ? `<div class="ecs-status-bar__info" style="width: ${percent(pending)}%;"></div>` : ""}` +
      `${running > 0 ? `<div class="ecs-status-bar__success" style="width: ${percent(running)}%;"></div>` : ""}` +
      `</div>` +
      `</div>` +
      `<div class="ecs-horizontal-attachment__attachment ecs-task-stats__attachment">` +
      `<span class="awsui_color-text-status-info">${pending} pending</span>` +
      `<div class="awsui_text-content">|</div>` +
      `<span class="awsui_color-text-status-success">${running} running</span>` +
      `</div>` +
      `</div>`,
  );
}

export function usageIndicators(
  ...inner: { title: string; usagePercent: number }[]
): string {
  const items = inner.map(({ title, usagePercent }) => {
    const rounded = Math.round((usagePercent + Number.EPSILON) * 100) / 100;
    let bluePixels = Math.round((usagePercent / 100) * 50);
    let redPixels = 0;
    if (bluePixels > 40) {
      redPixels = bluePixels - 40;
      bluePixels = 40;
    }

    return keyValue(
      title,
      `<div>` +
        `<div style="position: relative; display: inline-block; block-size: 7px; inline-size: 50px; border: 1px solid rgb(204, 204, 204);">` +
        `<div style="position: absolute; inset-inline-start: 40px; background-color: rgba(204, 0, 0, 0.65); block-size: 7px; inline-size: 1px;"></div>` +
        `<div style="float: inline-start; inline-size: ${bluePixels}px; block-size: 100%; background-color: rgb(70, 107, 139);"></div>` +
        `<div style="float: inline-start; inline-size: ${redPixels}px; block-size: 100%; background-color: rgb(214, 57, 0);"></div>` +
        `</div>` +
        `<span class="small-font"> ${rounded}%</span>` +
        `</div>`,
    );
  });

  return horizontalAttachment(...items);
}

export function horizontalAttachment(...inner: string[]): string {
  return (
    `<div class="ecs-horizontal-attachment ecs-horizontal-attachment-gap-xs">` +
    inner.join("") +
    `</div>`
  );
}

const ANGLE_LEFT_ICON =
  `<span class="awsui_icon-inner">` +
  `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" focusable="false" aria-hidden="true">` +
  `<path d="M11 2 5 8l6 6" class="stroke-linejoin-round"></path>` +
  `</svg>` +
  `</span>`;

const ANGLE_RIGHT_ICON =
  `<span class="awsui_icon-inner">` +
  `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" focusable="false" aria-hidden="true">` +
  `<path d="m5 2 6 6-6 6" class="stroke-linejoin-round"></path>` +
  `</svg>` +
  `</span>`;

export interface TableHeader {
  name: string;
  width: number;
  compare?: (a: string, b: string) => number;
}

export function paginatedTable(
  context: Context,
  event: ControlPanelWidgetEvent,
  name: string,
  header: string,
  tableHeaders: TableHeader[],
  rows: string[][],
  ifNone?: string,
  checkedRadios?: { [name: string]: string },
  extraActions?: string[],
): string {
  const pageIDs = [...Array(Math.ceil(rows.length / 10)).keys()].map(
    (_, i) => `${name}-page-${i}`,
  );

  const pageRadioName = `${name}-page`;
  const checkedPage =
    event.checkedRadios?.[pageRadioName] &&
    pageIDs.includes(event.checkedRadios[pageRadioName])
      ? event.checkedRadios[pageRadioName]
      : pageIDs[0];

  const pageRadios = pageIDs.map(
    (pageID, i) =>
      `<input type="radio" class="page-radio-${i}" id="${pageID}" name="${pageRadioName}" ${pageID === checkedPage ? "checked" : ""} />`,
  );

  const sortColumnIDs = [...Array(tableHeaders.length)].flatMap((_, i) => [
    `${name}-sort-${i}-asc`,
    `${name}-sort-${i}-desc`,
  ]);

  const sortColumnRadioName = `${name}-sort`;
  const checkedSortColumn =
    event.checkedRadios?.[sortColumnRadioName] &&
    sortColumnIDs.includes(event.checkedRadios[sortColumnRadioName])
      ? event.checkedRadios[sortColumnRadioName]
      : sortColumnIDs[0];

  const sortColumnRadios = sortColumnIDs.map(
    (sortColumnID, i) =>
      `<input type="radio" class="sort-column-radio-${i}" id="${sortColumnID}" name="${sortColumnRadioName}" ${sortColumnID === checkedSortColumn ? "checked" : ""} />`,
  );

  const pageButtons = pageIDs.map((_, i) => {
    const pageSet: Set<number> = new Set();
    const add = (...is: number[]) =>
      is.forEach((i) =>
        i >= 0 && i < pageIDs.length && pageSet.size < 9
          ? pageSet.add(i)
          : pageSet,
      );
    add(
      0,
      i,
      pageIDs.length - 1,
      i + 1,
      i - 1,
      i + 2,
      i - 2,
      i + 3,
      i - 3,
      i + 4,
      i - 4,
      i + 5,
      i - 5,
      i + 6,
      i - 6,
      i + 7,
      i - 7,
    );

    const pages: ("..." | number)[] = [...pageSet].sort((a, b) => a - b);

    if (pages.length > 1 && !pageSet.has(1)) {
      // skipped some records on the left
      pages[1] = "...";
    }

    if (pages.length > 1 && !pageSet.has(pageIDs.length - 2)) {
      // skipped some records on the right
      pages[pages.length - 2] = "...";
    }

    return pages.map((item) =>
      item === "..."
        ? `<li class="awsui_page-item"><span class="awsui_dots">...</span></li>`
        : `<li class="awsui_page-item"><label for="${pageIDs[item]}" class="awsui_page-number ${item == i ? "awsui_page-number-active" : ""}">${item + 1}</label></li>`,
    );
  });

  const pageControls = pageIDs.map(
    (_, i) =>
      `<ul class="awsui_tools-pagination">` +
      `<li class="awsui_page-item">` +
      `<label for="${pageIDs[i - 1]}"  class="awsui_page-button ${i <= 0 ? "awsui_page-button-disabled" : ""}">` +
      ANGLE_LEFT_ICON +
      `</label>` +
      `</li>` +
      pageButtons[i].join("\n") +
      `<li class="awsui_page-item">` +
      `<label for="${pageIDs[i + 1]}" class="awsui_page-button ${i >= pageIDs.length - 1 ? "awsui_page-button-disabled" : ""}">` +
      ANGLE_RIGHT_ICON +
      `</label>` +
      `</li>` +
      `</ul>`,
  );

  const actions =
    `<div class="awsui_actions awsui_horizontal awsui_horizontal-xs">` +
    pageIDs
      .map(
        (pageID, i) =>
          `<div style="display: var(${FLEX_IF_PAGE(i)}, none)">${pageControls[i]}</div>` +
          `<div style="display: var(${FLEX_IF_PAGE(i)}, none)">` +
          refresh(context, event, {
            ...(checkedRadios ?? {}),
            [pageRadioName]: pageID,
          }) +
          `</div>`,
      )
      .join("") +
    (extraActions ?? []).join("") +
    `</div>`;

  const headerCells = tableHeaders.map(
    ({ name: headerName }, i) =>
      `<div class="awsui_header-cell" style="min-width: 100%;">` +
      `<div class="awsui_header-cell-content">` +
      `<div class="awsui_header-cell-text">` +
      `${headerName}` +
      `</div>` +
      // show the unfilled asc if neither the desc nor the asc is selected - clicking takes us to asc
      `<label for="${name}-sort-${i}-asc" class="awsui_sorting_icon" style="color: #424650; display: var(${NONE_IF_SORT_COLUMN(i * 2 + 1)}, var(${NONE_IF_SORT_COLUMN(i * 2)}, block));">` +
      `<span class="awsui_icon-inner">` +
      `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" focusable="false" aria-hidden="true">` +
      `<path d="m8 5 4 6H4l4-6Z" class="stroke-linejoin-round"></path>` +
      `</svg>` +
      `</span>` +
      `</label>` +
      // show the filled asc if its selected - clicking takes it to desc
      `<label for="${name}-sort-${i}-desc" class="awsui_sorting_icon" style="color: #0f141a; display: var(${BLOCK_IF_SORT_COLUMN(i * 2)}, none);">` +
      `<span class="awsui_icon-inner">` +
      `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" focusable="false" aria-hidden="true">` +
      `<path d="m8 5 4 6H4l4-6Z" class="filled stroke-linejoin-round"></path>` +
      `</svg>` +
      `</span>` +
      `</label>` +
      // show the filled desc if its selected - clicking takes us to asc
      `<label for="${name}-sort-${i}-asc" class="awsui_sorting_icon" style="color: #0f141a; display: var(${BLOCK_IF_SORT_COLUMN(i * 2 + 1)}, none)">` +
      `<span class="awsui_icon-inner">` +
      `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" focusable="false" aria-hidden="true">` +
      `<path d="m8 11 4-6H4l4 6Z" class="filled stroke-linejoin-round"></path>` +
      `</svg>` +
      `</span>` +
      `</label>` +
      `</div>` +
      `<span class="awsui_divider"></span>` +
      `</div>`,
  );

  const columnIndices: number[][] = tableHeaders.flatMap((header, col) => {
    const compare = header.compare ?? ((a, b) => a.localeCompare(b));

    // an array where the first index is the first row index by this sort order, etc
    const sortedAsc = [...Array(rows.length).keys()].sort(
      (leftRow, rightRow) => {
        return compare(rows[leftRow][col], rows[rightRow][col]);
      },
    );
    const sortedDesc = [...Array(rows.length).keys()].sort(
      (leftRow, rightRow) => {
        return 0 - compare(rows[leftRow][col], rows[rightRow][col]);
      },
    );
    // we instead want an array where the first index is the index of row one by this sort order
    const lookupAsc: number[] = Array(sortedAsc.length);
    const lookupDesc: number[] = Array(sortedAsc.length);
    sortedAsc.forEach(
      (lookupIndex, sortIndex) => (lookupAsc[lookupIndex] = sortIndex),
    );
    sortedDesc.forEach(
      (lookupIndex, sortIndex) => (lookupDesc[lookupIndex] = sortIndex),
    );
    return [lookupAsc, lookupDesc];
  });

  const body = rows.length
    ? rows
        .map((row, i) => {
          const rowCells = row.map(
            (cell) => `<div class="awsui_body-cell">${cell}</div>`,
          );
          const orderVars = columnIndices
            .map(
              (rows, columnIndex) =>
                `var(${EMPTY_IF_NOT_SORT_COLUMN(columnIndex)},${rows[i]})`,
            )
            .join("");
          const displayVars = columnIndices
            .map(
              (rows, columnIndex) =>
                `var(${EMPTY_IF_NOT_SORT_COLUMN(columnIndex)},var(${CONTENTS_IF_PAGE(Math.floor(rows[i] / 10))},none))`,
            )
            .join("");
          return `<div style="order: ${orderVars}; display: ${displayVars};" class="awsui_row">${rowCells.join("")}</div>`;
        })
        .join("")
    : ``;

  const table =
    `<div class="awsui_wrapper">` +
    `<div class="awsui_table awsui_table-layout-fixed" style="display: grid; grid-template-columns: repeat(${tableHeaders.length}, minmax(max-content, 1fr));">` +
    `<div class="awsui_table-header">${headerCells.join("")}</div>` +
    `<div class="awsui_table-body">${body}</div>` +
    `</div>` +
    `${rows.length ? `` : `<span class="awsui_no-rows">${ifNone ?? `No rows`}</span>`}` +
    `</div>`;

  return (
    `<div class="awsui_paginated-table">` +
    pageRadios.join("") +
    sortColumnRadios.join("") +
    `<div class="awsui_content-wrapper awsui_border">` +
    `<div class="awsui_header_container">` +
    `<div class="awsui_title">` +
    `<div class="awsui_header awsui_with-paddings">` +
    heading("h2", header) +
    `</div>` +
    `</div>` +
    actions +
    `</div>` +
    `<div class="awsui_content">` +
    `<div class="awsui_content-inner awsui_with-header">` +
    table +
    `</div>` +
    `</div>` +
    `</div>` +
    `</div>`
  );
}

function textStatus(
  typ: "success" | "error" | "warning" | "info",
  inner: string,
): string {
  return `<span class="awsui_color-text-status-${typ}">${inner}</span>`;
}

export function ecsLastStatus(
  status:
    | "PROVISIONING"
    | "PENDING"
    | "ACTIVATING"
    | "RUNNING"
    | "DEACTIVATING"
    | "STOPPING"
    | "DEPROVISIONING"
    | "STOPPED"
    | "DELETED",
): string {
  switch (status) {
    case "PROVISIONING":
      return textStatus("info", "Provisioning");
    case "PENDING":
      return textStatus("info", "Pending");
    case "ACTIVATING":
      return textStatus("info", "Activating");
    case "RUNNING":
      return textStatus("success", "Running");
    case "DEACTIVATING":
      return textStatus("info", "Deactivating");
    case "STOPPING":
      return textStatus("info", "Stopping");
    case "DEPROVISIONING":
      return textStatus("info", "Deprovisioning");
    case "STOPPED":
      return textStatus("info", "Stopped");
    case "DELETED":
      return textStatus("info", "Deleted");
    default:
      return status;
  }
}

export function ecsDesiredStatus(
  status: "PENDING" | "RUNNING" | "STOPPED" | "DELETED",
): string {
  switch (status) {
    case "RUNNING":
      return "Running";
    case "STOPPED":
      return "Stopped";
    case "DELETED":
      return "Deleted";
    case "PENDING":
      return "Pending";
    default:
      return status;
  }
}

export function storageState(
  state:
    | "provisioning"
    | "disabled"
    | "read-only"
    | "gone"
    | "read-write"
    | "data-loss",
): string {
  switch (state) {
    case "provisioning":
      return textStatus("info", "Provisioning");
    case "disabled":
      return textStatus("warning", "Disabled");
    case "read-only":
      return textStatus("warning", "Read only");
    case "read-write":
      return textStatus("success", "Read/Write");
    case "data-loss":
      return textStatus("error", "Data loss");
    default:
      return state;
  }
}

export function healthStatus(
  status: "HEALTHY" | "UNHEALTHY" | "UNKNOWN",
): string {
  switch (status) {
    case "HEALTHY":
      return textStatus("success", "Healthy");
    case "UNHEALTHY":
      return textStatus("error", "Unhealthy");
    case "UNKNOWN":
      return "Unknown";
    default:
      return status;
  }
}

export function volumeState(
  state: "creating" | "available" | "in-use" | "deleting" | "deleted" | "error",
): string {
  switch (state) {
    case "creating":
      return textStatus("info", "Creating");
    case "available":
      return textStatus("info", "Available");
    case "in-use":
      return textStatus("success", "In-use");
    case "deleting":
      return "Deleting";
    case "deleted":
      return "Deleted";
    case "error":
      return textStatus("error", "Error");
    default:
      return state;
  }
}

export function volumeStatus(
  status: "ok" | "warning" | "impaired" | "insufficient-data" | "not-available",
): string {
  switch (status) {
    case "ok":
      return textStatus("success", "Okay");
    case "warning":
      return textStatus("warning", "Warning");
    case "impaired":
      return textStatus("error", "Impaired");
    case "insufficient-data":
      return "Insufficient data";
    case "not-available":
      return "N/A";
    default:
      return status;
  }
}

export function refresh(
  context: Context,
  event: ControlPanelWidgetEvent,
  checkedRadios?: { [name: string]: string },
): string {
  const nextEvent: ControlPanelWidgetEvent = {
    command: event.command,
    checkedRadios: {
      ...(event.checkedRadios ?? {}),
      ...checkedRadios,
    },
  };
  return (
    `<a class="awsui_button awsui_button-no-text">${REFRESH_ICON}</a>` +
    `<cwdb-action action="call" endpoint="${context.invokedFunctionArn}" display="widget">` +
    JSON.stringify(nextEvent) +
    `</cwdb-action>`
  );
}

const REFRESH_ICON =
  `<span class="awsui_icon-inner">` +
  `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" focusable="false" aria-hidden="true">` +
  `<path d="M15 0v5l-5-.04" class="stroke-linejoin-round"></path>` +
  `<path d="M15 8c0 3.87-3.13 7-7 7s-7-3.13-7-7 3.13-7 7-7c2.79 0 5.2 1.63 6.33 4"></path>` +
  `</svg>` +
  `</span>`;

export function counter(inner: string): string {
  return `<span class="awsui_counter">${inner}</span>`;
}
