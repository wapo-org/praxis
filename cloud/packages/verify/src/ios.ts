import {existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {REPO_DIR} from './constants.js';
import {runCommand} from './proc.js';
import {artifactDir, newRunId} from './run-context.js';

/** Same project, scheme and test target as `.github/workflows/apple.yml`; unit tests only. */
const PROJECT = 'PraxisChat/PraxisChat.xcodeproj';
const SCHEME = 'PraxisChat';
const TEST_TARGET = 'PraxisChatTests';
const SIGNING = ['CODE_SIGNING_ALLOWED=YES', 'CODE_SIGN_IDENTITY=-', 'CODE_SIGN_STYLE=Manual', 'DEVELOPMENT_TEAM='];
/** The shared-machine slot wrapper (FLAT rule 6); CI and other machines run xcodebuild directly. */
const SLOT_TOOL = process.env.PRAXIS_SLOT_TOOL ?? join(homedir(), '.praxis-agent-state', 'cloud', 'tools', 'slot.sh');
const SLOT_OWNER = process.env.PRAXIS_SLOT_OWNER ?? 'praxis-verify';
const LAUNCH_SETTLE_MS = 4_000;

export interface Simulator {
  udid: string;
  name: string;
  runtime: string;
  state: string;
}

interface SimctlDevices {
  devices: Record<string, {udid: string; name: string; state: string; isAvailable: boolean}[]>;
}

/** `wanted` (udid or name) may be booted; automatic choice takes only shut-down iPhones (never one in use), newest runtime first. */
export function pickSimulator(listing: SimctlDevices, wanted?: string): Simulator | undefined {
  const candidates = Object.entries(listing.devices)
    .filter(([runtime]) => /SimRuntime\.iOS-\d+/.test(runtime))
    .flatMap(([runtime, devices]) => devices.filter(device => device.isAvailable && device.name.startsWith('iPhone')).map(device => ({...device, runtime})))
    .filter(device => (wanted ? device.udid === wanted || device.name === wanted : device.state !== 'Booted'));
  const version = (runtime: string) => (/iOS-(\d+)(?:-(\d+))?/.exec(runtime) ?? []).slice(1).map(part => Number(part ?? 0));
  candidates.sort((a, b) => {
    const [aMajor = 0, aMinor = 0] = version(a.runtime), [bMajor = 0, bMinor = 0] = version(b.runtime);
    return bMajor - aMajor || bMinor - aMinor;
  });
  const best = candidates[0];
  return best && {udid: best.udid, name: best.name, runtime: best.runtime, state: best.state};
}

export interface IosReport {
  type: 'verify.ios';
  runId: string;
  ok: boolean;
  simulator?: Simulator;
  steps: {id: string; ok: boolean; ms: number; log?: string; error?: string}[];
  screenshot?: string;
}

export async function runIos(options: {json: boolean; skipTests: boolean; simulator?: string}, print: (line: string) => void = line => console.log(line)): Promise<IosReport> {
  const runId = newRunId();
  const report: IosReport = {type: 'verify.ios', runId, ok: false, steps: []};
  if (process.platform !== 'darwin') {
    report.steps.push({id: 'platform', ok: false, ms: 0, error: `praxis-verify ios needs macOS with Xcode; this is ${process.platform}`});
    print(options.json ? JSON.stringify(report) : `FAIL platform: ${report.steps[0]!.error}`);
    return report;
  }
  const directory = artifactDir('ios', runId);
  const derived = join(directory, 'DerivedData');
  const step = async (id: string, command: string, args: string[], useSlot = false) => {
    const log = join(directory, `${id}.log`);
    const slotted = useSlot && existsSync(SLOT_TOOL);
    const result = await runCommand(slotted ? SLOT_TOOL : command, slotted ? [SLOT_OWNER, command, ...args] : args, {cwd: REPO_DIR, logFile: log});
    const entry = {id, ok: result.code === 0, ms: result.ms, log, ...(result.code === 0 ? {} : {error: `exit ${result.code}`})};
    report.steps.push(entry);
    if (!options.json) print(`${entry.ok ? 'PASS' : 'FAIL'} ${id.padEnd(20)} ${`${(entry.ms / 1000).toFixed(1)}s`.padStart(7)}${entry.ok ? '' : `  see ${log}`}`);
    return result;
  };
  const listing = await runCommand('xcrun', ['simctl', 'list', 'devices', 'available', '--json'], {cwd: REPO_DIR});
  const simulator = listing.code === 0 ? pickSimulator(JSON.parse(listing.output) as SimctlDevices, options.simulator) : undefined;
  if (!simulator) {
    const error = options.simulator ? `no available iPhone simulator matches ${options.simulator}` : 'no shut-down iPhone simulator; name a booted one with --simulator to use it';
    report.steps.push({id: 'simulator', ok: false, ms: 0, error});
    print(options.json ? JSON.stringify(report) : `FAIL simulator: ${error}`);
    return report;
  }
  report.simulator = simulator;
  const destination = `platform=iOS Simulator,id=${simulator.udid}`;
  const bootedHere = simulator.state !== 'Booted';
  try {
    if (bootedHere) await step('boot', 'xcrun', ['simctl', 'bootstatus', simulator.udid, '-b']);
    const xcode = ['-project', PROJECT, '-scheme', SCHEME, '-destination', destination, '-derivedDataPath', derived, `-only-testing:${TEST_TARGET}`, ...SIGNING];
    const build = await step('build-for-testing', 'xcodebuild', ['build-for-testing', ...xcode], true);
    if (build.code === 0 && !options.skipTests) await step('unit-tests', 'xcodebuild', ['test-without-building', ...xcode, '-parallel-testing-enabled', 'NO'], true);
    if (build.code === 0) report.screenshot = await launchScreenshot(simulator.udid, derived, directory, step);
  } finally {
    if (bootedHere) await runCommand('xcrun', ['simctl', 'shutdown', simulator.udid], {cwd: REPO_DIR});
  }
  report.ok = report.steps.every(entry => entry.ok);
  print(options.json ? JSON.stringify(report) : `${report.ok ? 'ios: ok' : 'ios: FAILED'} (${simulator.name}, ${simulator.runtime.split('.').pop()}, artifacts in ${directory})`);
  return report;
}

type Step = (id: string, command: string, args: string[]) => Promise<{code: number; output: string}>;

/** Installs the built app and screenshots its first screen: proof the bundle launches, not a UI test. */
async function launchScreenshot(udid: string, derived: string, directory: string, step: Step): Promise<string | undefined> {
  const app = join(derived, 'Build', 'Products', 'Debug-iphonesimulator', `${SCHEME}.app`);
  const bundle = await runCommand('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', join(app, 'Info.plist')], {cwd: REPO_DIR});
  if (bundle.code !== 0) return undefined;
  if ((await step('install', 'xcrun', ['simctl', 'install', udid, app])).code !== 0) return undefined;
  // A first-launch permission sheet would cover the screen the screenshot is meant to prove.
  if ((await step('grant-permissions', 'xcrun', ['simctl', 'privacy', udid, 'grant', 'all', bundle.output.trim()])).code !== 0) return undefined;
  if ((await step('launch', 'xcrun', ['simctl', 'launch', udid, bundle.output.trim()])).code !== 0) return undefined;
  await new Promise(resolve => setTimeout(resolve, LAUNCH_SETTLE_MS));
  const screenshot = join(directory, 'launch.png');
  return (await step('screenshot', 'xcrun', ['simctl', 'io', udid, 'screenshot', screenshot])).code === 0 ? screenshot : undefined;
}
