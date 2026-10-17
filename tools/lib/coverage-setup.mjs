// Vitest owns harness coverage. Enable native tracing only for application
// workers/processes created after the test isolate has finished starting.
const directory = process.env['PXV_CHILD_V8_COVERAGE_DIRECTORY'];
if (directory) process.env['NODE_V8_COVERAGE'] = directory;
