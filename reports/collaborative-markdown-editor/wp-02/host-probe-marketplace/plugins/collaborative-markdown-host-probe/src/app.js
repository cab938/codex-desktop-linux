import { App } from "@modelcontextprotocol/ext-apps";
import "./style.css";

const bridgeStatus = document.querySelector("#bridge-status");
const hostContext = document.querySelector("#host-context");
const modeResult = document.querySelector("#mode-result");
const processContext = document.querySelector("#process-context");
const refreshProcess = document.querySelector("#refresh-process");

function renderHostContext(context) {
  hostContext.replaceChildren();
  const entries = [
    ["displayMode", context?.displayMode],
    ["theme", context?.theme],
    ["locale", context?.locale],
    ["platform", context?.platform],
    ["userAgent", context?.userAgent],
    ["maxWidth", context?.containerDimensions?.maxWidth],
    ["maxHeight", context?.containerDimensions?.maxHeight]
  ];
  for (const [label, value] of entries) {
    const term = document.createElement("dt");
    term.textContent = label;
    const detail = document.createElement("dd");
    detail.textContent = value == null ? "not supplied" : String(value);
    hostContext.append(term, detail);
  }
}

function renderToolResult(result) {
  const text = result?.content?.find((item) => item.type === "text")?.text;
  if (text) {
    processContext.textContent = text;
  }
}

const app = new App({
  name: "Collaborative Markdown Host Probe",
  version: "0.1.0"
});

app.ontoolresult = renderToolResult;
app.onhostcontextchanged = renderHostContext;

try {
  await app.connect();
  bridgeStatus.textContent = "MCP Apps bridge connected.";
  bridgeStatus.dataset.connected = "true";
  renderHostContext(app.getHostContext?.());
} catch (error) {
  bridgeStatus.textContent = `Bridge connection failed: ${error.message}`;
  bridgeStatus.dataset.connected = "false";
}

async function requestMode(mode) {
  const requestDisplayMode = window.openai?.requestDisplayMode;
  if (typeof requestDisplayMode !== "function") {
    modeResult.textContent = JSON.stringify({
      requested: mode,
      error: "window.openai.requestDisplayMode is unavailable"
    }, null, 2);
    return;
  }
  try {
    const granted = await requestDisplayMode({ mode });
    modeResult.textContent = JSON.stringify({ requested: mode, granted }, null, 2);
  } catch (error) {
    modeResult.textContent = JSON.stringify({
      requested: mode,
      error: error.message
    }, null, 2);
  }
}

for (const button of document.querySelectorAll("[data-mode]")) {
  button.addEventListener("click", () => requestMode(button.dataset.mode));
}

refreshProcess.addEventListener("click", async () => {
  processContext.textContent = "Calling probe_process_context…";
  try {
    renderToolResult(await app.callServerTool({
      name: "probe_process_context",
      arguments: { source: "ui" }
    }));
  } catch (error) {
    processContext.textContent = `Tool call failed: ${error.message}`;
  }
});
