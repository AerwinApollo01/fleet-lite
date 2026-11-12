import { defineConfig } from 'vite';

// The public copy lives at /fleet-lite/ on GitHub Pages. Local development stays at the root.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/fleet-lite/' : '/',
}));
