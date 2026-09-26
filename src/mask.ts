// Diagnostics get pasted into public issues. The last part of an address is
// enough to tell candidates apart, and says nothing about where someone is.
const HEX = '[0-9a-fA-F]{1,4}';
const IPV4 = /(?<![\d.])(?:\d{1,3}\.){3}(\d{1,3})(?!\.?\d)/g;
const IPV6 = new RegExp(`(?<![0-9a-fA-F:.])(?:(?:${HEX}:){7}${HEX}|(?:${HEX}(?::${HEX})*)?::(?:${HEX}(?::${HEX})*)?)(?![0-9a-fA-F:])`, 'g');

export function maskAddresses(text: string): string {
  return text.replace(IPV4, 'xxx.xxx.xxx.$1').replace(IPV6, (address) => {
    const parts = address.split(':');
    return parts.map((part, i) => (part && i < parts.length - 1 ? 'xxxx' : part)).join(':');
  });
}
