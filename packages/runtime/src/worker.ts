import { parentPort, workerData } from 'node:worker_threads';
import { takeCoverage } from 'node:v8';
import {
  openDatabase,
  StorageHandler,
  type StorageRequest,
  type StorageSettings,
} from './storage-handler.ts';
const port = parentPort;
if (!port) throw new Error('Storage worker requires a parent');
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
try {
  const handler = new StorageHandler(openDatabase(workerData as StorageSettings));
  port.postMessage({ ready: true });
  port.on('message', ({ id, method, args }: StorageRequest) => {
    try {
      port.postMessage({ id, result: handler.dispatch(method, args) });
    } catch (error) {
      port.postMessage({ id, error: message(error) });
    } finally {
      if (method === 'close') {
        try {
          if (process.env['NODE_V8_COVERAGE']) takeCoverage();
        } finally {
          port.close();
        }
      }
    }
  });
} catch (error) {
  port.postMessage({ ready: false, error: message(error) });
  port.close();
}
