"use strict";

const {
  webviewAssetPatch,
} = require("../../../../descriptor.js");
const { applyLinuxFastModeModelGuardPatch } = require("../../../../impl/webview/index.js");

module.exports = [
  webviewAssetPatch({
    id: "linux-fast-mode-model-guard",
    phase: "webview-asset",
    order: 1040,
    ciPolicy: "required-upstream",
    // The current upstream app keeps the service-tier helpers in app-initial.
    // They are already optional-chain guarded, so a byte-identical match is
    // the expected result unless an unsafe lookup reappears.
    pattern: /^app-initial-.*\.js$/,
    missingDescription: "fast-mode/service-tier availability bundle",
    skipDescription: "fast-mode model guard patch",
    apply: applyLinuxFastModeModelGuardPatch,
  }),
];
