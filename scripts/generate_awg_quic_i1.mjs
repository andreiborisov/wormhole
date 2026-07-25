#!/usr/bin/env node
/**
 * Headless wrapper around SagePtr/mini_quic_generator.
 *
 * Usage: node scripts/generate_awg_quic_i1.mjs [sni] [level] [padto] [dcidLen] [scidLen]
 *   sni     - TLS SNI to embed (default: ya.ru — a whitelisted Yandex property
 *             that is a real standalone landing page (unlike yandex.ru, which
 *             302-redirects to dzen.ru) and actually answers QUIC/HTTP3
 *             (verified from inside RU), so the decoy matches a real traffic
 *             pattern if DPI decrypts the Initial to read the SNI. Note: video
 *             sites like rutube.ru do NOT serve QUIC, which would make them an
 *             implausible QUIC decoy.)
 *   level   - 0..4 matching the web UI, or "full" for uncut <b> packet
 *             (default: full — best SNI readability for DPI allowlists)
 *   padto   - QUIC Initial pad target in bytes (default: 1200 for full,
 *             0 for cut levels — cut path assumes no padding)
 *   dcidLen - Destination Connection ID length in bytes (default: 8 for full).
 *             Real browsers (Chrome/Firefox) use an 8-byte DCID; a 1-byte DCID
 *             is an easy fingerprint. Forced to 1 for cut levels so the
 *             quicFixCutSettings offset math stays valid.
 *   scidLen - Source Connection ID length in bytes (default: 8 for full).
 *             Real clients advertise a non-empty SCID; forced to 0 for cut
 *             levels for the same reason as dcidLen.
 *
 * Prints I1 from the generator plus recommended entropy I2-I4.
 */
import { webcrypto } from 'node:crypto';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const scriptPath = join(root, 'references/mini_quic_generator/script.js');

const sni = process.argv[2] || 'ya.ru';
const levelArg = process.argv[3] ?? 'full';
const uncut = levelArg === 'full';
const level = uncut ? 0 : Number.parseInt(levelArg, 10);
const padtoArg = process.argv[4];
const padto = padtoArg !== undefined
  ? Number.parseInt(padtoArg, 10)
  : (uncut ? 1200 : 0);
// Cut levels rely on the original tiny CIDs (quicFixCutSettings assumes those
// header offsets); only the uncut/full path uses browser-realistic CID sizes.
const dcidLen = uncut ? Number.parseInt(process.argv[5] ?? '8', 10) : 1;
const scidLen = uncut ? Number.parseInt(process.argv[6] ?? '8', 10) : 0;

if (!uncut && (Number.isNaN(level) || level < 0 || level > 4)) {
  console.error('level must be 0..4 or "full"');
  process.exit(1);
}
if (Number.isNaN(padto) || padto < 0) {
  console.error('padto must be a non-negative integer');
  process.exit(1);
}
if (!uncut && padto !== 0) {
  console.error('cut levels require padto=0 (quicFixCutSettings assumes no padding)');
  process.exit(1);
}
// RFC 9000 §17.2: connection IDs are 0..20 bytes.
if (Number.isNaN(dcidLen) || dcidLen < 0 || dcidLen > 20) {
  console.error('dcidLen must be 0..20');
  process.exit(1);
}
if (Number.isNaN(scidLen) || scidLen < 0 || scidLen > 20) {
  console.error('scidLen must be 0..20');
  process.exit(1);
}

globalThis.window = { crypto: webcrypto };
globalThis.document = { getElementById() { return null; } };

// Upstream level-0 path assigns dataOffset without let/const (sloppy mode in browsers).
const src = readFileSync(scriptPath, 'utf8')
  .replace(/let lastSni[\s\S]*$/, '')
  .replace(
    /payload = quicCryptoFrame\(clientHello\);\n\s*dataOffset =/,
    'payload = quicCryptoFrame(clientHello);\n        let dataOffset =',
  );

const tmp = join(root, 'scripts/.mini_quic_generator.tmp.mjs');
writeFileSync(
  tmp,
  `${src}\nexport {\n  quicTlsClientHelloSniOnly,\n  quicTlsClientHelloToFrames,\n  quicInitial,\n  quicFixCutSettings,\n  quicToAWG,\n  quicToHex,\n};\n`,
);

try {
  const mod = await import(`${pathToFileURL(tmp).href}?t=${Date.now()}`);
  const dcid = new Uint8Array(dcidLen);
  if (dcidLen) webcrypto.getRandomValues(dcid);
  const scid = new Uint8Array(scidLen);
  if (scidLen) webcrypto.getRandomValues(scid);
  const token = new Uint8Array(0);
  const pkn = new Uint8Array([0]);

  // Frame level 1 for full/uncut base payload shape; cuts applied only when not uncut.
  const frameLevel = uncut ? 1 : level;
  const clientHello = mod.quicTlsClientHelloSniOnly(sni);
  const [payload, cutSettings] = mod.quicTlsClientHelloToFrames(clientHello, frameLevel);
  // RFC 9000 §14.1: clients pad UDP datagrams carrying Initial to ≥1200 bytes.
  const packet = await mod.quicInitial(dcid, scid, token, pkn, payload, padto);

  let i1;
  if (uncut) {
    i1 = mod.quicToAWG(packet);
  } else {
    mod.quicFixCutSettings(cutSettings, packet.byteLength, pkn.byteLength, payload.byteLength);
    i1 = mod.quicToAWG(packet, cutSettings);
  }

  // One QUIC Initial in I1 is enough. We intentionally do NOT emit follow-up
  // I2-I4 entropy packets: after a clean 1200-byte QUIC Initial, extra small
  // non-QUIC datagrams make the flow look unlike real QUIC (which sends the
  // Initial then waits ~1 RTT). Keep the pre-handshake burst minimal.
  const out = {
    sni,
    level: uncut ? 'full' : level,
    padto,
    dcid_len: dcidLen,
    scid_len: scidLen,
    i1,
    packet_bytes: packet.byteLength,
  };
  console.log(JSON.stringify(out, null, 2));
} finally {
  try {
    unlinkSync(tmp);
  } catch {
    /* ignore */
  }
}
