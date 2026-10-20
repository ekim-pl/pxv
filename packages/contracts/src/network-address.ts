import { z } from 'zod';
const ipv4 = z.ipv4();
const ipv6 = z.ipv6();
function addressFamily(value: string): number {
  if (value.includes('%')) return 0;
  if (ipv4.safeParse(value).success) return 4;
  return ipv6.safeParse(value).success ? 6 : 0;
}
function addressBits(value: string): { bits: number; value: bigint } {
  const family = addressFamily(value);
  if (!family) throw new Error('Expected a valid IP address without a scope');
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
function cidrBits(cidr: string): { bits: number; value: bigint; shift: bigint } {
  const [network, length, extra] = cidr.split('/');
  if (!network || !length || extra !== undefined || !/^(?:0|[1-9]\d*)$/.test(length))
    throw new Error('Expected canonical egress CIDRs');
  const expected = addressBits(network);
  const prefix = Number(length);
  if (!Number.isSafeInteger(prefix) || prefix > expected.bits) throw new Error('Invalid egress CIDR prefix');
  const shift = BigInt(expected.bits - prefix);
  if ((expected.value >> shift) << shift !== expected.value)
    throw new Error('Egress CIDR includes host bits');
  return { ...expected, shift };
}
export function validateEgressCidr(cidr: string): void {
  cidrBits(cidr);
}
export function ipInCidrs(address: string, cidrs: readonly string[]): boolean {
  const observed = addressBits(address);
  return cidrs
    .map(cidrBits)
    .some(
      (expected) =>
        expected.bits === observed.bits &&
        expected.value >> expected.shift === observed.value >> expected.shift,
    );
}
