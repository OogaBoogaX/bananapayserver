// Synthetic segwit addresses for fixtures, encoded here, independently of the code under test,
// from repeated-byte programs with their own BIP 173/350 checksums. Never a real address.

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}

function words(bytes) {
  let acc = 0, bits = 0;
  const out = [];
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out.push((acc >>> bits) & 31);
    }
    acc &= (1 << bits) - 1;
  }
  if (bits) out.push((acc << (5 - bits)) & 31);
  return out;
}

export function segwit(hrp, version, program) {
  const data = [version, ...words(program)];
  const expanded = [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
  const mod = (polymod([...expanded, ...data, 0, 0, 0, 0, 0, 0]) ^ (version === 0 ? 1 : 0x2bc830a3)) >>> 0;
  const checksum = [0, 1, 2, 3, 4, 5].map((i) => (mod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...data, ...checksum].map((d) => CHARSET[d]).join("")}`;
}

// A regtest P2WPKH-shaped address whose 20-byte program is the byte n repeated.
export const syntheticAddress = (n) => segwit("bcrt", 0, Array(20).fill(n));
