import type { CandidateDevice, RepositoryApk } from '@pxv/adapters';

export function compatibleRepositoryApk(row: RepositoryApk, device: CandidateDevice): boolean {
  const { minSdk, maxSdk, abis } = row.compatibility;
  return (
    minSdk <= device.sdk &&
    (maxSdk === undefined || maxSdk >= device.sdk) &&
    (!abis.length || abis.some((abi) => device.abis.includes(abi)))
  );
}
