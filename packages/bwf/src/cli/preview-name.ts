const PREVIEW_NAME = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export function isPreviewName(name: string): boolean {
  return PREVIEW_NAME.test(name);
}
