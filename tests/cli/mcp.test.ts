import { describe, expect, it, vi } from './../test-api.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PassThrough } from 'node:stream';
import { createMcpServer, serveStdio, type AgentBackend } from '@pxv/mcp';

function backend(): AgentBackend {
  return {
    inspectHost: () => Promise.resolve({ supported: true }),
    listDevices: () => Promise.resolve({ devices: [] }),
    inspectDevice: (assetId) => Promise.resolve({ assetId }),
    prepareOperation: (assetId, operation) =>
      Promise.resolve({ planId: 'reviewed-plan', assetId, operation, reviewSummary: 'exact-summary' }),
    executePlan: vi.fn((planId: string, reviewSummary: string) =>
      reviewSummary === 'exact-summary'
        ? Promise.resolve({ runId: planId })
        : Promise.reject(new Error('Approval mismatch')),
    ),
    getRun: (runId, after) => Promise.resolve({ runId, after, events: [] }),
    listRuns: () => Promise.resolve({ items: [], nextCursor: null }),
    cancelRun: (runId) => Promise.resolve({ runId, requested: true }),
    attestDevice: vi.fn<AgentBackend['attestDevice']>((assetId, check, operator, note, evidence) =>
      Promise.resolve({ assetId, check, operator, note, evidence }),
    ),
    finalizeDevice: vi.fn<AgentBackend['finalizeDevice']>((assetId, operator, locale) =>
      Promise.resolve({ assetId, operator, locale }),
    ),
    confirmCustody: vi.fn<AgentBackend['confirmCustody']>((assetId, recipient, debuggingOff) =>
      Promise.resolve({ assetId, recipient, debuggingOff }),
    ),
    recoverDevice: vi.fn<AgentBackend['recoverDevice']>((assetId, runId, inspected) =>
      Promise.resolve({ assetId, runId, inspected }),
    ),
    recordLifecycle: vi.fn<AgentBackend['recordLifecycle']>((input) => Promise.resolve(input)),
    refreshReview: vi.fn<AgentBackend['refreshReview']>((runId) =>
      Promise.resolve({ runId, reviewSummary: 'new-exact-review' }),
    ),
    extensionList: vi.fn<AgentBackend['extensionList']>(() => Promise.resolve([])),
    extensionInspect: vi.fn<AgentBackend['extensionInspect']>((id) => Promise.resolve({ id })),
    extensionInstall: vi.fn<AgentBackend['extensionInstall']>((source, reviewed, registry) =>
      Promise.resolve({ source, reviewed, registry }),
    ),
    extensionUpdate: vi.fn<AgentBackend['extensionUpdate']>((id, source, reviewed, registry) =>
      Promise.resolve({ id, source, reviewed, registry }),
    ),
    extensionRemove: vi.fn<AgentBackend['extensionRemove']>((id, reviewed) =>
      Promise.resolve({ id, reviewed }),
    ),
    extensionPolicy: vi.fn<AgentBackend['extensionPolicy']>((id, contribution, reviewed) =>
      Promise.resolve({ id, contribution, reviewed }),
    ),
    extensionGuide: vi.fn<AgentBackend['extensionGuide']>((id, contribution) =>
      Promise.resolve({ id, contribution }),
    ),
    extensionAdapter: vi.fn<AgentBackend['extensionAdapter']>((assetId, id, contribution, input) =>
      Promise.resolve({ assetId, id, contribution, input, reviewSummary: 'exact' }),
    ),
    extensionCommand: vi.fn<AgentBackend['extensionCommand']>((assetId, id, command, input) =>
      Promise.resolve({ assetId, id, command, input, reviewSummary: 'exact' }),
    ),
    guide: (name) => Promise.resolve(`# ${name}`),
  };
}

describe('real MCP transport contracts', () => {
  it('serves the actual line-delimited stdio protocol with a fork identity and safe unknown errors', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let received = '';
    output.on('data', (data: Buffer) => {
      received += data.toString();
    });
    const source = backend();
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- A foreign extension may reject with an arbitrary value.
    source.inspectHost = () => Promise.reject('opaque failure');
    const server = await serveStdio(source, true, {
      input,
      output,
      identity: { name: 'fork-command', version: '0.1.0-preview.test' },
    });
    try {
      input.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'wire-test', version: '1' },
          },
        }) + '\n',
      );
      await vi.waitFor(() => expect(received).toContain('fork-command'));
      input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      input.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'inspect_host', arguments: {} },
        }) + '\n',
      );
      await vi.waitFor(() => expect(received).toContain('Operation failed'));
    } finally {
      await server.close();
      input.destroy();
      output.destroy();
    }
  });
  it('keeps inspection, preparation, guides and bounded progress available without mutation tools', async () => {
    const source = backend();
    const server = createMcpServer(source);
    const client = new Client({ name: 'acceptance', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).not.toContain('execute_plan');
      expect(tools.tools.map((tool) => tool.name)).not.toContain('cancel_run');
      expect(await client.callTool({ name: 'inspect_host', arguments: {} })).toMatchObject({
        content: [{ type: 'text', text: '{"supported":true}' }],
      });
      expect(await client.callTool({ name: 'list_devices', arguments: {} })).toMatchObject({
        content: [{ type: 'text', text: '{"devices":[]}' }],
      });
      expect(await client.callTool({ name: 'inspect_device', arguments: { assetId: 'all' } })).toMatchObject({
        content: [{ type: 'text', text: '{"assetId":"all"}' }],
      });
      expect(
        JSON.stringify(
          await client.callTool({
            name: 'prepare_operation',
            arguments: { assetId: 'phone', operation: 'create-users' },
          }),
        ),
      ).toContain('reviewed-plan');
      expect(await client.callTool({ name: 'get_run', arguments: { runId: 'run', after: 4 } })).toMatchObject(
        { content: [{ type: 'text', text: '{"runId":"run","after":4,"events":[]}' }] },
      );
      expect(await client.callTool({ name: 'list_runs', arguments: {} })).toMatchObject({
        content: [{ type: 'text', text: '{"items":[],"nextCursor":null}' }],
      });
      for (const arguments_ of [{ limit: 1001 }, { limit: 0 }, { cursor: '' }, { cursor: 'a\0b' }])
        expect(await client.callTool({ name: 'list_runs', arguments: arguments_ })).toMatchObject({
          isError: true,
        });
      const resources = await client.listResources();
      expect(resources.resources).toHaveLength(2);
      expect(await client.readResource({ uri: 'pxv://guides/recipient' })).toMatchObject({
        contents: [{ text: '# recipient' }],
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('requires exact reviewed input, reports backend failures and supports explicit cancellation', async () => {
    const source = backend();
    const server = createMcpServer(source, true);
    const client = new Client({ name: 'acceptance', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      expect(
        await client.callTool({
          name: 'execute_plan',
          arguments: { planId: 'plan', reviewSummary: 'changed', operator: 'test' },
        }),
      ).toMatchObject({ isError: true });
      expect(
        await client.callTool({
          name: 'execute_plan',
          arguments: { planId: 'plan', reviewSummary: 'exact-summary', operator: 'test' },
        }),
      ).toMatchObject({ content: [{ text: '{"runId":"plan"}' }] });
      expect(await client.callTool({ name: 'cancel_run', arguments: { runId: 'run' } })).toMatchObject({
        content: [{ text: '{"runId":"run","requested":true}' }],
      });
      expect(
        await client.callTool({ name: 'get_run', arguments: { runId: 'run', after: -1 } }),
      ).toMatchObject({ isError: true });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('exposes complete lifecycle and reviewed extensions only with mutation consent', async () => {
    const source = backend();
    const server = createMcpServer(source, true);
    const client = new Client({ name: 'complete-workflow', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const calls = [
        ['attest_device', { assetId: 'all', check: 'normal_credentials', operator: 'Alice' }],
        ['finalize_device', { assetId: 'all', operator: 'Alice', locale: 'pl' }],
        ['confirm_custody', { assetId: 'all', recipient: 'Recipient', debuggingOff: true }],
        ['recover_device', { assetId: 'all', runId: 'old-run', inspected: true }],
        ['record_lifecycle', { assetId: 'all', type: 'maintenance', operator: 'Alice', note: 'Visit' }],
        ['refresh_review', { runId: 'paused-run' }],
        ['extension_list', {}],
        ['extension_inspect', { id: 'private' }],
        [
          'extension_install',
          {
            source: { package: '@private/ext', version: '1.2.3' },
            reviewed: true,
            registry: 'https://registry.example/',
          },
        ],
        [
          'extension_install',
          { source: { tarball: '/tmp/ext.tgz', integrity: 'sha512-pin' }, reviewed: true },
        ],
        ['extension_update', { id: 'private', source: { tarball: '/tmp/ext.tgz' }, reviewed: true }],
        ['extension_remove', { id: 'private', reviewed: true }],
        ['extension_policy', { id: 'private', contribution: 'policy.json', reviewed: true }],
        ['extension_guide', { id: 'private', contribution: 'guide.md' }],
        [
          'extension_adapter',
          { assetId: 'all', id: 'private', contribution: 'adapter.js', input: { scope: 'local' } },
        ],
        ['extension_command', { assetId: 'all', id: 'private', contribution: 'maintain' }],
      ] as const;
      for (const [name, args] of calls) {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError, name).not.toBe(true);
      }
      expect(source.attestDevice).toHaveBeenCalledWith(
        'all',
        'normal_credentials',
        'Alice',
        undefined,
        undefined,
      );
      expect(source.recordLifecycle).toHaveBeenCalledWith(
        expect.objectContaining({ confirmedErasure: false }),
      );
      expect(source.extensionCommand).toHaveBeenCalledWith('all', 'private', 'maintain', {});
      expect(source.extensionAdapter).toHaveBeenCalledWith('all', 'private', 'adapter.js', {
        scope: 'local',
      });
      for (const [name, args] of [
        ['recover_device', { assetId: 'all', runId: 'old-run', inspected: false }],
        ['confirm_custody', { assetId: 'all', recipient: 'Recipient', debuggingOff: false }],
        ['extension_install', { source: { tarball: '/tmp/ext.tgz', token: 'not-an-input' }, reviewed: true }],
        ['extension_remove', { id: 'private', reviewed: false }],
      ] as const)
        expect((await client.callTool({ name, arguments: args })).isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
    const readOnly = createMcpServer(source);
    const readClient = new Client({ name: 'inspection', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await readOnly.connect(b);
    await readClient.connect(a);
    try {
      const names = (await readClient.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain('extension_guide');
      for (const name of [
        'attest_device',
        'finalize_device',
        'confirm_custody',
        'recover_device',
        'record_lifecycle',
        'refresh_review',
        'extension_install',
        'extension_update',
        'extension_remove',
        'extension_policy',
        'extension_adapter',
        'extension_command',
      ])
        expect(names).not.toContain(name);
    } finally {
      await readClient.close();
      await readOnly.close();
    }
  });
});
