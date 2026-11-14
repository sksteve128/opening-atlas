import generationPlugin from './server/generation.ts'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({ plugins: [react(), tailwindcss(), generationPlugin()], server: { proxy: { '/maia': { target: 'http://127.0.0.1:8765', rewrite: path => path.replace(/^\/maia/, '') } } } })
