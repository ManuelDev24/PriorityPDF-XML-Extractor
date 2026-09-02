import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'node:path';

// Build del frontend en Vue. El código fuente vive en frontend-src/ y la salida
// va a frontend/, que es lo que Express sirve como estático.
//
// emptyOutDir: false es CRÍTICO — frontend/ contiene la aplicación actual, que
// tiene que seguir funcionando durante toda la migración. El build solo agrega
// sus propios archivos, nunca borra los que ya están.
//
// Durante el piloto la pantalla nueva se publica como admin-vue.html, para
// poder compararla lado a lado con la original antes de reemplazarla.
export default defineConfig({
  root: resolve(__dirname, 'frontend-src'),
  plugins: [vue()],
  build: {
    outDir: resolve(__dirname, 'frontend'),
    emptyOutDir: false,
    rollupOptions: {
      input: {
        'admin-vue':  resolve(__dirname, 'frontend-src/admin-vue.html'),
        'editor-vue': resolve(__dirname, 'frontend-src/editor-vue.html'),
      },
    },
  },
});
