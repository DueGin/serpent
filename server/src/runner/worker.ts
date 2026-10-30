import { parentPort } from 'node:worker_threads';
import { z } from 'zod';
import { runDryRun, runSimulation, runValidation } from './jobs';
import { prewarmPythonHosts, shutdownPythonHosts } from '../sandbox/python';
import type { DryRunInput, SimulateInput } from '../types';
import { PythonUnavailableError } from '../sandbox/python-availability';

const port = parentPort;
if (!port) throw new Error('runner worker requires a parent port');
// Prewarming is opportunistic; missing Python isolation/assets must not break JS jobs.
void prewarmPythonHosts().catch(() => undefined);
port.once('close', shutdownPythonHosts);
const validationInput = z.object({ code: z.string(), language: z.enum(['javascript', 'python']).default('javascript') });
port.on('message', async (job: { id: number; name: 'simulate' | 'validate' | 'dryRun'; input: unknown }) => {
  try {
    let result: unknown;
    switch (job.name) {
      case 'simulate': result = await runSimulation(job.input as SimulateInput); break;
      case 'validate': {
        const input = validationInput.parse(job.input);
        result = await runValidation(input.code, input.language);
        break;
      }
      case 'dryRun': result = await runDryRun(job.input as DryRunInput); break;
      default: throw new Error('unknown runner job');
    }
    port.postMessage({ id: job.id, result });
  } catch (error) {
    port.postMessage({ id: job.id, error: error instanceof Error ? error.message : String(error),
      ...(error instanceof PythonUnavailableError ? { errorCode: error.code, reason: error.reason } : {}) });
  }
});
