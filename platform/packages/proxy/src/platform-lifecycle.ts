// Decision: These wire values have to match @builtbyfriends/platform. This private runtime is bundled into
// that package, so it can't import the package being built. The key keeps the name an earlier install
// stored: the installer writes that name to close traffic, and a renamed copy here never sees it.
export const PLATFORM_DISABLED_KEY = '__void/platform/disabled/v1';
export const PLATFORM_DISABLED_VALUE = 'disabled';
