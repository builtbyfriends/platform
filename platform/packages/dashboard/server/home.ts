import { defineHandler } from '@builtbyfriends/bwf';
import { fetchApi } from '../lib/api.ts';
import type { CurrentUser } from '../lib/api.ts';
import { discoveryDisplayName } from '../lib/platform-title.ts';

export type Props = Readonly<{
  user: CurrentUser;
  platformName: string;
}>;

export const loader = defineHandler<Props>(async (context) => {
  let platformName = 'Platform';
  try {
    const response = await fetchApi(context, '/.well-known/platform');
    if (response.ok) {
      platformName = discoveryDisplayName((await response.json()) as { displayName?: unknown });
    }
  } catch {
    // Decision: The dashboard stays available when discovery is down for a while.
  }
  return { user: context.get('dashboardUser'), platformName };
});
