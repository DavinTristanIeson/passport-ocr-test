import { defineConfig } from "vite";
import { resolve } from 'path';
import topLevelAwait from 'vite-plugin-top-level-await';
export default defineConfig({
  plugins: [
    topLevelAwait()
  ],
  build: {
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        coordinates: resolve(__dirname, "coordinates.html"),
      }
    }
  }
});
