import { parentPort } from 'node:worker_threads';
import { runDryRun, runSimulation, runValidation } from './jobs';
import type { DryRunInput, SimulateInput } from '../types';

if (!parentPort) throw new Error('runner worker requires a parent port');
parentPort.on('message', async (job: { id: number; name: 'simulate' | 'validate' | 'dryRun'; input: unknown }) => {
  try {
    let result: unknown;
    switch (job.name) {
      case 'simulate': result = await runSimulation(job.input as SimulateInput); break;
      case 'validate': result = await runValidation(job.input as string); break;
      case 'dryRun': result = await runDryRun(job.input as DryRunInput); break;
      default: throw new Error('unknown runner job');
    }
    parentPort!.postMessage({ id: job.id, result });
  } catch (error) {
    parentPort!.postMessage({ id: job.id, error: error instanceof Error ? error.message : String(error) });
  }
});
