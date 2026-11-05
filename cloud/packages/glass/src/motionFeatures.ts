// The animation engine, in its own chunk. Everything renders through `m`, so nothing waits on this file
// to appear: `MotionProvider` fetches it right after first paint and animations start from there.
export { domMax as default } from 'framer-motion';
