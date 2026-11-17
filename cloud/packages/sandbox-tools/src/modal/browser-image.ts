import {readFileSync} from 'node:fs';
import type {Image, ModalClient} from 'modal';
import {sandboxToolsImage} from './image.js';

export const BROWSER_RUNTIME_DIR = '/opt/praxis-browser';
export const BROWSER_BUILD_TIMEOUT_SECONDS = 300;
export const BROWSER_MEMORY_MIB = 2_048;
const BROWSER_CACHE_DIR = '/opt/praxis-chromium';
const CLI_FILES = ['cli.ts', 'commands.ts', 'session.ts', 'refs.ts'] as const;

function runtimeFiles(): Record<string, string> {
  const cliRoot = new URL('../../../browser-cli/', import.meta.url);
  const files: Record<string, string> = {};
  for (const name of ['package.json', 'package-lock.json']) files[name] = readFileSync(new URL(`runtime/${name}`, cliRoot), 'utf8');
  for (const name of CLI_FILES) {
    files[`src/${name}`] = readFileSync(new URL(`src/${name}`, cliRoot), 'utf8').replaceAll("'@praxis/verify'", "'./evidence.js'");
  }
  const verifyRoot = new URL('../../../verify/src/', import.meta.url);
  files['src/evidence.ts'] = readFileSync(new URL('web/evidence.ts', verifyRoot), 'utf8').replace("'../constants.js'", "'./constants.js'") + "\nexport {CAPTURE_VIEWPORT} from './constants.js';\n";
  files['src/constants.ts'] = readFileSync(new URL('constants.ts', verifyRoot), 'utf8');
  return files;
}

/** Only the CLI and evidence sources enter the image; no checkout, environment files or credentials are copied. */
export function sandboxBrowserImage(modal: ModalClient): Image {
  const encoded = Buffer.from(JSON.stringify(runtimeFiles())).toString('base64');
  const unpack = `const fs=require("node:fs"),p=require("node:path");for(const [n,s] of Object.entries(JSON.parse(Buffer.from("${encoded}","base64").toString()))){const f=p.join("${BROWSER_RUNTIME_DIR}",n);fs.mkdirSync(p.dirname(f),{recursive:true});fs.writeFileSync(f,s);}`;
  const launcher = `#!/bin/sh\nexec node ${BROWSER_RUNTIME_DIR}/node_modules/tsx/dist/cli.mjs ${BROWSER_RUNTIME_DIR}/src/cli.ts "$@"\n`;
  const launcherEncoded = Buffer.from(launcher).toString('base64');
  return sandboxToolsImage(modal).dockerfileCommands([
    `ENV PLAYWRIGHT_BROWSERS_PATH=${BROWSER_CACHE_DIR}`,
    `RUN node -e '${unpack}'`,
    `RUN cd ${BROWSER_RUNTIME_DIR} && timeout ${BROWSER_BUILD_TIMEOUT_SECONDS}s npm ci --no-audit --no-fund`,
    `RUN cd ${BROWSER_RUNTIME_DIR} && timeout ${BROWSER_BUILD_TIMEOUT_SECONDS}s ./node_modules/.bin/playwright install --with-deps chromium`,
    `RUN printf '%s' '${launcherEncoded}' | base64 -d > /usr/local/bin/praxis-browser && chmod 755 /usr/local/bin/praxis-browser`,
  ]);
}
