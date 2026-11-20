// Vercel transpiles function files one by one, and workspace packages export raw .ts, so the function serves the esbuild bundle.
export {default, GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD} from '../dist/index.mjs';
