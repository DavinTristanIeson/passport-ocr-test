import { defineConfig } from "vite";
import { resolve } from 'path';
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        coordinates: resolve(__dirname, "coordinates.html"),
      }
    }
  }
});
