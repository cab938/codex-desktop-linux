import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import WebSocket from "ws";
import * as Y from "yjs";

const root = path.dirname(fileURLToPath(import.meta.url));

async function waitForDescriptor(stateDir) {
  const descriptorPath = path.join(stateDir, "broker.json");
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await fsPromises.readFile(descriptorPath, "utf8"));
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error("broker descriptor timeout");
}

async function request(descriptor, pathname, body) {
  const response = await fetch(`http://127.0.0.1:${descriptor.port}${pathname}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "x-admin-token": descriptor.adminToken,
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function nextMessage(socket) {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => resolve(JSON.parse(data.toString())));
    socket.once("error", reject);
  });
}

test("broker authenticates, synchronizes Yjs, and fences generations", async (context) => {
  const stateDir = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), "codex-collab-wp03-test-")
  );
  const child = spawn(process.execPath, [
    path.join(root, "broker.mjs"),
    "--state-dir",
    stateDir
  ], {
    stdio: ["ignore", "pipe", "pipe"]
  });

  context.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await fsPromises.rm(stateDir, { recursive: true, force: true });
  });

  let descriptor = await waitForDescriptor(stateDir);
  const documentId = `test-${crypto.randomUUID()}`;
  const minted = await request(descriptor, "/mint", { documentId });

  const rejected = new WebSocket(
    `ws://127.0.0.1:${descriptor.port}/document/${documentId}?capability=wrong`,
    { origin: "null" }
  );
  await new Promise((resolve) => {
    rejected.once("unexpected-response", (_request, response) => {
      assert.equal(response.statusCode, 401);
      resolve();
    });
  });

  const socket = new WebSocket(
    `ws://127.0.0.1:${descriptor.port}/document/${documentId}` +
      `?capability=${encodeURIComponent(minted.token)}`,
    { origin: "null" }
  );
  const hello = await nextMessage(socket);
  assert.equal(hello.type, "hello");
  assert.equal(hello.generation, descriptor.generation);

  const clientDoc = new Y.Doc();
  Y.applyUpdate(clientDoc, Buffer.from(hello.snapshot, "base64"));
  const clientText = clientDoc.getText("markdown");
  let clientUpdate;
  clientDoc.on("update", (update, origin) => {
    if (origin === "test") clientUpdate = update;
  });
  clientDoc.transact(() => clientText.insert(clientText.length, "\nclient edit\n"), "test");
  socket.send(JSON.stringify({
    type: "update",
    generation: hello.generation,
    update: Buffer.from(clientUpdate).toString("base64")
  }));

  await nextMessage(socket);
  const afterClient = await request(descriptor, "/status", { documentId });
  assert.match(afterClient.text, /client edit/);

  const serverUpdatePromise = nextMessage(socket);
  await request(descriptor, "/insert", { documentId, text: "\nserver edit\n" });
  const serverUpdate = await serverUpdatePromise;
  Y.applyUpdate(clientDoc, Buffer.from(serverUpdate.update, "base64"));
  assert.match(clientText.toString(), /server edit/);

  const bridgeDoc = new Y.Doc();
  const beforeBridge = await request(descriptor, "/pull", {
    documentId,
    generation: hello.generation,
    afterRevision: -1
  });
  Y.applyUpdate(bridgeDoc, Buffer.from(beforeBridge.snapshot, "base64"));
  let bridgeUpdate;
  bridgeDoc.on("update", (update, origin) => {
    if (origin === "bridge-test") bridgeUpdate = update;
  });
  bridgeDoc.transact(() => {
    bridgeDoc.getText("markdown").insert(
      bridgeDoc.getText("markdown").length,
      "\nbridge edit\n"
    );
  }, "bridge-test");
  const pushed = await request(descriptor, "/push", {
    documentId,
    generation: hello.generation,
    update: Buffer.from(bridgeUpdate).toString("base64")
  });
  assert.ok(pushed.revision > beforeBridge.revision);
  const afterBridge = await request(descriptor, "/pull", {
    documentId,
    generation: hello.generation,
    afterRevision: beforeBridge.revision
  });
  const pulledDoc = new Y.Doc();
  Y.applyUpdate(pulledDoc, Buffer.from(afterBridge.snapshot, "base64"));
  assert.match(pulledDoc.getText("markdown").toString(), /bridge edit/);

  const closePromise = new Promise((resolve) => {
    socket.once("close", (code) => resolve(code));
  });
  const changed = await request(descriptor, "/generation", { documentId });
  assert.notEqual(changed.generation, changed.previousGeneration);
  assert.equal(await closePromise, 4009);
  const stalePull = await request(descriptor, "/pull", {
    documentId,
    generation: changed.previousGeneration,
    afterRevision: afterBridge.revision
  });
  assert.equal(stalePull.staleGeneration, true);

  descriptor = JSON.parse(await fsPromises.readFile(
    path.join(stateDir, "broker.json"),
    "utf8"
  ));
  const reminted = await request(descriptor, "/mint", { documentId });
  const reconnected = new WebSocket(
    `ws://127.0.0.1:${descriptor.port}/document/${documentId}` +
      `?capability=${encodeURIComponent(reminted.token)}`,
    { origin: "null" }
  );
  const rebuilt = await nextMessage(reconnected);
  const rebuiltDoc = new Y.Doc();
  Y.applyUpdate(rebuiltDoc, Buffer.from(rebuilt.snapshot, "base64"));
  assert.match(rebuiltDoc.getText("markdown").toString(), /client edit/);
  assert.match(rebuiltDoc.getText("markdown").toString(), /server edit/);
  reconnected.close(1000);

  await request(descriptor, "/shutdown", {});
  await new Promise((resolve) => child.once("exit", resolve));
});
