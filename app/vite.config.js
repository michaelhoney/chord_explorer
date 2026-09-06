import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // GitHub Pages serves this repo at /chord_explorer/, so assets can't be
  // rooted at /. Harmless locally — the dev server honours it too.
  base: '/chord_explorer/',
})
