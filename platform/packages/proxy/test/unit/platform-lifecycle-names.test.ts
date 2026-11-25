import { PLATFORM_DISABLED_KEY, PLATFORM_DISABLED_VALUE } from '@builtbyfriends/platform';
import { describe, expect, it } from 'vite-plus/test';
import * as dispatch from '../../../dispatch/src/platform-lifecycle.ts';
import * as proxy from '../../src/platform-lifecycle.ts';

describe('the traffic gate the installer writes', () => {
  it.each([
    ['proxy', proxy],
    ['dispatch', dispatch],
  ])('is the key and value the %s Worker reads', (_name, copy) => {
    expect(copy.PLATFORM_DISABLED_KEY).toBe(PLATFORM_DISABLED_KEY);
    expect(copy.PLATFORM_DISABLED_VALUE).toBe(PLATFORM_DISABLED_VALUE);
  });
});
