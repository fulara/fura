import { defineConfig } from "vitest/config";
import { dockviewResizeCleanup } from "./dockviewResizeCleanup";

export default defineConfig({
  plugins: [dockviewResizeCleanup()],
  resolve: { alias: [{ find: /^dockview-core$/, replacement: new URL("./node_modules/dockview-core/dist/package/main.esm.mjs", import.meta.url).pathname }] },
  test: {
    server: { deps: { inline: ["dockview-core"] } },
    environment: "jsdom",
    globals: false,
    include: ["src/**/*.test.ts"],
  },
});
