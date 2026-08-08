import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
    // Proxying keeps the browser on a single origin, so there are no CORS
    // preflights and the websocket upgrade works without extra config.
    proxy: {
      "/api": { target: "http://localhost:3001", changeOrigin: true },
      "/socket.io": { target: "http://localhost:3001", ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    // Phaser is large; splitting it keeps the app chunk readable in the report.
    rollupOptions: {
      output: {
        manualChunks: {
          phaser: ["phaser"],
          viem: ["viem"],
        },
      },
    },
  },
});
