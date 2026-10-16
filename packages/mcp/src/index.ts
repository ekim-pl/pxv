import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { EmulatorImagePin } from '@pxv/engine';
import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';

type ExtensionInstallSource = { tarball: string; integrity?: string } | { package: string; version: string };
interface LifecycleInput {
  assetId: string;
  type: 'maintenance' | 'policy-change' | 'loss' | 'retirement';
  operator: string;
  note: string;
  confirmedErasure: boolean;
}

export interface AgentBackend {
  inspectHost(): Promise<unknown>;
  listDevices(): Promise<unknown>;
  inspectDevice(assetId: string): Promise<unknown>;
  prepareOperation(
    assetId: string,
    operation: 'create-users' | 'deploy-apps' | 'provision' | 'install-os',
  ): Promise<unknown>;
  executePlan(planId: string, reviewSummary: string, operator: string): Promise<unknown>;
  getRun(runId: string, after: number): Promise<unknown>;
  listRuns(): Promise<unknown>;
  cancelRun(runId: string): Promise<unknown>;
  attestDevice(
    this: void,
    assetId: string,
    check: string,
    operator: string,
    note?: string,
    evidence?: EmulatorImagePin,
  ): Promise<unknown>;
  finalizeDevice(assetId: string, operator: string, locale: 'en' | 'pl'): Promise<unknown>;
  confirmCustody(assetId: string, recipient: string, debuggingOff: boolean): Promise<unknown>;
  recoverDevice(assetId: string, runId: string, inspected: boolean): Promise<unknown>;
  recordLifecycle(this: void, input: LifecycleInput): Promise<unknown>;
  refreshReview(runId: string): Promise<unknown>;
  extensionList(): Promise<unknown>;
  extensionInspect(id: string): Promise<unknown>;
  extensionInstall(source: ExtensionInstallSource, reviewed: boolean, registry?: string): Promise<unknown>;
  extensionUpdate(
    id: string,
    source: ExtensionInstallSource,
    reviewed: boolean,
    registry?: string,
  ): Promise<unknown>;
  extensionRemove(id: string, reviewed: boolean): Promise<unknown>;
  extensionPolicy(id: string, contribution: string, reviewed: boolean): Promise<unknown>;
  extensionGuide(id: string, contribution: string): Promise<unknown>;
  extensionAdapter(
    this: void,
    assetId: string,
    id: string,
    contribution: string,
    input: unknown,
  ): Promise<unknown>;
  extensionCommand(
    this: void,
    assetId: string,
    id: string,
    command: string,
    input: unknown,
  ): Promise<unknown>;
  guide(name: 'operator' | 'recipient'): Promise<string>;
}
async function result(
  action: () => Promise<unknown>,
): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  try {
    return { content: [{ type: 'text', text: JSON.stringify(await action()) }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: error instanceof Error ? error.message : 'Operation failed' }],
      isError: true,
    };
  }
}
function registerDeviceLifecycle(server: McpServer, backend: AgentBackend): void {
  const assetId = z.string().min(1);
  const id = z.string().min(1);
  const operator = z.string().min(1).max(200);

  server.registerTool(
    'attest_device',
    {
      description:
        'Record a non-secret operator check against fresh measured state; never include credentials',
      inputSchema: {
        assetId,
        check: z.string().min(1),
        operator,
        note: z.string().max(1000).optional(),
        evidence: z
          .object({
            path: z.string().min(1),
            sha256: z.string().regex(/^[a-f0-9]{64}$/u),
            fingerprint: z.string().min(1),
            source: z.string().min(1),
          })
          .strict()
          .optional(),
      },
    },
    ({ assetId, check, operator, note, evidence }) =>
      result(() => backend.attestDevice(assetId, check, operator, note, evidence)),
  );
  server.registerTool(
    'finalize_device',
    {
      description: 'Recheck handoff readiness and request debugging shutdown',
      inputSchema: { assetId, operator, locale: z.enum(['en', 'pl']) },
    },
    ({ assetId, operator, locale }) => result(() => backend.finalizeDevice(assetId, operator, locale)),
  );
  server.registerTool(
    'confirm_custody',
    {
      description: 'Record recipient custody after physical debugging shutdown confirmation',
      inputSchema: { assetId, recipient: z.string().min(1).max(200), debuggingOff: z.literal(true) },
    },
    ({ assetId, recipient, debuggingOff }) =>
      result(() => backend.confirmCustody(assetId, recipient, debuggingOff)),
  );
  server.registerTool(
    'recover_device',
    {
      description:
        'Recover only typed obligations after explicit inspection; never replay interrupted mutations',
      inputSchema: { assetId, runId: id, inspected: z.literal(true) },
    },
    ({ assetId, runId, inspected }) => result(() => backend.recoverDevice(assetId, runId, inspected)),
  );
  server.registerTool(
    'record_lifecycle',
    {
      description:
        'Record maintenance, policy review, loss or confirmed retirement and invalidate old handoff evidence',
      inputSchema: {
        assetId,
        type: z.enum(['maintenance', 'policy-change', 'loss', 'retirement']),
        operator,
        note: z.string().min(1).max(1000),
        confirmedErasure: z.boolean().default(false),
      },
    },
    (input) => result(() => backend.recordLifecycle(input)),
  );
}

function registerExtensionMutations(server: McpServer, backend: AgentBackend): void {
  const assetId = z.string().min(1);
  const id = z.string().min(1);

  const reviewed = z.literal(true);
  const source = z.union([
    z
      .object({ tarball: z.string().min(1), integrity: z.string().optional() })
      .strict()
      .transform((value) => ({
        tarball: value.tarball,
        ...(value.integrity ? { integrity: value.integrity } : {}),
      })),
    z.object({ package: z.string().min(1), version: z.string().min(1) }).strict(),
  ]);
  const registry = z.url().startsWith('https://').optional();
  server.registerTool(
    'refresh_review',
    {
      description: 'Create a new exact review for an intentional manual checkpoint; does not execute it',
      inputSchema: { runId: id },
    },
    ({ runId }) => result(() => backend.refreshReview(runId)),
  );
  server.registerTool(
    'extension_install',
    {
      description: 'Explicitly install a reviewed trusted compiled extension and update the project lock',
      inputSchema: { source, reviewed, registry },
    },
    ({ source, reviewed, registry }) => result(() => backend.extensionInstall(source, reviewed, registry)),
  );
  server.registerTool(
    'extension_update',
    {
      description: 'Explicitly update an installed trusted extension to an exact version',
      inputSchema: { id, source, reviewed, registry },
    },
    ({ id, source, reviewed, registry }) =>
      result(() => backend.extensionUpdate(id, source, reviewed, registry)),
  );
  server.registerTool(
    'extension_remove',
    {
      description: 'Remove a reviewed extension from this project; retain shared immutable installation',
      inputSchema: { id, reviewed },
    },
    ({ id, reviewed }) => result(() => backend.extensionRemove(id, reviewed)),
  );
  server.registerTool(
    'extension_policy',
    {
      description: 'Select a reviewed declared extension policy and invalidate prior approvals',
      inputSchema: { id, contribution: z.string().min(1), reviewed },
    },
    ({ id, contribution, reviewed }) => result(() => backend.extensionPolicy(id, contribution, reviewed)),
  );
  for (const mode of ['adapter', 'command'] as const) {
    server.registerTool(
      `extension_${mode}`,
      {
        description:
          'Prepare contributed core actions for exact review; device execution requires execute_plan',
        inputSchema: { assetId, id, contribution: z.string().min(1), input: z.unknown().default({}) },
      },
      ({ assetId, id, contribution, input }) =>
        result(() =>
          mode === 'adapter'
            ? backend.extensionAdapter(assetId, id, contribution, input)
            : backend.extensionCommand(assetId, id, contribution, input),
        ),
    );
  }
}

function registerRunMutations(server: McpServer, backend: AgentBackend): void {
  server.registerTool(
    'execute_plan',
    {
      description: 'Execute the exact client-approved summary as a durable detached run',
      inputSchema: {
        planId: z.string().min(1),
        reviewSummary: z.string().min(1),
        operator: z.string().min(1),
      },
    },
    ({ planId, reviewSummary, operator }) =>
      result(() => backend.executePlan(planId, reviewSummary, operator)),
  );
  server.registerTool(
    'cancel_run',
    { description: 'Explicitly cancel a submitted run', inputSchema: { runId: z.string().min(1) } },
    ({ runId }) => result(() => backend.cancelRun(runId)),
  );
}

function registerReadTools(server: McpServer, backend: AgentBackend): void {
  server.registerTool(
    'inspect_host',
    { description: 'Inspect host prerequisites without starting device workflows', inputSchema: {} },
    () => result(() => backend.inspectHost()),
  );
  server.registerTool(
    'list_devices',
    { description: 'List enrolled assets and connection state', inputSchema: {} },
    () => result(() => backend.listDevices()),
  );
  server.registerTool(
    'inspect_device',
    { description: 'Inspect exactly one enrolled asset', inputSchema: { assetId: z.string().min(1) } },
    ({ assetId }) => result(() => backend.inspectDevice(assetId)),
  );
  server.registerTool(
    'prepare_operation',
    {
      description: 'Prepare an immutable review; does not mutate the phone',
      inputSchema: {
        assetId: z.string().min(1),
        operation: z.enum(['create-users', 'deploy-apps', 'provision', 'install-os']),
      },
    },
    ({ assetId, operation }) => result(() => backend.prepareOperation(assetId, operation)),
  );
  server.registerTool(
    'extension_list',
    { description: 'Inspect locally installed extensions without fetching updates', inputSchema: {} },
    () => result(() => backend.extensionList()),
  );
  server.registerTool(
    'extension_inspect',
    {
      description: 'Verify an exact project-pinned extension and inspect its metadata',
      inputSchema: { id: z.string().min(1) },
    },
    ({ id }) => result(() => backend.extensionInspect(id)),
  );
  server.registerTool(
    'extension_guide',
    {
      description: 'Read a declared guide from a verified offline extension',
      inputSchema: { id: z.string().min(1), contribution: z.string().min(1) },
    },
    ({ id, contribution }) => result(() => backend.extensionGuide(id, contribution)),
  );
  server.registerTool(
    'get_run',
    {
      description: 'Fetch run metadata and a bounded cursor page',
      inputSchema: { runId: z.string().min(1), after: z.number().int().nonnegative().default(0) },
    },
    ({ runId, after }) => result(() => backend.getRun(runId, after)),
  );
  server.registerTool('list_runs', { description: 'Read retained local run metadata', inputSchema: {} }, () =>
    result(() => backend.listRuns()),
  );
}

function registerGuideResources(server: McpServer, backend: AgentBackend): void {
  for (const name of ['operator', 'recipient'] as const) {
    server.registerResource(
      `${name}-guide`,
      `pxv://guides/${name}`,
      { mimeType: 'text/markdown' },
      async (uri) => ({
        contents: [{ uri: uri.href, mimeType: 'text/markdown', text: await backend.guide(name) }],
      }),
    );
  }
}
/** @internal In-memory transport seam for MCP protocol acceptance without process stdio. */
export function createMcpServer(
  backend: AgentBackend,
  allowMutations = false,
  identity = { name: 'pxv', version: '0.1.0' },
): McpServer {
  const server = new McpServer(identity);
  registerReadTools(server, backend);
  registerGuideResources(server, backend);
  if (allowMutations) {
    registerDeviceLifecycle(server, backend);
    registerExtensionMutations(server, backend);
    registerRunMutations(server, backend);
  }
  return server;
}

export async function serveStdio(
  backend: AgentBackend,
  allowMutations = false,
  options: { input?: Readable; output?: Writable; identity?: { name: string; version: string } } = {},
): Promise<McpServer> {
  const server = createMcpServer(backend, allowMutations, options.identity);
  await server.connect(new StdioServerTransport(options.input, options.output));
  return server;
}
