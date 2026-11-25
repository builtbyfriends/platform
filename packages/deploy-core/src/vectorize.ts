import { isRecord } from './is-record.ts';

export type VectorizeConfig = {
  bindingName: string;
  dimensions: number;
  metric: 'cosine' | 'euclidean' | 'dot-product';
};

export function validateVectorize(value: unknown): string | null {
  if (!Array.isArray(value) || value.length > 32) {
    return 'vectorize must be an array with at most 32 indexes';
  }
  const names = new Set<string>();
  for (const index of value) {
    if (
      !isRecord(index) ||
      Object.keys(index).some((key) => !['bindingName', 'dimensions', 'metric'].includes(key))
    ) {
      return 'vectorize entries accept only bindingName, dimensions and metric';
    }
    if (
      typeof index.bindingName !== 'string' ||
      !/^[A-Za-z_$][\w$]{0,63}$/.test(index.bindingName) ||
      index.bindingName.startsWith('__') ||
      [
        'DB',
        'KV',
        'STORAGE',
        'AI',
        'SANDBOX',
        'ASSETS',
        'SEND_EMAIL',
        'USAGE_EVENTS_QUEUE',
      ].includes(index.bindingName)
    ) {
      return 'vectorize bindingName must be a non-reserved JavaScript identifier of at most 64 characters';
    }
    if (names.has(index.bindingName)) {
      return 'vectorize bindingName must be unique';
    }
    names.add(index.bindingName);
    if (
      typeof index.dimensions !== 'number' ||
      !Number.isInteger(index.dimensions) ||
      index.dimensions < 1 ||
      index.dimensions > 1536
    ) {
      return 'vectorize dimensions must be an integer between 1 and 1536';
    }
    if (
      typeof index.metric !== 'string' ||
      !['cosine', 'euclidean', 'dot-product'].includes(index.metric)
    ) {
      return 'vectorize metric must be cosine, euclidean or dot-product';
    }
  }
  return null;
}
