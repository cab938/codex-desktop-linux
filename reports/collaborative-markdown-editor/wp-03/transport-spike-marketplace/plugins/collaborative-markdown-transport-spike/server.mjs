import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const root = path.dirname(fileURLToPath(import.meta.url));
const stateDir = process.env.CODEX_COLLAB_MARKDOWN_SPIKE_STATE ??
  path.join(os.tmpdir(), `codex-collab-markdown-wp03-${process.getuid?.() ?? "user"}`);
const descriptorPath = path.join(stateDir, "broker.json");
const starterLock = path.join(stateDir, "starter.lock");
const adapterLogPath = path.join(stateDir, "adapters.jsonl");
const resourceUri = "ui://collaborative-markdown-transport-spike/v1/index.html";
const META_KEY = "collaborativeMarkdownTransport";

await fsPromises.mkdir(stateDir, { recursive: true, mode: 0o700 });
await fsPromises.chmod(stateDir, 0o700);

function adapterLog(event, details = {}) {
  fs.appendFileSync(adapterLogPath, `${JSON.stringify({
    at: new Date().toISOString(),
    event,
    pid: process.pid,
    ppid: process.ppid,
    ...details
  })}\n`, { encoding: "utf8", mode: 0o600 });
}

async function readDescriptor() {
  try {
    return JSON.parse(await fsPromises.readFile(descriptorPath, "utf8"));
  } catch {
    return undefined;
  }
}

async function request(descriptor, pathname, body, timeoutMs = 3000) {
  const response = await fetch(`http://127.0.0.1:${descriptor.port}${pathname}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "x-admin-token": descriptor.adminToken,
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`broker ${pathname} returned ${response.status}`);
  return response.json();
}

async function healthyDescriptor() {
  const descriptor = await readDescriptor();
  if (!descriptor) return undefined;
  try {
    const health = await request(descriptor, "/health");
    return health.generation === descriptor.generation ? descriptor : undefined;
  } catch {
    return undefined;
  }
}

async function startBroker() {
  try {
    await fsPromises.mkdir(starterLock, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    return false;
  }

  const logFd = fs.openSync(path.join(stateDir, "broker-process.log"), "a", 0o600);
  const child = spawn(process.execPath, [
    path.join(root, "broker.mjs"),
    "--state-dir",
    stateDir
  ], {
    cwd: root,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      PATH: process.env.PATH ?? "",
      NODE_ENV: "production"
    }
  });
  child.unref();
  fs.closeSync(logFd);
  adapterLog("broker-spawned", { brokerPid: child.pid });
  return true;
}

async function ensureBroker() {
  let descriptor = await healthyDescriptor();
  if (descriptor) return descriptor;

  await startBroker();
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    descriptor = await healthyDescriptor();
    if (descriptor) return descriptor;
  }

  const lockStat = await fsPromises.stat(starterLock).catch(() => undefined);
  if (lockStat && Date.now() - lockStat.mtimeMs > 8000) {
    await fsPromises.rm(starterLock, { recursive: true, force: true });
    await startBroker();
    const retryDeadline = Date.now() + 8000;
    while (Date.now() < retryDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      descriptor = await healthyDescriptor();
      if (descriptor) return descriptor;
    }
  }

  throw new Error(`shared spike broker did not become healthy in ${stateDir}`);
}

async function currentBroker() {
  return await healthyDescriptor() ?? ensureBroker();
}

async function mintTicket(documentId) {
  const descriptor = await currentBroker();
  const minted = await request(descriptor, "/mint", { documentId });
  return {
    documentId: minted.documentId,
    generation: minted.generation,
    transportMode: "websocket-preferred-mcp-bridge-fallback",
    webSocketUrl:
      `ws://127.0.0.1:${minted.port}/document/${encodeURIComponent(minted.documentId)}` +
      `?capability=${encodeURIComponent(minted.token)}`
  };
}

const initialDescriptor = await ensureBroker();
adapterLog("adapter-start", {
  brokerPid: initialDescriptor.pid,
  brokerPort: initialDescriptor.port,
  generation: initialDescriptor.generation,
  cwd: process.cwd(),
  argv: process.argv
});

const server = new McpServer({
  name: "collaborative-markdown-transport-spike",
  version: "0.3.1"
});

registerAppTool(
  server,
  "open_transport_spike",
  {
    title: "Open collaborative Markdown transport spike",
    description: "Render the disposable shared CodeMirror and Yjs transport probe.",
    inputSchema: {
      document_id: z.string().regex(/^[a-z0-9-]{1,64}$/).default("wp-03-shared")
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    },
    _meta: {
      ui: {
        resourceUri,
        visibility: ["app", "model"]
      },
      "openai/ui": {
        entrypoints: [
          { type: "thread" }
        ]
      }
    }
  },
  async ({ document_id: documentId }) => {
    const ticket = await mintTicket(documentId);
    adapterLog("render-tool", {
      documentId,
      generation: ticket.generation
    });
    return {
      content: [{
        type: "text",
        text: `Opened shared transport spike ${documentId} in generation ${ticket.generation.slice(0, 8)}.`
      }],
      structuredContent: {
        document_id: documentId,
        generation: ticket.generation,
        capability_delivery: "hidden tool-result metadata"
      },
      _meta: {
        [META_KEY]: ticket
      }
    };
  }
);

registerAppTool(
  server,
  "refresh_transport_spike",
  {
    title: "Refresh collaborative transport capability",
    description: "Mint a new UI-only capability after reconnect or generation change.",
    inputSchema: {
      document_id: z.string().regex(/^[a-z0-9-]{1,64}$/)
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    },
    _meta: {
      ui: {
        visibility: ["app"]
      }
    }
  },
  async ({ document_id: documentId }) => {
    const ticket = await mintTicket(documentId);
    adapterLog("refresh-tool", {
      documentId,
      generation: ticket.generation
    });
    return {
      content: [{ type: "text", text: "Refreshed the UI-only transport capability." }],
      structuredContent: {
        document_id: documentId,
        generation: ticket.generation
      },
      _meta: {
        [META_KEY]: ticket
      }
    };
  }
);

registerAppTool(
  server,
  "transport_spike_insert",
  {
    title: "Insert text into the shared transport spike",
    description: "Apply one server-side Yjs insertion for bidirectional transport testing.",
    inputSchema: {
      document_id: z.string().regex(/^[a-z0-9-]{1,64}$/),
      text: z.string().min(1).max(4096)
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    },
    _meta: {
      ui: {
        visibility: ["app", "model"]
      }
    }
  },
  async ({ document_id: documentId, text }) => {
    const descriptor = await currentBroker();
    const result = await request(descriptor, "/insert", { documentId, text });
    adapterLog("insert-tool", {
      documentId,
      revision: result.revision,
      characters: text.length
    });
    return {
      content: [{ type: "text", text: result.summary }],
      structuredContent: result
    };
  }
);

registerAppTool(
  server,
  "transport_spike_push",
  {
    title: "Push a merged Yjs update batch",
    description: "App-only transport for merged local Yjs updates.",
    inputSchema: {
      document_id: z.string().regex(/^[a-z0-9-]{1,64}$/),
      generation: z.string().uuid(),
      update: z.string().min(1).max(2 * 1024 * 1024),
      client_id: z.string().max(64)
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    },
    _meta: {
      ui: {
        visibility: ["app"]
      }
    }
  },
  async ({
    document_id: documentId,
    generation,
    update,
    client_id: clientId
  }) => {
    const descriptor = await currentBroker();
    const result = await request(descriptor, "/push", {
      documentId,
      generation,
      update
    });
    adapterLog("bridge-push", {
      documentId,
      generation,
      clientId,
      revision: result.revision,
      encodedBytes: update.length
    });
    return {
      content: [{ type: "text", text: "Merged Yjs update batch accepted." }],
      structuredContent: result
    };
  }
);

registerAppTool(
  server,
  "transport_spike_pull",
  {
    title: "Pull the next shared Yjs snapshot",
    description: "App-only long-poll transport for server-to-UI Yjs updates.",
    inputSchema: {
      document_id: z.string().regex(/^[a-z0-9-]{1,64}$/),
      generation: z.string().uuid(),
      after_revision: z.number().int().min(-1),
      client_id: z.string().max(64)
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    _meta: {
      ui: {
        visibility: ["app"]
      }
    }
  },
  async ({
    document_id: documentId,
    generation,
    after_revision: afterRevision,
    client_id: clientId
  }) => {
    const descriptor = await currentBroker();
    const result = await request(descriptor, "/pull", {
      documentId,
      generation,
      afterRevision
    }, 8000);
    adapterLog("bridge-pull", {
      documentId,
      generation,
      clientId,
      afterRevision,
      revision: result.revision,
      staleGeneration: result.staleGeneration ?? false,
      unchanged: result.unchanged ?? false
    });
    return {
      content: [{ type: "text", text: "Yjs bridge poll completed." }],
      structuredContent: result
    };
  }
);

registerAppTool(
  server,
  "restart_transport_spike_generation",
  {
    title: "Change transport spike broker generation",
    description: "Fence existing sockets and require the UI to rebuild from a fresh snapshot.",
    inputSchema: {
      document_id: z.string().regex(/^[a-z0-9-]{1,64}$/)
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    },
    _meta: {
      ui: {
        visibility: ["app", "model"]
      }
    }
  },
  async ({ document_id: documentId }) => {
    const descriptor = await currentBroker();
    const result = await request(descriptor, "/generation", { documentId });
    adapterLog("generation-tool", {
      documentId,
      generation: result.generation,
      previousGeneration: result.previousGeneration
    });
    return {
      content: [{
        type: "text",
        text: `Broker generation changed from ${result.previousGeneration.slice(0, 8)} to ${result.generation.slice(0, 8)}.`
      }],
      structuredContent: result
    };
  }
);

registerAppTool(
  server,
  "transport_spike_status",
  {
    title: "Read transport spike status",
    description: "Read bounded broker status and the disposable spike document.",
    inputSchema: {
      document_id: z.string().regex(/^[a-z0-9-]{1,64}$/)
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    _meta: {
      ui: {
        visibility: ["model"]
      }
    }
  },
  async ({ document_id: documentId }) => {
    const descriptor = await currentBroker();
    const result = await request(descriptor, "/status", { documentId });
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: result
    };
  }
);

registerAppResource(
  server,
  "collaborative-markdown-transport-spike-ui",
  resourceUri,
  {
    title: "Collaborative Markdown transport spike",
    description: "Disposable CodeMirror and Yjs MCP App transport probe.",
    mimeType: RESOURCE_MIME_TYPE,
    _meta: {
      ui: {
        csp: {
          connectDomains: [`ws://127.0.0.1:${initialDescriptor.port}`],
          resourceDomains: []
        }
      }
    }
  },
  async () => ({
    contents: [{
      uri: resourceUri,
      mimeType: RESOURCE_MIME_TYPE,
      text: await fsPromises.readFile(path.join(root, "dist", "mcp-app.html"), "utf8")
    }]
  })
);

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    adapterLog("adapter-signal", { signal });
    process.exit(0);
  });
}
process.on("exit", (code) => adapterLog("adapter-exit", { code }));

const transport = new StdioServerTransport();
await server.connect(transport);
