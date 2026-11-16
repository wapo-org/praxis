import {describe, expect, it} from 'vitest';
import {API_CHECKS} from './api-smoke.js';
import {checkFeatureMap, FeatureMapSchema, liveSuiteIds, loadFeatureMap, type FeatureMap} from './feature-map.js';
import {pickSimulator} from './ios.js';
import {WEB_FLOWS} from './web/flows.js';

const implemented = () => ({flows: WEB_FLOWS.map(flow => flow.id), checks: API_CHECKS.map(check => check.id), suites: liveSuiteIds()});

const tiny = (covers: FeatureMap['features'][number]['covers']): FeatureMap => ({
  $schema: 'praxis-verify/feature-map@1',
  features: [{id: 'a.b', title: 'T', issue: 'PRA-1', surfaces: ['web'], covers}],
});

describe('feature map', () => {
  it('cloud/verify/feature-map.json parses and matches the implemented flows, checks and suites', () => {
    expect(checkFeatureMap(loadFeatureMap(), implemented())).toEqual([]);
  });

  it('rejects malformed entries', () => {
    const bad = (feature: Record<string, unknown>) => FeatureMapSchema.safeParse({$schema: 'praxis-verify/feature-map@1', features: [feature]}).success;
    const valid = {id: 'a.b', title: 'T', issue: 'PRA-1', surfaces: ['web'], covers: [{command: 'gate'}]};
    expect(bad(valid)).toBe(true);
    expect(bad({...valid, issue: 'ENG-1'})).toBe(false);
    expect(bad({...valid, id: 'Upper'})).toBe(false);
    expect(bad({...valid, surfaces: ['android']})).toBe(false);
    expect(bad({...valid, covers: [{command: 'web', flows: []}]})).toBe(false);
    expect(bad({...valid, covers: [{command: 'gate', flows: ['x']}]})).toBe(false);
  });

  it('reports mapped names without code and code without a mapped feature', () => {
    const problems = checkFeatureMap(tiny([{command: 'web', flows: ['ghost']}, {command: 'live', suite: 'phantom'}]), {flows: ['real'], checks: ['probe'], suites: []});
    expect(problems).toEqual([
      'web flow ghost is in the feature map but has no implementation',
      'web flow real is implemented but no feature in the map covers it',
      'api check probe is implemented but no feature in the map covers it',
      'live suite phantom is in the feature map but has no implementation',
    ]);
  });

  it('flags duplicate feature ids', () => {
    const map = tiny([{command: 'gate'}]);
    map.features.push({...map.features[0]!});
    expect(checkFeatureMap(map, {flows: [], checks: [], suites: []})).toEqual(['duplicate feature id a.b']);
  });
});

describe('ios simulator choice', () => {
  const device = (udid: string, name: string, state = 'Shutdown', isAvailable = true) => ({udid, name, state, isAvailable});
  it('picks only shut-down iPhones on the newest runtime automatically, skips iPads and unavailable devices, and honours a wanted device', () => {
    const listing = {
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [device('old', 'iPhone 16', 'Booted')],
        'com.apple.CoreSimulator.SimRuntime.iOS-26-1': [device('ipad', 'iPad Pro'), device('gone', 'iPhone 17', 'Shutdown', false), device('cold', 'iPhone 17 Pro'), device('warm', 'iPhone 17', 'Booted')],
        'com.apple.CoreSimulator.SimRuntime.watchOS-12-0': [device('watch', 'Apple Watch')],
      },
    };
    expect(pickSimulator(listing)?.udid).toBe('cold');
    expect(pickSimulator(listing, 'iPhone 17')?.udid).toBe('warm');
    expect(pickSimulator(listing, 'old')?.udid).toBe('old');
    expect(pickSimulator(listing, 'missing')).toBeUndefined();
    expect(pickSimulator({devices: {}})).toBeUndefined();
    const onlyBootedOnNewest = {devices: {'com.apple.CoreSimulator.SimRuntime.iOS-26-1': [device('busy', 'iPhone 17', 'Booted')], 'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [device('idle', 'iPhone 16')]}};
    expect(pickSimulator(onlyBootedOnNewest)?.udid).toBe('idle');
    const allBooted = {devices: {'com.apple.CoreSimulator.SimRuntime.iOS-26-1': [device('busy', 'iPhone 17', 'Booted')]}};
    expect(pickSimulator(allBooted)).toBeUndefined();
    expect(pickSimulator(allBooted, 'busy')?.udid).toBe('busy');
  });
});
