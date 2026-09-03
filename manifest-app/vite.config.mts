import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

// Build del frontend en Vue. El código fuente vive en frontend-src/ y la salida
// va a frontend/, que es lo que Express sirve como estático.
//
// emptyOutDir: false es CRÍTICO — frontend/ contiene index.legacy.html y
// admin.legacy.html (las versiones originales, conservadas como referencia y
// respaldo, nunca borradas) además de css/ y js/, que esas páginas legacy
// todavía usan. El build solo agrega sus propios archivos.
//
// index.html y admin.html SON la salida del build: rediseño Vue 3 + Tailwind
// v4 + shadcn-vue (frontend-src/editor-redesign/ y frontend-src/admin-redesign/),
// probado de punta a punta y promovido a producción el 2026-09-03,
// reemplazando la migración Vue plana anterior (frontend-src/editor/ y
// frontend-src/admin/ ahora solo guardan api.ts/store.ts, la lógica que el
// rediseño reutiliza — sin UI propia).
export default defineConfig({
  root: resolve(__dirname, 'frontend-src'),
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'frontend-src'),
    },
  },
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
