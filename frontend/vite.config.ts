import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: new URL("./index.html", import.meta.url).pathname,
        mobile: new URL("./mobile.html", import.meta.url).pathname,
      },
    },
  },
});
