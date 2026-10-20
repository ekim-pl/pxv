import type { CandidateDevice } from '@pxv/adapters';

export function explicitAppCompatibility(sdk: string, abi: string): CandidateDevice {
  const abis = abi.split(',');
  const number = Number(sdk);
  if (!/^[1-9][0-9]*$/.test(sdk) || !Number.isSafeInteger(number))
    throw new Error('--sdk must be a positive Android SDK integer');
  if (!abis.length || abis.some((value) => !/^[A-Za-z0-9_-]+$/.test(value)))
    throw new Error('--abi must contain a comma-separated list of Android ABI names');
  return { sdk: number, abis: [...new Set(abis)] };
}

function validatePolicyInput(values: Record<string, unknown>): void {
  if (values['policy'] !== undefined && values['project-root'] !== undefined)
    throw new Error('Choose --policy or --project-root');
  if (values['policy'] === '') throw new Error('--policy requires a file');
  if (values['policy'] !== undefined && values['asset'] !== undefined)
    throw new Error('Standalone policies require --sdk and --abi');
  if (values['asset'] === '') throw new Error('--asset requires an enrolled asset ID');
}

export function validatePolicyUpdateArguments(values: Record<string, unknown>): void {
  validatePolicyInput(values);
  if (values['output'] === '') throw new Error('--output requires a file');
  const asset = values['asset'] !== undefined;
  const explicit = values['sdk'] !== undefined || values['abi'] !== undefined;
  if (asset && explicit) throw new Error('Choose --asset or the --sdk and --abi pair');
  if (values['transport'] !== undefined && !asset) throw new Error('--transport requires --asset');
  if (!asset) {
    if (typeof values['sdk'] !== 'string' || typeof values['abi'] !== 'string')
      throw new Error('Select --asset or supply both --sdk and --abi');
    explicitAppCompatibility(values['sdk'], values['abi']);
  }
}
