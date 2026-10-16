import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import {
  parseDocument,
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
export interface ObligationWriter {
  record(obligation: RecoveryObligation): Promise<void>;
  resolve(id: string): Promise<void>;
}
export interface ProbeOptions extends OperationOptions {
  operationId: string;
  obligations: ObligationWriter;
}
function addressBits(value: string): { bits: number; value: bigint } {
  const family = isIP(value);
  if (!family) throw new AdapterError('Expected a valid IP address');
  if (family === 4)
    return { bits: 32, value: value.split('.').reduce((total, octet) => (total << 8n) | BigInt(octet), 0n) };
  let address = value.toLowerCase();
  if (address.includes('.')) {
    const at = address.lastIndexOf(':');
    const part = addressBits(address.slice(at + 1));
    address =
      address.slice(0, at + 1) + (part.value >> 16n).toString(16) + ':' + (part.value & 0xffffn).toString(16);
  }
  const halves = address.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const parts =
    halves.length === 2
      ? [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right]
      : left;
  return { bits: 128, value: parts.reduce((total, part) => (total << 16n) | BigInt(`0x${part}`), 0n) };
}
export function ipInCidrs(address: string, cidrs: readonly string[]): boolean {
  const observed = addressBits(address);
  return cidrs
    .map((cidr) => {
      const [network, length, extra] = cidr.split('/');
      if (!network || !length || extra || !/^\d+$/.test(length))
        throw new AdapterError('Expected canonical egress CIDRs');
      const expected = addressBits(network);
      const prefix = Number(length);
      if (prefix > expected.bits) throw new AdapterError('Invalid egress CIDR prefix');
      const shift = BigInt(expected.bits - prefix);
      if ((expected.value >> shift) << shift !== expected.value)
        throw new AdapterError('Egress CIDR includes host bits');
      return expected.bits === observed.bits && expected.value >> shift === observed.value >> shift;
    })
    .some(Boolean);
}
function validateRequest(request: NetworkProbeRequest): void {
  const endpoint = new URL(request.endpoint);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash)
    throw new AdapterError('Network probe requires an approved HTTPS endpoint');
  if (request.expectedEgressCidrs.length === 0)
    throw new AdapterError('Approved expected egress CIDRs are required');
  // Parse every CIDR before installing any helper.
  ipInCidrs('0.0.0.0', request.expectedEgressCidrs);
}
export class NetworkProbeService {
  constructor(readonly android: AndroidAdapter) {}
  /** Explicit recovery only; a pending restart is resolved after fresh app-UID route evidence. */
  async recoverService(
    target: SelectedTarget,
    obligation: RecoveryObligation,
    helper: VerifiedArtifact,
    options: ProbeOptions,
  ): Promise<ProbeEvidence> {
    if (
      obligation.kind !== 'restart-service' ||
      obligation.status !== 'pending' ||
      obligation.deviceSerial !== target.device.canonicalSerial ||
      !obligation.user
    )
      throw new AdapterError('Service recovery evidence is outside the selected device scope');
    const payload = obligation.payload;
    const id = payload['packageId'];
    const version = payload['versionCode'];
    const signer = payload['signerSha256'];
    const raw = payload['request'];
    if (
      typeof id !== 'string' ||
      typeof version !== 'number' ||
      typeof signer !== 'string' ||
      !raw ||
      typeof raw !== 'object' ||
      Array.isArray(raw)
    )
      throw new AdapterError('Malformed service recovery evidence');
    const request = raw as Partial<NetworkProbeRequest>;
    if (
      typeof request.endpoint !== 'string' ||
      !Array.isArray(request.expectedEgressCidrs) ||
      request.expectedEgressCidrs.some((value) => typeof value !== 'string') ||
      typeof request.requireVpn !== 'boolean'
    )
      throw new AdapterError('Malformed network recovery request');
    const verifiedRequest: NetworkProbeRequest = {
      endpoint: request.endpoint,
      expectedEgressCidrs: request.expectedEgressCidrs,
      requireVpn: request.requireVpn,
    };
    validateRequest(verifiedRequest);
    await this.android.guardUser(target, obligation.user, options.signal);
    const identity = await this.android.installedIdentity(target, obligation.user, id, options.signal);
    if (identity.versionCode !== version || identity.signerSha256 !== signer)
      throw new AdapterError('The service APK changed; preserve its recovery obligation');
    const vpn = await this.android.vpn(target, obligation.user, options.signal);
    const previous = payload['vpn'];
    if (
      !previous ||
      typeof previous !== 'object' ||
      Array.isArray(previous) ||
      (previous as Record<string, unknown>)['packageId'] !== vpn.packageId ||
      (previous as Record<string, unknown>)['alwaysOn'] !== vpn.alwaysOn ||
      (previous as Record<string, unknown>)['lockdown'] !== vpn.lockdown ||
      !vpn.alwaysOn ||
      !vpn.lockdown
    )
      throw new AdapterError('VPN protection changed; review it before restarting the service');
    await this.android.launch(target, obligation.user, id, options);
    const evidence = await this.run(target, obligation.user, helper, verifiedRequest, options);
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
    const rows = [...output.matchAll(/^INSTRUMENTATION_RESULT: pxv_json=(.+)$/gm)];
    const raw = rows[0]?.[1];
    if (rows.length !== 1 || !raw || Buffer.byteLength(raw) > 8192)
      throw new AdapterError('Probe did not return exactly one bounded structured observation');
    JSON.parse(raw) as unknown;
    const parsed: unknown = parseDocument(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new AdapterError('Invalid network observation');
    const record = parsed as Record<string, unknown>;
    const uid = record['uid'];
    if (
      record['schema_version'] !== 1 ||
      typeof uid !== 'number' ||
      !Number.isSafeInteger(uid) ||
      uid < 0 ||
      Math.floor(uid / 100000) !== user.userId ||
      uid % 100000 < 10000 ||
      typeof record['request_succeeded'] !== 'boolean' ||
      typeof record['connection_observed'] !== 'boolean' ||
      typeof record['vpn_active'] !== 'boolean'
    )
      throw new AdapterError(
        'Network probe ran outside the intended user or returned malformed observations',
      );
    if (record['request_succeeded'] && !record['connection_observed'])
      throw new AdapterError('Network probe returned contradictory observations');
    const ip = record['egress_ip'];
    const error = record['error_type'];
    if (ip !== undefined && ip !== null && (typeof ip !== 'string' || !isIP(ip)))
      throw new AdapterError('Probe endpoint did not report a valid egress IP');
    if (
      error !== undefined &&
      error !== null &&
      (typeof error !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,79}$/.test(error))
    )
      throw new AdapterError('Invalid network probe error type');
    return {
      uid,
      requestSucceeded: record['request_succeeded'],
      connectionObserved: record['connection_observed'],
      vpnActive: record['vpn_active'],
      egressIp: typeof ip === 'string' ? ip : null,
      errorType: typeof error === 'string' ? error : null,
    };
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
    const childId = `${options.operationId}/probe/${randomUUID()}`;
    const obligation: RecoveryObligation = {
      schemaVersion: 1,
      id: randomUUID(),
      operationId: options.operationId,
      ownerOperationId: childId,
      deviceSerial: target.device.canonicalSerial,
      user,
      kind: 'remove-helper',
      resource: `${user.serialNo}:org.pxv.probe`,
      payload: {
        packageId: helper.packageId,
        versionCode: helper.versionCode,
        signerSha256: helper.signerSha256,
      },
      status: 'pending',
    };
    await options.obligations.record(obligation); // Persist intent before installing.
    try {
      await this.android.install(target, user, helper, options);
      const normal = await this.observe(target, user, request, options);
      this.requireRoute(normal, request);
      const failures: ProbeEvidence['failures'] = [];
      for (const id of failurePackages) {
        const vpn = await this.android.vpn(target, user, options.signal);
        if (!vpn.alwaysOn || !vpn.lockdown || !vpn.packageId || !request.requireVpn)
          throw new AdapterError(
            'Failure exercises require measured always-on VPN and lockdown configuration',
          );
        const identity = await this.android.installedIdentity(target, user, id, options.signal);
        const service: RecoveryObligation = {
          ...obligation,
          id: randomUUID(),
          kind: 'restart-service',
          resource: `${user.serialNo}:${id}`,
          payload: { ...identity, request, vpn, helperArtifact: structuredClone(helper) },
        };
        await options.obligations.record(service);
        await this.android.guardUser(target, user, options.signal);
        await this.android.shell(target, ['am', 'force-stop', '--user', String(user.userId), id], {
          ...options,
          mutation: true,
        });
        let stopped: NetworkObservation;
        let recovered: NetworkObservation;
        try {
          stopped = await this.observe(target, user, request, options);
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
        } finally {
          // Recovery is bounded and retains this child obligation on any failure.
          const recoveryOptions: OperationOptions = { lease: options.lease };
          await this.android.launch(target, user, id, recoveryOptions);
          recovered = await this.observe(target, user, request, recoveryOptions);
          this.requireRoute(recovered, request);
          await options.obligations.resolve(service.id);
        }
        failures.push({ stoppedPackage: id, stopped, recovered });
      }
      return { scope: 'probe-app-uid-https-only', normal, failures };
    } finally {
      // Cleanup is deliberately limited to this helper; parent keep-awake and unrelated resources remain held.
      await this.android.cleanup(target, obligation, { lease: options.lease, operationId: childId });
      await options.obligations.resolve(obligation.id);
    }
  }
}
