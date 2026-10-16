/** Require a self-contained Linux x86_64 executable, including static PIE.
 * Checking the ELF tables avoids trusting the build host's newer glibc. */
export function assertStaticLinuxX64Elf(bytes: Buffer): void {
  const invalid = (): never => {
    throw new Error('Supervisor must be a static Linux x86_64 ELF without a shared loader or libraries');
  };
  if (
    bytes.length < 64 ||
    bytes.toString('hex', 0, 4) !== '7f454c46' ||
    bytes[4] !== 2 ||
    bytes[5] !== 1 ||
    bytes[6] !== 1 ||
    ![0, 3].includes(bytes[7] ?? -1) ||
    ![2, 3].includes(bytes.readUInt16LE(16)) ||
    bytes.readUInt16LE(18) !== 62 ||
    bytes.readUInt32LE(20) !== 1 ||
    bytes.readUInt16LE(52) !== 64
  )
    invalid();
  const safe = (value: bigint): number => {
    if (value > BigInt(bytes.length)) invalid();
    return Number(value);
  };
  const offset = safe(bytes.readBigUInt64LE(32));
  const count = bytes.readUInt16LE(56);
  if (
    !count ||
    count > 512 ||
    bytes.readUInt16LE(54) !== 56 ||
    offset < 64 ||
    offset + count * 56 > bytes.length
  )
    invalid();
  let loads = 0;
  for (let index = 0; index < count; index++) {
    const header = offset + index * 56;
    const type = bytes.readUInt32LE(header);
    const start = safe(bytes.readBigUInt64LE(header + 8));
    const length = safe(bytes.readBigUInt64LE(header + 32));
    if (start + length > bytes.length || type === 3) invalid();
    if (type === 1) loads++;
    if (type === 2) {
      if (length < 16 || length % 16 !== 0) invalid();
      let terminated = false;
      for (let entry = start; entry < start + length; entry += 16) {
        const tag = bytes.readBigInt64LE(entry);
        if (tag === 0n) {
          terminated = true;
          break;
        }
        if (tag === 1n || tag === 15n || tag === 29n) invalid();
      }
      if (!terminated) invalid();
    }
  }
  if (!loads) invalid();
}
