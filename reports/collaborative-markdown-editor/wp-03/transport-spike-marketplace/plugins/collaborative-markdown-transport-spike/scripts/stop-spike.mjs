import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const stateDir = process.env.CODEX_COLLAB_MARKDOWN_SPIKE_STATE ??
  path.join(os.tmpdir(), `codex-collab-markdown-wp03-${process.getuid?.() ?? "user"}`);
const descriptorPath = path.join(stateDir, "broker.json");

try {
  const descriptor = JSON.parse(await fsPromises.readFile(descriptorPath, "utf8"));
  const response = await fetch(`http://127.0.0.1:${descriptor.port}/shutdown`, {
    method: "POST",
    headers: {
      "x-admin-token": descriptor.adminToken,
      "content-type": "application/json"
    },
    body: "{}",
    signal: AbortSignal.timeout(3000)
  });
  if (!response.ok) throw new Error(`broker returned ${response.status}`);
  console.log(`Stopped spike broker PID ${descriptor.pid}.`);
} catch (error) {
  if (error.code === "ENOENT") {
    console.log("No spike broker descriptor exists.");
  } else {
    throw error;
  }
}
