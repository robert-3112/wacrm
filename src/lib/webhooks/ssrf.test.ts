import { describe, it, expect } from 'vitest';
import { isPrivateOrReservedIp, isDeliverableUrl } from './ssrf';

describe('isPrivateOrReservedIp', () => {
  it('flags loopback / private / link-local / CGNAT IPv4', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1', // CGNAT
      '0.0.0.0',
    ]) {
      expect(isPrivateOrReservedIp(ip)).toBe(true);
    }
  });

  it('allows public IPv4', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '93.184.216.34']) {
      expect(isPrivateOrReservedIp(ip)).toBe(false);
    }
  });

  it('flags loopback / ULA / link-local IPv6 and IPv4-mapped privates', () => {
    for (const ip of ['::1', 'fe80::1', 'fc00::1', 'fd12::34', '::ffff:127.0.0.1']) {
      expect(isPrivateOrReservedIp(ip)).toBe(true);
    }
    expect(isPrivateOrReservedIp('2606:4700:4700::1111')).toBe(false);
  });

  it.each([
    '::ffff:7f00:1', '::FFFF:a00:5', '::ffff:a9fe:a9fe',
    '::ffff:ac10:1', '::ffff:c0a8:101', '::ffff:6440:1',
    '0:0:0:0:0:ffff:7f00:1', '::ffff:0:0', '[::ffff:127.0.0.1]',
    '0:0:0:0:0:0:0:1', '0000:0000:0000:0000:0000:0000:0000:0000',
  ])('rejects private addresses in alternate IPv6 notation: %s', (ip) => {
    expect(isPrivateOrReservedIp(ip)).toBe(true);
  });

  it.each(['::ffff:808:808', '0:0:0:0:0:ffff:101:101', '::ffff:93.184.216.34'])
    ('allows public IPv4-mapped IPv6: %s', (ip) => {
      expect(isPrivateOrReservedIp(ip)).toBe(false);
    });

  it.each(['0fe8::1', '0fea::1', '0fc0::1', '0fd0::1'])
    ('does not confuse short hextets with private prefixes: %s', (ip) => {
      expect(isPrivateOrReservedIp(ip)).toBe(false);
    });

  it.each(['fe80::1%eth0', '999.1.1.1', 'not-an-ip'])
    ('fails closed for invalid or scoped addresses: %s', (ip) => {
      expect(isPrivateOrReservedIp(ip)).toBe(true);
    });
});

describe('isDeliverableUrl', () => {
  it('rejects literal private IPs and internal names without DNS', async () => {
    expect(await isDeliverableUrl('https://127.0.0.1/hook')).toBe(false);
    expect(await isDeliverableUrl('https://169.254.169.254/latest/meta-data')).toBe(false);
    expect(await isDeliverableUrl('https://[::1]/hook')).toBe(false);
    expect(await isDeliverableUrl('https://localhost/hook')).toBe(false);
    expect(await isDeliverableUrl('https://foo.internal/hook')).toBe(false);
  });

  it('rejects a malformed URL', async () => {
    expect(await isDeliverableUrl('not a url')).toBe(false);
  });

  it('allows a literal public IP', async () => {
    expect(await isDeliverableUrl('https://8.8.8.8/hook')).toBe(true);
  });

  it.each(['::ffff:7f00:1', '::ffff:127.0.0.1', '0:0:0:0:0:ffff:a9fe:a9fe'])
    ('rejects a private mapped literal after URL canonicalization: %s', async (ip) => {
      expect(await isDeliverableUrl(`https://[${ip}]/hook`)).toBe(false);
    });

  it('allows a public mapped literal after URL canonicalization', async () => {
    expect(await isDeliverableUrl('https://[::ffff:8.8.8.8]/hook')).toBe(true);
  });
});
