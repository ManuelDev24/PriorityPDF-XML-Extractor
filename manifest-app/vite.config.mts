import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

// Build del frontend en Vue. El código fuente vive en frontend-src/ y la salida
// va a frontend/, que es lo que Express sirve como estático.
//
// index.html y admin.html SON la salida del build: rediseño Vue 3 + Tailwind
// v4 + shadcn-vue (frontend-src/editor-redesign/ y frontend-src/admin-redesign/),
// probado de punta a punta y promovido a producción el 2026-09-03. Las
// versiones legacy (index.legacy.html, admin.legacy.html, css/, js/ sueltos)
// y la migración Vue plana intermedia (frontend-src/editor/App.vue,
// frontend-src/admin/App.vue) ya no existen — este es el único frontend.
// frontend-src/editor/ y frontend-src/admin/ siguen vivos solo por
// api.ts/store.ts, la lógica que el rediseño reutiliza.
//
// emptyOutDir vuelve a su default (true): ya no hay nada legacy que proteger
// en frontend/, así que cada build limpia los chunks hasheados de la
// compilación anterior en vez de acumularlos indefinidamente.
export default defineConfig({
  root: resolve(__dirname, 'frontend-src'),
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'frontend-src'),
    },
  },
  // Si se corre `vite` suelto (dev server en :5173, sin pasar por Express),
  // ninguna llamada a /api/* existía ahí — el fetch le pegaba al propio
  // Vite, que devolvía su HTML de fallback en vez de JSON ("Unexpected
  // token '<'"). Este proxy reenvía /api al backend real en :3000, para que
  // el frontend funcione igual entre a través de :3000 (producción, server.js
  // sirviendo los archivos ya compilados) o de :5173 (dev server de Vite).
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
  build: {
    outDir: resolve(__dirname, 'frontend'),
    // outDir queda fuera de root (frontend-src/): Vite exige emptyOutDir
    // explícito para limpiarlo, si no lo deja intacto por seguridad.
    emptyOutDir: true,
    rollupOptions: {
      input: {
        admin: resolve(__dirname, 'frontend-src/admin.html'),
        index: resolve(__dirname, 'frontend-src/index.html'),
      },
    },
  },
});
