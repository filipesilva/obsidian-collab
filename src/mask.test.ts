import { describe, expect, it } from 'vitest';
import { maskAddresses } from './mask';

describe('maskAddresses', () => {
  it('keeps only the last part of IPv4 addresses', () => {
    expect(maskAddresses('public address: 140.174.33.192')).toBe('public address: xxx.xxx.xxx.192');
    expect(maskAddresses('1 udp 1686052607 140.174.33.192 12164 typ srflx raddr 172.20.10.2 rport 54620')).toBe(
      '1 udp 1686052607 xxx.xxx.xxx.192 12164 typ srflx raddr xxx.xxx.xxx.2 rport 54620',
    );
    expect(maskAddresses('turn: turn:172.20.10.2:3479 always=true')).toBe('turn: turn:xxx.xxx.xxx.2:3479 always=true');
  });

  it('keeps only the last part of IPv6 addresses', () => {
    expect(maskAddresses('1 udp 2122199807 fd7a:115c:a1e0::4101:d67f 58438 typ host')).toBe('1 udp 2122199807 xxxx:xxxx:xxxx::xxxx:d67f 58438 typ host');
    expect(maskAddresses('2001:0db8:85a3:0000:0000:8a2e:0370:7334')).toBe('xxxx:xxxx:xxxx:xxxx:xxxx:xxxx:xxxx:7334');
    expect(maskAddresses('fe80::1%en0 and ::1')).toBe('xxxx::1%en0 and ::1');
    expect(maskAddresses('::ffff:10.0.0.7')).toBe('::ffff:xxx.xxx.xxx.7');
  });

  it('leaves everything else alone', () => {
    const text = [
      'collab 0.0.1 macos 2026-09-25T17:08:00.673Z',
      'stun:stun.l.google.com:19302 gathered in 11.0s',
      '1 udp 2113937151 dcb3fb50-08e9-4586-a2c0-0d43e664c373.local 52671 typ host',
      'collab Demo.md: peers=2 status={"relays":4,"attempts":7,"failures":0}',
      'peer 0r7X2j ice=connected pairs=prflx>host=in-progress*',
      'version 1.2.3.4.5',
    ].join('\n');
    expect(maskAddresses(text)).toBe(text);
  });
});
