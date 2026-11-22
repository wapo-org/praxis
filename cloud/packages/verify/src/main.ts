import {parseArgs} from 'node:util';
import {DEFAULT_API_PORT, EXIT_FAILED, EXIT_INCOMPLETE, EXIT_OK, EXIT_USAGE} from './constants.js';
import {USAGE, UsageError, list, parsePorts} from './args.js';
import {checkFeatureMap, liveSuiteIds, loadFeatureMap} from './feature-map.js';
import {runGate} from './gate.js';
import {runIos} from './ios.js';
import {listSuites, runLive} from './live/command.js';
import {API_CHECKS, runApiSmoke} from './api-smoke.js';
import {runWeb} from './web/command.js';
import {WEB_FLOWS} from './web/flows.js';

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  const {values, positionals} = parseArgs({
    args: [...rest],
    allowPositionals: true,
    options: {
      json: {type: 'boolean', default: false},
      only: {type: 'string'},
      flows: {type: 'string'},
      ports: {type: 'string'},
      port: {type: 'string'},
      base: {type: 'string'},
      api: {type: 'string'},
      seed: {type: 'string'},
      headed: {type: 'boolean', default: false},
      check: {type: 'boolean', default: false},
      list: {type: 'boolean', default: false},
      evidence: {type: 'string', multiple: true},
      'skip-tests': {type: 'boolean', default: false},
      simulator: {type: 'string'},
    },
  });
  switch (command) {
    case 'gate':
      return (await runGate({...(list(values.only) ? {only: list(values.only)!} : {}), json: values.json})).ok ? EXIT_OK : EXIT_FAILED;
    case 'web': {
      if (values.api && !values.base) throw new UsageError('--api needs --base: either verify running servers (both) or start our own (neither)');
      const report = await runWeb({
        ...(list(values.flows) ? {flows: list(values.flows)!} : {}),
        ports: parsePorts(values.ports),
        ...(values.base ? {base: values.base} : {}),
        ...(values.api ? {api: values.api} : {}),
        seed: Number(values.seed ?? 1),
        headed: values.headed,
        json: values.json,
      });
      return report.ok ? EXIT_OK : EXIT_FAILED;
    }
    case 'api':
      return (await runApiSmoke({...(values.api ? {api: values.api} : {}), port: Number(values.port ?? DEFAULT_API_PORT), json: values.json})).ok ? EXIT_OK : EXIT_FAILED;
    case 'ios':
      return (await runIos({json: values.json, skipTests: values['skip-tests'], ...(values.simulator ? {simulator: values.simulator} : {})})).ok ? EXIT_OK : EXIT_FAILED;
    case 'map': {
      if (!values.check) throw new UsageError('map takes --check');
      const problems = checkFeatureMap(loadFeatureMap(), {flows: WEB_FLOWS.map(flow => flow.id), checks: API_CHECKS.map(check => check.id), suites: liveSuiteIds()});
      for (const problem of problems) console.log(`FAIL ${problem}`);
      console.log(problems.length ? `map: FAILED (${problems.length} problems)` : 'map: ok');
      return problems.length ? EXIT_FAILED : EXIT_OK;
    }
    case 'live': {
      if (values.list) {
        await listSuites();
        return EXIT_OK;
      }
      const suite = positionals[0];
      if (!suite) throw new UsageError('live needs a suite name; see live --list');
      const proof = await runLive({suite, evidence: values.evidence ?? [], ...(list(values.only) ? {only: list(values.only)!} : {}), json: values.json});
      if (proof.status === 'failed') return EXIT_FAILED;
      return proof.status === 'complete' ? EXIT_OK : EXIT_INCOMPLETE;
    }
    case undefined:
    case 'help':
    case '--help':
      console.log(USAGE);
      return command ? EXIT_OK : EXIT_USAGE;
    default:
      throw new UsageError(`Unknown command ${command}`);
  }
}
