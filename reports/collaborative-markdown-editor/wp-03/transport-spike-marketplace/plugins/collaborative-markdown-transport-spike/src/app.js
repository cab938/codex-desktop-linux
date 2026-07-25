import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { App } from "@modelcontextprotocol/ext-apps";
import { defaultKeymap, historyKeymap } from "@codemirror/commands";
import { basicSetup } from "codemirror";
import { yCollab } from "y-codemirror.next";
import * as Y from "yjs";

import "./style.css";

const META_KEY = "collaborativeMarkdownTransport";
const REMOTE_ORIGIN = Symbol("remote");
const instanceId = crypto.randomUUID().slice(0, 8);
const elements = Object.fromEntries([
  "connection",
  "instance",
  "generation",
  "revision",
  "counters",
  "capability",
  "editor",
  "insert",
  "reconnect",
  "restart",
  "panel",
  "message"
].map((id) => [id, document.getElementById(id)]));

let ticket;
let socket;
let documentState;
let reconnecting = false;
let transportMode = "websocket";
let bridgeRun = 0;
let pendingBridgeUpdates = [];
let bridgeFlushTimer;
let sent = 0;
let received = 0;

elements.instance.textContent = instanceId;

function message(text, error = false) {
  elements.message.textContent = text;
  elements.connection.className = `badge ${error ? "error" : "pending"}`;
  if (error) {
    elements.connection.textContent = "error";
  }
}

function setConnected(hello, label = "realtime connected") {
  elements.connection.className = "badge connected";
  elements.connection.textContent = label;
  elements.generation.textContent = hello.generation.slice(0, 8);
  elements.revision.textContent = String(hello.revision);
  elements.capability.textContent = "hidden ticket received";
  elements.counters.textContent = `${sent} / ${received}`;
}

function decodeBase64(value) {
  const bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  return bytes;
}

function encodeBase64(value) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function destroyDocumentState() {
  documentState?.view.destroy();
  documentState?.doc.destroy();
  documentState = undefined;
  elements.editor.replaceChildren();
}

function buildDocumentState(snapshot, generation) {
  destroyDocumentState();
  const doc = new Y.Doc();
  Y.applyUpdate(doc, decodeBase64(snapshot), REMOTE_ORIGIN);
  const text = doc.getText("markdown");
  const undoManager = new Y.UndoManager(text);

  doc.on("update", (update, origin) => {
    if (origin === REMOTE_ORIGIN) {
      return;
    }
    if (transportMode === "websocket" && socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: "update",
        generation,
        update: encodeBase64(update)
      }));
      sent += 1;
      elements.counters.textContent = `${sent} / ${received}`;
      return;
    }
    if (transportMode === "mcp-bridge") queueBridgeUpdate(update);
  });

  const view = new EditorView({
    parent: elements.editor,
    state: EditorState.create({
      doc: text.toString(),
      extensions: [
        basicSetup,
        markdown(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.lineWrapping,
        yCollab(text, null, { undoManager })
      ]
    })
  });

  documentState = { doc, text, view, generation };
}

function queueBridgeUpdate(update) {
  pendingBridgeUpdates.push(update);
  clearTimeout(bridgeFlushTimer);
  bridgeFlushTimer = setTimeout(() => {
    flushBridgeUpdates().catch((error) => message(String(error), true));
  }, 80);
}

async function flushBridgeUpdates() {
  if (pendingBridgeUpdates.length === 0 || !ticket) return;
  const update = Y.mergeUpdates(pendingBridgeUpdates);
  pendingBridgeUpdates = [];
  const result = await app.callServerTool({
    name: "transport_spike_push",
    arguments: {
      document_id: ticket.documentId,
      generation: ticket.generation,
      update: encodeBase64(update),
      client_id: instanceId
    }
  });
  sent += 1;
  elements.revision.textContent = String(result.structuredContent?.revision ?? 0);
  elements.counters.textContent = `${sent} / ${received}`;
}

async function refreshTicket() {
  const result = await app.callServerTool({
    name: "refresh_transport_spike",
    arguments: {
      document_id: ticket?.documentId ?? "wp-03-shared"
    }
  });
  const refreshed = result?._meta?.[META_KEY];
  if (!refreshed) throw new Error("Host did not forward refresh capability metadata");
  ticket = refreshed;
  return refreshed;
}

async function connectSocket(nextTicket = ticket) {
  if (!nextTicket) return;
  ticket = nextTicket;
  socket?.close(1000, "client reconnect");
  message("Connecting authenticated loopback WebSocket…");

  const current = new WebSocket(ticket.webSocketUrl);
  socket = current;

  current.onmessage = async (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === "hello") {
      if (!documentState || documentState.generation !== payload.generation) {
        buildDocumentState(payload.snapshot, payload.generation);
      }
      setConnected(payload);
      message(`Connected through ${new URL(ticket.webSocketUrl).hostname}; token value remains hidden.`);
      elements.connection.className = "badge connected";
      elements.connection.textContent = "realtime connected";
      if (app.getHostContext()?.displayMode !== "fullscreen") {
        await app.requestDisplayMode({ mode: "fullscreen" }).catch(() => undefined);
      }
      reconnecting = false;
      return;
    }

    if (payload.type === "update" && documentState) {
      if (payload.generation !== documentState.generation) {
        current.close(4009, "stale generation");
        return;
      }
      Y.applyUpdate(documentState.doc, decodeBase64(payload.update), REMOTE_ORIGIN);
      received += 1;
      elements.revision.textContent = String(payload.revision);
      elements.counters.textContent = `${sent} / ${received}`;
    }
  };

  current.onerror = () => {
    if (transportMode === "websocket") {
      startBridge(ticket).catch((error) => message(String(error), true));
    }
  };
  current.onclose = async (event) => {
    if (
      socket !== current ||
      event.code === 1000 ||
      reconnecting ||
      transportMode === "mcp-bridge"
    ) return;
    reconnecting = true;
    message(`Socket closed (${event.code}); refreshing generation capability…`);
    try {
      await refreshTicket();
      await connectSocket(ticket);
    } catch (error) {
      reconnecting = false;
      message(error instanceof Error ? error.message : String(error), true);
    }
  };
}

async function startBridge(nextTicket = ticket) {
  ticket = nextTicket;
  transportMode = "mcp-bridge";
  socket?.close(1000, "switching to MCP bridge");
  const run = ++bridgeRun;
  let afterRevision = -1;
  message("Direct loopback WebSocket blocked; starting host-authenticated MCP bridge…");

  while (run === bridgeRun && transportMode === "mcp-bridge") {
    const result = await app.callServerTool({
      name: "transport_spike_pull",
      arguments: {
        document_id: ticket.documentId,
        generation: ticket.generation,
        after_revision: afterRevision,
        client_id: instanceId
      }
    });
    const pulled = result.structuredContent;
    if (pulled?.staleGeneration) {
      const refreshed = await refreshTicket();
      ticket = refreshed;
      afterRevision = -1;
      destroyDocumentState();
      continue;
    }
    if (!pulled?.snapshot) throw new Error("Bridge pull omitted its Yjs snapshot");
    if (!documentState || documentState.generation !== pulled.generation) {
      buildDocumentState(pulled.snapshot, pulled.generation);
    } else if (!pulled.unchanged) {
      Y.applyUpdate(
        documentState.doc,
        decodeBase64(pulled.snapshot),
        REMOTE_ORIGIN
      );
      received += 1;
    }
    afterRevision = pulled.revision;
    setConnected(pulled, "MCP bridge connected");
    elements.message.textContent =
      "WebSocket was blocked by the iframe; merged Yjs batches use app-only MCP tools.";
    if (app.getHostContext()?.displayMode !== "fullscreen") {
      await app.requestDisplayMode({ mode: "fullscreen" }).catch(() => undefined);
    }
  }
}

const app = new App(
  { name: "collaborative-markdown-transport-spike-ui", version: "0.3.1" },
  {},
  { strict: true }
);

app.ontoolresult = (result) => {
  const nextTicket = result?._meta?.[META_KEY];
  if (!nextTicket) {
    message("Tool result arrived without hidden transport metadata.", true);
    return;
  }
  connectSocket(nextTicket).catch((error) => message(String(error), true));
};

app.onhostcontextchanged = (context) => {
  if (context.displayMode) {
    elements.message.textContent = `Host display mode: ${context.displayMode}`;
  }
};

await app.connect();
message("MCP Apps bridge connected; waiting for render-tool metadata.");

elements.insert.addEventListener("click", async () => {
  const result = await app.callServerTool({
    name: "transport_spike_insert",
    arguments: {
      document_id: ticket?.documentId ?? "wp-03-shared",
      text: `\nServer update from UI ${instanceId} at ${new Date().toISOString()}\n`
    }
  });
  elements.message.textContent = result.structuredContent?.summary ?? "Server edit requested.";
});

elements.reconnect.addEventListener("click", () => {
  if (transportMode === "mcp-bridge") {
    bridgeRun += 1;
    refreshTicket()
      .then((refreshed) => startBridge(refreshed))
      .catch((error) => message(String(error), true));
  } else {
    socket?.close(4010, "manual reconnect");
  }
});

elements.restart.addEventListener("click", async () => {
  await app.callServerTool({
    name: "restart_transport_spike_generation",
    arguments: {
      document_id: ticket?.documentId ?? "wp-03-shared"
    }
  });
});

elements.panel.addEventListener("click", async () => {
  const result = await app.requestDisplayMode({ mode: "fullscreen" });
  elements.message.textContent = `Host granted ${result.mode}.`;
});

window.addEventListener("beforeunload", () => {
  bridgeRun += 1;
  clearTimeout(bridgeFlushTimer);
  socket?.close(1000, "iframe unload");
  destroyDocumentState();
});
