import type { ObligationWriter } from '@pxv/contracts';
import { ipInCidrs } from './network-address.js';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import {
  parseDocument,
  validProbeEndpoint,
  type AndroidUserIdentity,
  type RecoveryObligation,
  type SelectedTarget,
} from '@pxv/contracts';
import type { AndroidAdapter } from './android.js';
import type { VerifiedArtifact } from './artifacts.js';
import { AdapterError, type OperationOptions } from './command.js';

export interface NetworkProbeRequest {
  endpoint: string;
  expectedEgressCidrs: string[];
  requireVpn: boolean;
}
export interface NetworkObservation {
  uid: number;
  requestSucceeded: boolean;
  connectionObserved: boolean;
  vpnActive: boolean;
  egressIp: string | null;
  errorType: string | null;
}
export interface ProbeEvidence {
  scope: 'probe-app-uid-https-only';
  normal: NetworkObservation;
  failures: { stoppedPackage: string; stopped: NetworkObservation; recovered: NetworkObservation }[];
}
export interface ProbeOptions extends OperationOptions {
  obligations: ObligationWriter;
}

function validateRequest(request: NetworkProbeRequest): void {
  if (!validProbeEndpoint(request.endpoint))
    throw new AdapterError('Network probe requires an approved HTTPS endpoint');
  if (request.expectedEgressCidrs.length === 0)
    throw new AdapterError('Approved expected egress CIDRs are required');
  // Parse every CIDR before installing any helper.
  ipInCidrs('0.0.0.0', request.expectedEgressCidrs);
}
export class NetworkProbeService {
  constructor(readonly android: AndroidAdapter) {}
  /** Explicit recovery only; unresolved restarts require fresh app-UID route evidence. */
  async recoverService(
    target: SelectedTarget,
    obligation: RecoveryObligation,
    helper: VerifiedArtifact,
    options: ProbeOptions,
  ): Promise<ProbeEvidence> {
    const user = recoveryUser(target, obligation, options.obligations);
    const { id, version, signer, request } = recoveryPayload(obligation.payload);
    await this.android.guardUser(target, user, options.signal);
    const identity = await this.android.installedIdentity(target, user, id, options.signal);
    if (identity.versionCode !== version || identity.signerSha256 !== signer)
      throw new AdapterError('The service APK changed; preserve its recovery obligation');
    assertRecoveryVpn(obligation.payload['vpn'], await this.android.vpn(target, user, options.signal));
    await this.android.launch(target, user, id, options);
    const evidence = await this.run(target, user, helper, request, options);
    await options.obligations.resolve(obligation.id);
    return evidence;
  }
  async observe(
    target: SelectedTarget,
    user: AndroidUserIdentity,
    request: NetworkProbeRequest,
    options: OperationOptions,
  ): Promise<NetworkObservation> {
    validateRequest(request);
    await this.android.guardUser(target, user, options.signal);
    const output = await this.android.shell(
      target,
      [
        'am',
        'instrument',
        '--user',
        String(user.userId),
        '-w',
        '-e',
        'endpoint',
        request.endpoint,
        'org.pxv.probe/org.pxv.probe.Probe',
      ],
      { ...options, mutation: true, timeoutMs: 90_000 },
    );
    return parseObservation(output, user);
  }
  requireRoute(observation: NetworkObservation, request: NetworkProbeRequest): void {
    if (
      !observation.requestSucceeded ||
      !observation.connectionObserved ||
      (request.requireVpn && !observation.vpnActive) ||
      !observation.egressIp ||
      !ipInCidrs(observation.egressIp, request.expectedEgressCidrs)
    )
      throw new AdapterError(
        'Probe did not measure the approved app-UID HTTPS route; keep this profile out of handoff',
      );
  }
  async run(
    target: SelectedTarget,
    user: AndroidUserIdentity,
    helper: VerifiedArtifact,
    request: NetworkProbeRequest,
    options: ProbeOptions,
    failurePackages: readonly string[] = [],
  ): Promise<ProbeEvidence> {
    validateRequest(request);
    if (helper.packageId !== 'org.pxv.probe')
      throw new AdapterError('Network probe requires the pinned probe helper');
    await this.android.guardUser(target, user, options.signal);
    if ((await this.android.listPackages(target, user, options.signal)).has(helper.packageId))
      throw new AdapterError(
        'An existing probe helper may belong to another operation; inspect its ownership first',
      );
    const writer = options.obligations.child('network-probe-' + randomUUID());
    const obligation = helperObligation(target, user, helper, writer);
    await writer.record(obligation);
    try {
      await this.android.install(target, user, helper, options);
      const normal = await this.observe(target, user, request, options);
      this.requireRoute(normal, request);
      const failures: ProbeEvidence['failures'] = [];
      for (const id of failurePackages)
        failures.push(
          await this.exerciseFailure(target, user, helper, request, options, writer, obligation, id),
        );
      return { scope: 'probe-app-uid-https-only', normal, failures };
    } finally {
      await this.android.cleanup(target, obligation, {
        lease: options.lease,
        operationId: writer.ownerOperationId,
      });
      await writer.resolve(obligation.id);
    }
  }

  private async exerciseFailure(
    target: SelectedTarget,
    user: AndroidUserIdentity,
    helper: VerifiedArtifact,
    request: NetworkProbeRequest,
    options: ProbeOptions,
    writer: ObligationWriter,
    parent: RecoveryObligation,
    id: string,
  ): Promise<ProbeEvidence['failures'][number]> {
    const vpn = await this.android.vpn(target, user, options.signal);
    if (!vpn.alwaysOn || !vpn.lockdown || !vpn.packageId || !request.requireVpn)
      throw new AdapterError('Failure exercises require measured always-on VPN and lockdown configuration');
    const identity = await this.android.installedIdentity(target, user, id, options.signal);
    const service: RecoveryObligation = {
      ...parent,
      id: randomUUID(),
      kind: 'restart-service',
      resource: user.serialNo + ':' + id,
      payload: { ...identity, request, vpn, helperArtifact: structuredClone(helper) },
    };
    await writer.record(service);
    await this.android.guardUser(target, user, options.signal);
    await this.android.shell(target, ['am', 'force-stop', '--user', String(user.userId), id], {
      ...options,
      mutation: true,
    });
    let stopped: NetworkObservation;
    let recovered: NetworkObservation;
    try {
      stopped = await this.observe(target, user, request, options);
      assertBlocked(stopped);
    } finally {
      const recoveryOptions: OperationOptions = { lease: options.lease };
      await this.android.launch(target, user, id, recoveryOptions);
      recovered = await this.observe(target, user, request, recoveryOptions);
      this.requireRoute(recovered, request);
      await writer.resolve(service.id);
    }
    return { stoppedPackage: id, stopped, recovered };
  }
}

function recoveryUser(
  target: SelectedTarget,
  obligation: RecoveryObligation,
  writer: ObligationWriter,
): AndroidUserIdentity {
  if (
    obligation.kind !== 'restart-service' ||
    !['pending', 'blocked'].includes(obligation.status) ||
    obligation.operationId !== writer.operationId ||
    obligation.ownerOperationId !== writer.ownerOperationId ||
    obligation.deviceSerial !== target.device.canonicalSerial ||
    !obligation.user
  )
    throw new AdapterError('Service recovery evidence is outside the selected device scope');
  return obligation.user;
}
function recoveryPayload(payload: Record<string, unknown>): {
  id: string;
  version: number;
  signer: string;
  request: NetworkProbeRequest;
} {
  const id = payload['packageId'],
    version = payload['versionCode'],
    signer = payload['signerSha256'];
  if (typeof id !== 'string' || typeof version !== 'number' || typeof signer !== 'string')
    throw new AdapterError('Malformed service recovery evidence');
  const request = recoveryRequest(payload['request']);
  validateRequest(request);
  return { id, version, signer, request };
}
function recoveryRequest(raw: unknown): NetworkProbeRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new AdapterError('Malformed service recovery evidence');
  const value = raw as Partial<NetworkProbeRequest>;
  if (
    typeof value.endpoint !== 'string' ||
    !Array.isArray(value.expectedEgressCidrs) ||
    value.expectedEgressCidrs.some((entry) => typeof entry !== 'string') ||
    typeof value.requireVpn !== 'boolean'
  )
    throw new AdapterError('Malformed network recovery request');
  return {
    endpoint: value.endpoint,
    expectedEgressCidrs: value.expectedEgressCidrs,
    requireVpn: value.requireVpn,
  };
}
function assertRecoveryVpn(
  previous: unknown,
  vpn: { packageId: string | null; alwaysOn: boolean; lockdown: boolean },
): void {
  if (!previous || typeof previous !== 'object' || Array.isArray(previous))
    throw new AdapterError('VPN protection changed; review it before restarting the service');
  const record = previous as Record<string, unknown>;
  if (
    record['packageId'] !== vpn.packageId ||
    record['alwaysOn'] !== vpn.alwaysOn ||
    record['lockdown'] !== vpn.lockdown ||
    !vpn.alwaysOn ||
    !vpn.lockdown
  )
    throw new AdapterError('VPN protection changed; review it before restarting the service');
}
function observationRecord(output: string): Record<string, unknown> {
  const rows = [...output.matchAll(/^INSTRUMENTATION_RESULT: pxv_json=(.+)$/gm)];
  const raw = rows[0]?.[1];
  if (rows.length !== 1 || !raw || Buffer.byteLength(raw) > 8192)
    throw new AdapterError('Probe did not return exactly one bounded structured observation');
  JSON.parse(raw) as unknown;
  const parsed: unknown = parseDocument(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new AdapterError('Invalid network observation');
  return parsed as Record<string, unknown>;
}
function observationUid(record: Record<string, unknown>, user: AndroidUserIdentity): number {
  const uid = record['uid'];
  if (
    record['schema_version'] !== 1 ||
    typeof uid !== 'number' ||
    !Number.isSafeInteger(uid) ||
    uid < 0 ||
    Math.floor(uid / 100000) !== user.userId ||
    uid % 100000 < 10000
  )
    throw new AdapterError('Network probe ran outside the intended user or returned malformed observations');
  return uid;
}
function booleanObservation(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== 'boolean')
    throw new AdapterError('Network probe ran outside the intended user or returned malformed observations');
  return value;
}
function optionalObservation(
  record: Record<string, unknown>,
  key: string,
  valid: (value: string) => boolean,
  message: string,
): string | null {
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !valid(value)) throw new AdapterError(message);
  return value;
}
function parseObservation(output: string, user: AndroidUserIdentity): NetworkObservation {
  const record = observationRecord(output);
  const uid = observationUid(record, user);
  const requestSucceeded = booleanObservation(record, 'request_succeeded');
  const connectionObserved = booleanObservation(record, 'connection_observed');
  const vpnActive = booleanObservation(record, 'vpn_active');
  if (requestSucceeded && !connectionObserved)
    throw new AdapterError('Network probe returned contradictory observations');
  return {
    uid,
    requestSucceeded,
    connectionObserved,
    vpnActive,
    egressIp: optionalObservation(
      record,
      'egress_ip',
      (value) => !!isIP(value),
      'Probe endpoint did not report a valid egress IP',
    ),
    errorType: optionalObservation(
      record,
      'error_type',
      (value) => /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(value),
      'Invalid network probe error type',
    ),
  };
}
function helperObligation(
  target: SelectedTarget,
  user: AndroidUserIdentity,
  helper: VerifiedArtifact,
  writer: ObligationWriter,
): RecoveryObligation {
  return {
    schemaVersion: 1,
    id: randomUUID(),
    operationId: writer.operationId,
    ownerOperationId: writer.ownerOperationId,
    deviceSerial: target.device.canonicalSerial,
    user,
    kind: 'remove-helper',
    resource: user.serialNo + ':org.pxv.probe',
    payload: {
      packageId: helper.packageId,
      versionCode: helper.versionCode,
      signerSha256: helper.signerSha256,
    },
    status: 'pending',
  };
}
function assertBlocked(stopped: NetworkObservation): void {
  if (
    stopped.requestSucceeded ||
    stopped.connectionObserved ||
    !stopped.errorType ||
    ![
      'ConnectException',
      'SocketTimeoutException',
      'UnknownHostException',
      'NoRouteToHostException',
    ].includes(stopped.errorType)
  )
    throw new AdapterError('The app-UID network failure exercise did not measure blocked traffic');
}
