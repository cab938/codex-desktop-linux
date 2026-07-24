import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import process from "node:process";
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
const resourceUri = "ui://collaborative-markdown-host-probe/v1/index.html";
const logPath = process.env.CODEX_COLLAB_MARKDOWN_PROBE_LOG ??
  "/tmp/codex-collaborative-markdown-host-probe.log";
const startedAt = new Date().toISOString();
const processId = process.pid;

function selectedEnvironment() {
  return Object.fromEntries([
    "CODEX_HOME",
    "PLUGIN_ROOT",
    "PLUGIN_DATA",
    "PWD",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_RUNTIME_DIR",
    "XDG_STATE_HOME"
  ].map((key) => [key, process.env[key] ?? null]));
}

function appendEvent(event, details = {}) {
  fs.appendFileSync(logPath, `${JSON.stringify({
    at: new Date().toISOString(),
    event,
    pid: processId,
    ppid: process.ppid,
    cwd: process.cwd(),
    argv: process.argv,
    environment: selectedEnvironment(),
    ...details
  })}\n`, "utf8");
}

function processContext(source) {
  return {
    source,
    pid: processId,
    ppid: process.ppid,
    started_at: startedAt,
    cwd: process.cwd(),
    argv: process.argv,
    environment: selectedEnvironment()
  };
}

appendEvent("process-start");
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    appendEvent("signal", { signal });
    process.exit(0);
  });
}
process.on("exit", (code) => appendEvent("process-exit", { code }));

const server = new McpServer({
  name: "collaborative-markdown-host-probe",
  version: "0.1.0"
});

registerAppTool(
  server,
  "open_host_probe",
  {
    title: "Collaborative Markdown Host Probe",
    description: "Open the Codex Desktop host-contract probe.",
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
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
  async () => {
    const context = processContext("tool");
    appendEvent("tool-call", { tool: "open_host_probe" });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(context, null, 2)
        }
      ],
      structuredContent: context
    };
  }
);

registerAppTool(
  server,
  "probe_process_context",
  {
    title: "Read host-probe process context",
    description: "Return bounded, non-secret process and environment context.",
    inputSchema: {
      source: z.string().max(40).optional()
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    _meta: {
      ui: {
        visibility: ["app", "model"]
      }
    }
  },
  async ({ source = "unknown" }) => {
    const context = processContext(source);
    appendEvent("tool-call", { tool: "probe_process_context", source });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(context, null, 2)
        }
      ],
      structuredContent: context
    };
  }
);

registerAppResource(
  server,
  "collaborative-markdown-host-probe-ui",
  resourceUri,
  {
    title: "Collaborative Markdown Host Probe UI",
    description: "Disposable MCP App used to verify Codex Desktop placement.",
    mimeType: RESOURCE_MIME_TYPE,
    _meta: {
      ui: {
        csp: {
          connectDomains: [],
          resourceDomains: []
        }
      }
    }
  },
  async () => {
    appendEvent("resource-read", { resourceUri });
    const html = await fsPromises.readFile(
      path.join(root, "dist", "mcp-app.html"),
      "utf8"
    );
    return {
      contents: [
        {
          uri: resourceUri,
          mimeType: RESOURCE_MIME_TYPE,
          text: html
        }
      ]
    };
  }
);

appendEvent("transport-connect");
const transport = new StdioServerTransport();
await server.connect(transport);
