import { isIP } from 'node:net';
import { AdapterError } from './command.js';
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
