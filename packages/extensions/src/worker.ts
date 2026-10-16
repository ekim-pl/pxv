import { parentPort, workerData } from 'node:worker_threads';
import { extensionResponse, type WorkerRequest } from './worker-handler.js';
void extensionResponse(workerData as WorkerRequest).then((response) => parentPort!.postMessage(response));
