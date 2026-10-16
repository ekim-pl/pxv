import { randomUUID } from 'node:crypto';
import { digest, type DeviceTarget, type SelectedTarget } from '@pxv/contracts';
import {
  deviceLeaseKeys,
  recoveryReservations,
  withDeviceLease,
  withRecoveryLease,
  type DeviceLease,
} from '@pxv/runtime';
import { assertProjectFresh, type ProjectContext } from './project.js';
export type NativeReservation = Awaited<ReturnType<typeof recoveryReservations>>[number];
export interface DeviceOwnership {
  run<T>(target: SelectedTarget, operationId: string, action: (lease: DeviceLease) => Promise<T>): Promise<T>;
  recover<T>(
    target: SelectedTarget,
    previousOperationId: string,
    action: (lease: DeviceLease) => Promise<T>,
  ): Promise<T>;
  reservations(device: DeviceTarget): Promise<NativeReservation[]>;
  keys(target: SelectedTarget): { device: string; transport: string };
}
export interface ProjectOwnership {
  run<T>(action: () => Promise<T>): Promise<T>;
}
export class NativeDeviceOwnership implements DeviceOwnership {
  constructor(readonly controlRoot: string) {}
  private deviceKey(device: DeviceTarget): string {
    return digest({ kind: device.kind, serial: device.canonicalSerial });
  }
  keys(target: SelectedTarget): { device: string; transport: string } {
    return deviceLeaseKeys(this.deviceKey(target.device), digest(target.transport.serial));
  }
  run<T>(
    target: SelectedTarget,
    operationId: string,
    action: (lease: DeviceLease) => Promise<T>,
  ): Promise<T> {
    return withDeviceLease(
      this.controlRoot,
      this.deviceKey(target.device),
      digest(target.transport.serial),
      operationId,
      action,
    );
  }
  recover<T>(
    target: SelectedTarget,
    previousOperationId: string,
    action: (lease: DeviceLease) => Promise<T>,
  ): Promise<T> {
    return withRecoveryLease(
      this.controlRoot,
      this.deviceKey(target.device),
      digest(target.transport.serial),
      previousOperationId,
      action,
    );
  }
  async reservations(device: DeviceTarget): Promise<NativeReservation[]> {
    const keys = device.transports.map((transport) => this.keys({ device, transport }));
    return (await recoveryReservations(this.controlRoot)).filter((reservation) =>
      keys.some(
        (key) => key.device === reservation.device_key || key.transport === reservation.transport_key,
      ),
    );
  }
}
export class NativeProjectOwnership implements ProjectOwnership {
  private projectTask: Promise<unknown> = Promise.resolve();
  constructor(
    readonly project: ProjectContext,
    readonly controlRoot: string,
  ) {}
  run<T>(action: () => Promise<T>): Promise<T> {
    const task = this.projectTask.then(() =>
      withDeviceLease(
        this.controlRoot,
        `project-${this.project.config.id}`,
        `project-${this.project.config.id}`,
        `${randomUUID()}-project`,
        async () => {
          await assertProjectFresh(this.project);
          return action();
        },
      ),
    );
    this.projectTask = task.catch(() => undefined);
    return task;
  }
}
