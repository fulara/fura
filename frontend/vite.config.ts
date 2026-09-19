import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { dockviewResizeCleanup } from "./dockviewResizeCleanup";

export default defineConfig({
  optimizeDeps: { exclude: ["dockview-core"] },
  plugins: [
    dockviewResizeCleanup(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: "script",
      manifest: false,
      workbox: {
        globPatterns: ["**/*.{js,css,html,ico,png,svg,webmanifest}"],
      },
    }),
  ],
  build: {
    rollupOptions: {
      input: {
        main: new URL("./index.html", import.meta.url).pathname,
        mobile: new URL("./mobile.html", import.meta.url).pathname,
      },
    },
  },
});
