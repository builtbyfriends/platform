import { analyzeApplicationSync } from './application-analysis.ts';
import type { ApplicationAnalysis } from './application-analysis.ts';
import { scanRoutes } from './router/scan.ts';
import type { ScanResult } from './router/scan.ts';

export type CompleteApplicationAnalysis = ApplicationAnalysis & { scan: ScanResult };

/** Complete route analysis using the same resource and handler inventories. */
export async function completeApplicationAnalysis(
  analysis: ApplicationAnalysis,
): Promise<CompleteApplicationAnalysis> {
  const scan = await scanRoutes({
    paths: analysis.paths,
    inventory: {
      routes: analysis.routes,
      middleware: analysis.middleware,
      jobs: analysis.jobs,
      queues: analysis.queues,
      procedures: analysis.procedures,
      websockets: analysis.websockets,
      email: analysis.email,
    },
  });
  return { ...analysis, scan };
}

export async function analyzeApplication(
  root: string,
  options: Parameters<typeof analyzeApplicationSync>[1],
): Promise<CompleteApplicationAnalysis> {
  return completeApplicationAnalysis(analyzeApplicationSync(root, options));
}
