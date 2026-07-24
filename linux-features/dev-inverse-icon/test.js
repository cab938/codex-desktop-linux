#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const {
  MAIN_MARKER,
  applyMainProcessPatch,
  descriptors,
} = require("./patch.js");

function rawImage(bytes, options = {}) {
  const bitmap = Buffer.from(bytes);
  return {
    bitmap,
    getScaleFactors: () => [options.scaleFactor ?? 1],
    getSize: () => ({ width: options.width ?? 1, height: options.height ?? 1 }),
    isEmpty: () => options.empty === true,
    toBitmap: () => Buffer.from(bitmap),
  };
}

function runRuntime(options = {}) {
  const sourceImages = new Map(options.sourceImages ?? []);
  const createFromPathCalls = [];
  const createFromBitmapCalls = [];
  const setIconCalls = [];
  const nativeImage = {
    createFromBitmap(bitmap, createOptions) {
      const image = rawImage(bitmap, createOptions);
      image.createdFromBitmap = true;
      createFromBitmapCalls.push({
        bitmap: Buffer.from(bitmap),
        options: { ...createOptions },
        image,
      });
      return image;
    },
    createFromPath(iconPath) {
      createFromPathCalls.push(iconPath);
      return sourceImages.get(iconPath) ?? rawImage([5, 6, 7, 255]);
    },
  };
  function BrowserWindow() {}
  BrowserWindow.prototype.setIcon = function setIcon(icon) {
    setIconCalls.push(icon);
    return "set-icon-result";
  };
  const electron = { BrowserWindow, nativeImage };
  const context = {
    Buffer,
    globalThis: null,
    process: { platform: options.platform ?? "linux" },
    require(name) {
      assert.equal(name, "electron");
      return electron;
    },
  };
  context.globalThis = context;
  const patched = applyMainProcessPatch("require(`electron`);globalThis.bundleLoaded=!0;");
  vm.runInNewContext(patched, context);
  return {
    BrowserWindow,
    context,
    createFromBitmapCalls,
    createFromPathCalls,
    nativeImage,
    setIconCalls,
  };
}

test("exports one optional main-bundle descriptor", () => {
  assert.equal(descriptors.length, 1);
  assert.equal(descriptors[0].id, "dev-inverse-icon-runtime");
  assert.equal(descriptors[0].phase, "main-bundle");
  assert.equal(descriptors[0].ciPolicy, "optional");
});

test("main-process patch is idempotent and fail-soft", () => {
  const source = "require(`electron`);globalThis.loaded=!0;";
  const patched = applyMainProcessPatch(source);
  assert.match(patched, new RegExp(MAIN_MARKER));
  assert.equal(applyMainProcessPatch(patched), patched);
  assert.equal(applyMainProcessPatch("globalThis.loaded=!0;"), "globalThis.loaded=!0;");
  assert.equal(applyMainProcessPatch(null), null);
});

test("inverts every RGB byte and preserves every alpha byte", () => {
  const iconPath = "/app/resources/icon-chatgpt.png";
  const source = rawImage(
    [
      0, 0, 0, 255,
      255, 255, 255, 127,
      10, 20, 30, 0,
    ],
    { width: 3, height: 1, scaleFactor: 2 },
  );
  const runtime = runRuntime({ sourceImages: [[iconPath, source]] });

  const inverted = runtime.nativeImage.createFromPath(iconPath);

  assert.equal(inverted.createdFromBitmap, true);
  assert.deepEqual(
    [...runtime.createFromBitmapCalls[0].bitmap],
    [
      255, 255, 255, 255,
      0, 0, 0, 127,
      245, 235, 225, 0,
    ],
  );
  assert.deepEqual(runtime.createFromBitmapCalls[0].options, {
    width: 3,
    height: 1,
    scaleFactor: 2,
  });
});

test("matches the current webview app icon path on either slash style", () => {
  const linuxPath = "/app/content/webview/assets/app-D0g8sCle.png";
  const windowsStylePath = "C:\\app\\content\\webview\\assets\\app-current.png";
  const runtime = runRuntime({
    sourceImages: [
      [linuxPath, rawImage([1, 2, 3, 255])],
      [windowsStylePath, rawImage([4, 5, 6, 255])],
    ],
  });

  runtime.nativeImage.createFromPath(linuxPath);
  runtime.nativeImage.createFromPath(windowsStylePath);

  assert.equal(runtime.createFromBitmapCalls.length, 2);
  assert.deepEqual([...runtime.createFromBitmapCalls[0].bitmap], [254, 253, 252, 255]);
  assert.deepEqual([...runtime.createFromBitmapCalls[1].bitmap], [251, 250, 249, 255]);
});

test("leaves unrelated images untouched", () => {
  const iconPath = "/app/resources/plugins/browser/icon.png";
  const source = rawImage([10, 20, 30, 40]);
  const runtime = runRuntime({ sourceImages: [[iconPath, source]] });

  assert.equal(runtime.nativeImage.createFromPath(iconPath), source);
  assert.equal(runtime.createFromBitmapCalls.length, 0);
});

test("converts matching string paths passed to BrowserWindow.setIcon", () => {
  const iconPath = "/app/content/webview/assets/app-current.png";
  const source = rawImage([0, 255, 64, 200]);
  const runtime = runRuntime({ sourceImages: [[iconPath, source]] });
  const window = new runtime.BrowserWindow();

  assert.equal(window.setIcon(iconPath), "set-icon-result");
  assert.equal(runtime.setIconCalls.length, 1);
  assert.equal(runtime.setIconCalls[0].createdFromBitmap, true);
  assert.deepEqual([...runtime.setIconCalls[0].bitmap], [255, 0, 191, 200]);
});

test("does not install the icon transform outside Linux", () => {
  const iconPath = "/app/resources/icon-chatgpt.png";
  const source = rawImage([0, 0, 0, 255]);
  const runtime = runRuntime({
    platform: "darwin",
    sourceImages: [[iconPath, source]],
  });

  assert.equal(runtime.nativeImage.createFromPath(iconPath), source);
  assert.equal(runtime.createFromBitmapCalls.length, 0);
  assert.equal(runtime.context[MAIN_MARKER], undefined);
});
