import { defineConfig } from 'vite';

// GitHub Pages 等のサブパス配信を想定し base は相対パス。
// ルート配信なら '/' に変更してよい。
export default defineConfig({
  base: './',
  worker: {
    format: 'es',
  },
});
