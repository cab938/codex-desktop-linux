"use strict";

const MAIN_MARKER = "codexLinuxDevInverseIconInstalled";

function runtimeSource() {
  return [
    `;(()=>{if(process.platform!==\`linux\`||globalThis.${MAIN_MARKER})return;`,
    `let e;try{e=require(\`electron\`)}catch{return}`,
    `let n=e?.nativeImage;if(n==null||typeof n.createFromPath!==\`function\`||typeof n.createFromBitmap!==\`function\`)return;`,
    `let r=n.createFromPath.bind(n);`,
    `function codexLinuxDevInverseIconPath(e){if(typeof e!==\`string\`)return!1;let n=e.replaceAll(\`\\\\\`,\`/\`);return/(?:^|\\/)icon-chatgpt\\.png$/i.test(n)||/\\/content\\/webview\\/assets\\/app-[^/]+\\.png$/i.test(n)}`,
    `function codexLinuxDevInverseIconImage(e){try{if(e==null||e.isEmpty?.())return e;let r=e.getSize?.(),i=e.toBitmap?.();if(r==null||!Number.isInteger(r.width)||!Number.isInteger(r.height)||r.width<1||r.height<1||!Buffer.isBuffer(i)||i.length!==r.width*r.height*4)return e;let o=Buffer.from(i);for(let e=0;e<o.length;e+=4)o[e]=255-o[e],o[e+1]=255-o[e+1],o[e+2]=255-o[e+2];let t={width:r.width,height:r.height},c=e.getScaleFactors?.()?.[0];Number.isFinite(c)&&c>0&&(t.scaleFactor=c);let l=n.createFromBitmap(o,t);return l==null||l.isEmpty?.()?e:l}catch{return e}}`,
    `n.createFromPath=function(e){let n=r(e);return codexLinuxDevInverseIconPath(e)?codexLinuxDevInverseIconImage(n):n};`,
    `let i=e?.BrowserWindow?.prototype?.setIcon;if(typeof i===\`function\`)e.BrowserWindow.prototype.setIcon=function(e){if(codexLinuxDevInverseIconPath(e)){let n=codexLinuxDevInverseIconImage(r(e));if(n!=null&&!n.isEmpty?.())return i.call(this,n)}return i.call(this,e)};`,
    `globalThis.${MAIN_MARKER}=!0;})();`,
  ].join("");
}

function applyMainProcessPatch(source) {
  if (typeof source !== "string") {
    console.warn("WARN: Main bundle source is not a string - skipping dev inverse icon patch");
    return source;
  }
  if (source.includes(MAIN_MARKER)) {
    return source;
  }
  if (!source.includes("require(")) {
    console.warn("WARN: Could not find CommonJS runtime in main bundle - skipping dev inverse icon patch");
    return source;
  }
  return runtimeSource() + source;
}

const descriptors = [
  {
    id: "dev-inverse-icon-runtime",
    phase: "main-bundle",
    order: 20_902,
    ciPolicy: "optional",
    apply: applyMainProcessPatch,
  },
];

module.exports = {
  MAIN_MARKER,
  applyMainProcessPatch,
  descriptors,
  runtimeSource,
};
