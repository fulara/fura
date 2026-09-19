import type { Plugin } from "vite";

// Dockview 5.2 removes the resize listener but leaves its debounce timer alive.
// Patch the consumed ESM source, not node_modules: a closed popup must cancel
// that work before PopoutWindow clears its window reference. Recheck on upgrade.
export function dockviewResizeCleanup(): Plugin {
  return {
    name: "dockview-resize-cleanup",
    enforce: "pre",
    transform(code, id) {
      if (!id.split("?")[0].endsWith("/dockview-core/dist/package/main.esm.mjs")) return;
      const start = code.indexOf("function onDidWindowResizeEnd(element, cb) {");
      const end = code.indexOf("\n}", start) + 2;
      const body = code.slice(start, end);
      const marker = "    return disposable;";
      if (start < 0 || end < start || !body.includes("let resizeTimeout;") || !body.includes(marker)
        || body.includes("disposable.addDisposables")) {
        throw new Error("Dockview resize implementation changed; recheck and retire the resize cleanup patch.");
      }
      const fixed = body.replace(marker, "    disposable.addDisposables({ dispose: () => clearTimeout(resizeTimeout) });\n" + marker);
      return { code: code.slice(0, start) + fixed + code.slice(end), map: null };
    },
  };
}
