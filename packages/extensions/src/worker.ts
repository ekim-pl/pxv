import { parentPort, workerData } from 'node:worker_threads';
import { takeCoverage } from 'node:v8';
import { extensionResponse, type WorkerRequest } from './worker-handler.js';
void extensionResponse(workerData as WorkerRequest).then((response) => {
  takeCoverage();
  parentPort!.postMessage(response);
});
