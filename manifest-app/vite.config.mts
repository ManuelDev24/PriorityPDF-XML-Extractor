import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'node:path';

// Build del frontend en Vue. El código fuente vive en frontend-src/ y la salida
// va a frontend/, que es lo que Express sirve como estático.
//
// emptyOutDir: false es CRÍTICO — frontend/ contiene index.legacy.html y
// admin.legacy.html (las versiones originales, conservadas como referencia y
// respaldo, nunca borradas) además de css/ y js/, que index.legacy.html y
// admin.legacy.html todavía usan. El build solo agrega sus propios archivos.
//
// index.html y admin.html ahora SON la salida del build: fueron probados de
// punta a punta (fidelidad visual pixel a pixel, exportación real del TXT de
// Hacienda) antes de reemplazar a las versiones escritas a mano.
export default defineConfig({
  root: resolve(__dirname, 'frontend-src'),
  plugins: [vue()],
  build: {
    outDir: resolve(__dirname, 'frontend'),
    emptyOutDir: false,
    rollupOptions: {
      input: {
        admin: resolve(__dirname, 'frontend-src/admin.html'),
        index: resolve(__dirname, 'frontend-src/index.html'),
      },
    },
  },
});
