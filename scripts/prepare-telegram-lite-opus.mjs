import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const generatedPath = "node_modules/libopus-wasm/dist/generated/libopus.generated.mjs";
const wasmPath = "workers/telegram-lite/vendor/libopus.wasm";
const expectedHash = "a997045d6683cf7807796defce623d06449df9e39f65a66ba31a9ebacaf6b0d2";
const importLine = 'import opusWorkerModule from "../../../../workers/telegram-lite/vendor/libopus.wasm";\n';
const marker = "async function Module(moduleArg={}){";
const replacement = `${marker}moduleArg.instantiateWasm??=((imports,receiveInstance)=>{const instance=new WebAssembly.Instance(opusWorkerModule,imports);receiveInstance(instance,opusWorkerModule);return instance.exports});`;

const wasm = await readFile(wasmPath);
const hash = createHash("sha256").update(wasm).digest("hex");
if (hash !== expectedHash) throw new Error(`Unexpected libopus.wasm hash: ${hash}`);

let generated = await readFile(generatedPath, "utf8");
if (!generated.startsWith(importLine)) {
  if (!generated.includes(marker)) throw new Error("libopus generated module marker not found");
  generated = importLine + generated.replace(marker, replacement);
  await writeFile(generatedPath, generated);
}

console.log("Prepared libopus-wasm for Cloudflare Workers static WASM loading.");
