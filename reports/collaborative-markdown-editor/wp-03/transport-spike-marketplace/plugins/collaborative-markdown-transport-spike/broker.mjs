import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { WebSocketServer } from "ws";
import * as Y from "yjs";

const stateArg = process.argv.indexOf("--state-dir");
if (stateArg === -1 || !process.argv[stateArg + 1]) {
  throw new Error("--state-dir is required");
}

const stateDir = path.resolve(process.argv[stateArg + 1]);
const descriptorPath = path.join(stateDir, "broker.json");
const starterLock = path.join(stateDir, "starter.lock");
const eventLogPath = path.join(stateDir, "broker.jsonl");
const adminToken = crypto.randomBytes(32).toString("base64url");
let generation = crypto.randomUUID();
let revision = 0;
let shuttingDown = false;
const capabilities = new Map();
const clients = new Set();
const documents = new Map();
const revisionWaiters = new Map();

await fsPromises.mkdir(stateDir, { recursive: true, mode: 0o700 });
await fsPromises.chmod(stateDir, 0o700);

function log(event, details = {}) {
  fs.appendFileSync(eventLogPath, `${JSON.stringify({
    at: new Date().toISOString(),
    event,
    pid: process.pid,
    generation,
    ...details
  })}\n`, { encoding: "utf8", mode: 0o600 });
}

function documentFor(documentId) {
  let doc = documents.get(documentId);
  if (!doc) {
    doc = new Y.Doc();
    doc.getText("markdown").insert(
      0,
      "# WP-03 transport spike\n\nEdit this Markdown from CodeMirror or an MCP server tool.\n"
    );
    documents.set(documentId, doc);
    doc.on("update", (update) => {
      revision += 1;
      const message = JSON.stringify({
        type: "update",
        generation,
        revision,
        update: Buffer.from(update).toString("base64")
      });
      for (const client of clients) {
        if (client.documentId === documentId && client.socket.readyState === 1) {
          client.socket.send(message);
        }
      }
      log("document-update", { documentId, revision, bytes: update.byteLength });
      const waiters = revisionWaiters.get(documentId);
      if (waiters) {
        revisionWaiters.delete(documentId);
        for (const resolve of waiters) resolve();
      }
    });
  }
  return doc;
}

async function waitForRevision(documentId, afterRevision, timeoutMs = 5000) {
  if (revision > afterRevision) return;
  await new Promise((resolve) => {
    let waiters = revisionWaiters.get(documentId);
    if (!waiters) {
      waiters = new Set();
      revisionWaiters.set(documentId, waiters);
    }
    const finish = () => {
      clearTimeout(timer);
      waiters.delete(finish);
      if (waiters.size === 0) revisionWaiters.delete(documentId);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    waiters.add(finish);
  });
}

function isLoopback(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function acceptedOrigin(origin) {
  if (origin === "null") return true;
  try {
    const url = new URL(origin);
    return url.protocol === "https:" && (
      url.hostname === "chatgpt.com" ||
      url.hostname.endsWith(".openai.com") ||
      url.hostname.endsWith(".oaiusercontent.com") ||
      url.hostname.endsWith(".oaistatic.com")
    );
  } catch {
    return false;
  }
}

function jsonResponse(response, status, body) {
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": encoded.byteLength,
    "cache-control": "no-store"
  });
  response.end(encoded);
}

async function readJson(request, limit = 32 * 1024) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.byteLength;
    if (bytes > limit) throw new Error("request too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function authorized(request) {
  return request.headers["x-admin-token"] === adminToken;
}

async function writeDescriptor(server) {
  const address = server.address();
  const descriptor = {
    schemaVersion: 1,
    pid: process.pid,
    port: address.port,
    adminToken,
    generation,
    createdAt: new Date().toISOString()
  };
  const temporary = `${descriptorPath}.${process.pid}.tmp`;
  await fsPromises.writeFile(temporary, `${JSON.stringify(descriptor, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  await fsPromises.rename(temporary, descriptorPath);
  await fsPromises.chmod(descriptorPath, 0o600);
}

const server = http.createServer(async (request, response) => {
  if (!isLoopback(request.socket.remoteAddress)) {
    jsonResponse(response, 403, { error: "loopback only" });
    return;
  }
  if (!authorized(request)) {
    jsonResponse(response, 401, { error: "unauthorized" });
    return;
  }

  try {
    const url = new URL(request.url, "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/health") {
      jsonResponse(response, 200, {
        ok: true,
        generation,
        pid: process.pid,
        connections: clients.size
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/mint") {
      const { documentId = "wp-03-shared" } = await readJson(request);
      documentFor(documentId);
      const token = crypto.randomBytes(32).toString("base64url");
      capabilities.set(token, {
        documentId,
        generation,
        expiresAt: Date.now() + 60 * 60 * 1000
      });
      log("capability-minted", { documentId });
      jsonResponse(response, 200, {
        documentId,
        generation,
        token,
        port: server.address().port
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/insert") {
      const { documentId = "wp-03-shared", text = "" } = await readJson(request);
      const ytext = documentFor(documentId).getText("markdown");
      ytext.insert(ytext.length, String(text).slice(0, 4096));
      jsonResponse(response, 200, {
        ok: true,
        documentId,
        generation,
        revision,
        summary: `Inserted ${Math.min(String(text).length, 4096)} characters at revision ${revision}.`
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/push") {
      const {
        documentId = "wp-03-shared",
        generation: clientGeneration,
        update
      } = await readJson(request, 2 * 1024 * 1024);
      if (clientGeneration !== generation) {
        jsonResponse(response, 409, {
          error: "stale_generation",
          generation
        });
        return;
      }
      const decoded = Buffer.from(String(update), "base64");
      if (decoded.byteLength === 0 || decoded.byteLength > 1024 * 1024) {
        jsonResponse(response, 400, { error: "invalid_update" });
        return;
      }
      Y.applyUpdate(documentFor(documentId), decoded, "mcp-bridge");
      jsonResponse(response, 200, {
        ok: true,
        documentId,
        generation,
        revision
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/pull") {
      const {
        documentId = "wp-03-shared",
        generation: clientGeneration,
        afterRevision = -1
      } = await readJson(request);
      if (clientGeneration !== generation) {
        jsonResponse(response, 200, {
          staleGeneration: true,
          generation,
          revision
        });
        return;
      }
      const doc = documentFor(documentId);
      await waitForRevision(documentId, Number(afterRevision), 5000);
      jsonResponse(response, 200, {
        documentId,
        generation,
        revision,
        unchanged: revision <= Number(afterRevision),
        snapshot: Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64")
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/generation") {
      const previousGeneration = generation;
      generation = crypto.randomUUID();
      capabilities.clear();
      for (const waiters of revisionWaiters.values()) {
        for (const resolve of waiters) resolve();
      }
      revisionWaiters.clear();
      await writeDescriptor(server);
      for (const client of clients) {
        client.socket.close(4009, "broker generation changed");
      }
      log("generation-changed", { previousGeneration });
      jsonResponse(response, 200, { ok: true, generation, previousGeneration });
      return;
    }

    if (request.method === "POST" && url.pathname === "/status") {
      const { documentId = "wp-03-shared" } = await readJson(request);
      const doc = documentFor(documentId);
      jsonResponse(response, 200, {
        documentId,
        generation,
        revision,
        connections: [...clients].filter((client) => client.documentId === documentId).length,
        text: doc.getText("markdown").toString()
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/shutdown") {
      jsonResponse(response, 200, { ok: true });
      setImmediate(() => shutdown("admin"));
      return;
    }

    jsonResponse(response, 404, { error: "not found" });
  } catch (error) {
    jsonResponse(response, 400, {
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

const webSockets = new WebSocketServer({
  noServer: true,
  maxPayload: 1024 * 1024,
  perMessageDeflate: false
});

server.on("upgrade", (request, socket, head) => {
  if (!isLoopback(request.socket.remoteAddress)) {
    socket.destroy();
    return;
  }

  const url = new URL(request.url, "http://127.0.0.1");
  const match = /^\/document\/([^/]+)$/.exec(url.pathname);
  const token = url.searchParams.get("capability");
  const capability = token ? capabilities.get(token) : undefined;
  const documentId = match ? decodeURIComponent(match[1]) : undefined;

  if (
    !match ||
    !capability ||
    capability.expiresAt < Date.now() ||
    capability.generation !== generation ||
    capability.documentId !== documentId ||
    !acceptedOrigin(request.headers.origin)
  ) {
    log("websocket-rejected", {
      reason: !acceptedOrigin(request.headers.origin) ? "origin" : "capability",
      origin: request.headers.origin ?? null,
      documentId: documentId ?? null
    });
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  webSockets.handleUpgrade(request, socket, head, (webSocket) => {
    webSockets.emit("connection", webSocket, request, capability);
  });
});

webSockets.on("connection", (socket, request, capability) => {
  const client = { socket, documentId: capability.documentId };
  clients.add(client);
  const doc = documentFor(capability.documentId);
  socket.send(JSON.stringify({
    type: "hello",
    documentId: capability.documentId,
    generation,
    revision,
    snapshot: Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64")
  }));
  log("websocket-connected", {
    documentId: capability.documentId,
    origin: request.headers.origin ?? null,
    connections: clients.size
  });

  socket.on("message", (data) => {
    try {
      const message = JSON.parse(data.toString());
      if (message.type !== "update" || message.generation !== generation) {
        socket.close(4009, "stale generation");
        return;
      }
      const update = Buffer.from(message.update, "base64");
      if (update.byteLength > 1024 * 1024) {
        socket.close(1009, "update too large");
        return;
      }
      Y.applyUpdate(doc, update, socket);
    } catch {
      socket.close(1007, "invalid update");
    }
  });

  socket.on("close", () => {
    clients.delete(client);
    log("websocket-closed", {
      documentId: capability.documentId,
      connections: clients.size
    });
  });
});

async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("broker-shutdown", { reason });
  for (const client of clients) client.socket.close(1001, "broker shutdown");
  await new Promise((resolve) => server.close(resolve));
  try {
    const descriptor = JSON.parse(await fsPromises.readFile(descriptorPath, "utf8"));
    if (descriptor.pid === process.pid) await fsPromises.unlink(descriptorPath);
  } catch {
    // Descriptor was already replaced or removed.
  }
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => shutdown(signal));
}

server.listen(0, "127.0.0.1", async () => {
  await writeDescriptor(server);
  await fsPromises.rm(starterLock, { recursive: true, force: true });
  log("broker-ready", {
    port: server.address().port,
    stateDir,
    platform: os.platform()
  });
});
