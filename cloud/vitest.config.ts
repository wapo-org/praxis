import { readFile } from 'node:fs/promises';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [{
    name: 'password-wasm',
    async load(id) {
      if (!id.endsWith('.wasm')) return;
      const bytes = await readFile(id);
      return `export default Uint8Array.from(${JSON.stringify([...bytes])});`;
    },
  }],
  test: {
    server: { deps: { inline: ['password-hash-wasm'] } },
  },
});
