import { defineConfig } from "vite";

export default defineConfig({
  build: {
    chunkSizeWarningLimit: 550,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ["three", "three/examples/jsm/controls/OrbitControls.js"],
        },
      },
    },
  },
});
