// One-time builder for the on-device ICD-10 embedding index:  npm run build-icd-index
// Uses the configured backend's embedding model; caches vectors to data/icd10.index.bin.
import { getProvider } from "./backend.js";
import { buildIndex } from "./icd.js";

const t0 = Date.now();
const provider = await getProvider();
console.log(`Backend: ${provider.name}\nLoading models ...`);
await provider.init();
console.log("Embedding ICD-10 descriptions (one-time) ...");
await buildIndex(provider, (done, total) => {
  if (done % 640 === 0 || done === total) process.stdout.write(`\r  ${done}/${total}`);
});
await provider.close();
console.log(`\nDone in ${Math.round((Date.now() - t0) / 1000)}s -> data/icd10.index.bin`);
