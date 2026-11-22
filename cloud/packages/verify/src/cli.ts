import {EXIT_FAILED, EXIT_USAGE} from './constants.js';
import {USAGE, UsageError} from './args.js';
import {main} from './main.js';

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  const usage = error instanceof UsageError || (error instanceof TypeError && 'code' in error && String(error.code).startsWith('ERR_PARSE_ARGS'));
  console.error(`praxis-verify: ${error instanceof Error ? error.message : String(error)}`);
  if (usage) console.error(USAGE);
  process.exitCode = usage ? EXIT_USAGE : EXIT_FAILED;
}
