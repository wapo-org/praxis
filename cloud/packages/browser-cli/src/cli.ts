import {resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {runCommand} from './commands.js';

const USAGE = `praxis-browser <command> [args] [--session file] [--headed]
  open | close
  goto <url>
  snapshot                         accessibility tree with refs [ref=eN] for actionable elements
  click <eN|role:name>
  type <eN|role:name> <text>
  wait-for <eN|role:name>
  screenshot <file.png>            prints the path, sha256 and size for proof artifacts
Every command prints one JSON line. No LLM is involved: a target either resolves exactly or the command fails.`;
/** One session per working directory unless told otherwise, so parallel agents can each name their own. */
const DEFAULT_SESSION = '.praxis-browser/session.json';

const {values, positionals} = parseArgs({allowPositionals: true, options: {session: {type: 'string'}, headed: {type: 'boolean', default: false}}});
const [command, ...args] = positionals;
if (!command || command === 'help') {
  console.log(USAGE);
  process.exitCode = command ? 0 : 2;
} else {
  try {
    console.log(JSON.stringify(await runCommand(resolve(values.session ?? DEFAULT_SESSION), command, args, {headed: values.headed})));
  } catch (error) {
    console.log(JSON.stringify({ok: false, error: error instanceof Error ? error.message.split('\n')[0] : String(error)}));
    process.exitCode = 1;
  }
}
