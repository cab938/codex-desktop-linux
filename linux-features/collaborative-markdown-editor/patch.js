"use strict";

const PLUGIN_NAME = "collaborative-markdown-editor";

function findMatchingBracket(source, openIndex) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = openIndex; index < source.length; index += 1) {
    const character = source[index];
    if (quote != null) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === "\"" || character === "`") {
      quote = character;
    } else if (character === "[") {
      depth += 1;
    } else if (character === "]") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function findBundledPluginGateArray(source) {
  let markerIndex = source.indexOf(".computerUse");
  while (markerIndex !== -1) {
    const openIndex = source.lastIndexOf("[", markerIndex);
    const closeIndex =
      openIndex === -1 ? -1 : findMatchingBracket(source, openIndex);
    if (closeIndex !== -1 && markerIndex < closeIndex) {
      const text = source.slice(openIndex + 1, closeIndex);
      if (
        text.includes("name:") &&
        text.includes("installWhenMissing") &&
        /(?:isEnabled|isAvailable):/.test(text)
      ) {
        return {
          start: openIndex + 1,
          end: closeIndex,
          text,
        };
      }
    }
    markerIndex = source.indexOf(
      ".computerUse",
      markerIndex + ".computerUse".length,
    );
  }
  return null;
}

function findAlwaysOnDescriptor(pluginGateArray) {
  const nameExpression =
    "(?:[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)?|`[^`]+`|\"[^\"]+\"|'[^']+')";
  const pattern = new RegExp(
    String.raw`\{name:(${nameExpression}),(isEnabled|isAvailable):\(\)=>!0\}`,
    "g",
  );
  let lastMatch = null;
  for (const match of pluginGateArray.text.matchAll(pattern)) {
    lastMatch = match;
  }
  return lastMatch;
}

function applyCollaborativeMarkdownPluginGate(currentSource) {
  const pluginGateArray = findBundledPluginGateArray(currentSource);
  if (pluginGateArray == null) {
    if (currentSource.includes(".computerUse")) {
      throw new Error(
        "Required Collaborative Markdown plugin gate patch failed: " +
          "could not find bundled plugin descriptor array",
      );
    }
    return currentSource;
  }
  if (
    new RegExp(
      String.raw`\{name:(?:\`${PLUGIN_NAME}\`|"${PLUGIN_NAME}"|'${PLUGIN_NAME}'),(?:isEnabled|isAvailable):`,
    ).test(pluginGateArray.text)
  ) {
    return currentSource;
  }
  const insertion = findAlwaysOnDescriptor(pluginGateArray);
  if (insertion == null) {
    throw new Error(
      "Required Collaborative Markdown plugin gate patch failed: " +
        "could not find descriptor insertion point",
    );
  }
  const availabilityProperty = insertion[2];
  const descriptor =
    `{name:\`${PLUGIN_NAME}\`,${availabilityProperty}:` +
    `({platform:e})=>e===\`linux\`},`;
  const insertionIndex = pluginGateArray.start + insertion.index;
  return (
    currentSource.slice(0, insertionIndex) +
    descriptor +
    currentSource.slice(insertionIndex)
  );
}

const descriptors = [
  {
    id: "collaborative-markdown-editor-plugin-gate",
    phase: "main-bundle",
    order: 156,
    ciPolicy: "required-upstream",
    apply: applyCollaborativeMarkdownPluginGate,
  },
];

module.exports = {
  PLUGIN_NAME,
  applyCollaborativeMarkdownPluginGate,
  descriptors,
};
