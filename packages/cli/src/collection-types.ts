import type { CollectionProfile, CollectionStatus } from '@pxv/adapters';
import type { SelectedTarget } from '@pxv/contracts';
import type { CollectedRegistryValue, ResourceScope } from '@pxv/engine';
import type { DeviceLease } from '@pxv/runtime';
import type { ApplicationCliContext } from './arguments.js';

export interface CollectionOutcome {
  scope: 'device' | 'profile';
  profileId?: string;
  slotIndex?: number;
  status: CollectionStatus;
}
export interface PrivateCollection {
  values: CollectedRegistryValue[];
  outcomes: CollectionOutcome[];
  guard(): Promise<void>;
}
export interface CollectionSource {
  name: 'oblivion' | 'sessionid' | 'simcards';
  label: string;
  profiles: boolean;
  collect(
    context: ApplicationCliContext,
    target: SelectedTarget,
    profiles: CollectionProfile[],
    scope: ResourceScope,
    lease: DeviceLease,
  ): Promise<PrivateCollection>;
}
