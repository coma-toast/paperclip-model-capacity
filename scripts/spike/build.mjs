import esbuild from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const presets = createPluginBundlerPresets({ workerEntry: "scripts/spike/src/worker.ts", manifestEntry: "scripts/spike/src/manifest.ts", outdir: "scripts/spike/dist" });
await Promise.all([esbuild.build(presets.esbuild.worker), esbuild.build(presets.esbuild.manifest)]);
