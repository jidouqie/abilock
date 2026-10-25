import { defineConfig } from "vite";
export default defineConfig({
  root: "web",
  // Service credentials must never be read by the frontend build.
  envDir: false,
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: {
    host: "127.0.0.1",
    port: 4319,
    strictPort: true,
    proxy: { "/admin": "http://127.0.0.1:4317" },
  },
});
