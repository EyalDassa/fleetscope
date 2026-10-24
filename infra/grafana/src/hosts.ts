// Does a host name mean "this machine"? Used by grafana:push in two places:
//   - GRAFANA_URL may be plain http only when Grafana is on this machine;
//   - a ClickHouse URL that points at this machine is useless for a remote Grafana, because the
//     Grafana server (not your browser) connects to ClickHouse and cannot reach your laptop.
//
// The input is `URL.hostname`, which the URL parser has already normalised: 127.1, 0x7f.0.0.1 and
// 2130706433 all arrive as 127.0.0.1, and an IPv6 address arrives in brackets and compressed
// ([::ffff:127.0.0.1] becomes [::ffff:7f00:1]). So only the normalised forms need handling here.
import { isIPv4, isIPv6 } from "node:net";

/** Names Docker Desktop gives to the machine it runs on (host.docker.internal and friends). */
const DOCKER_HOST_SUFFIX = ".docker.internal";

function isLocalIPv4(address: string): boolean {
  const first = Number(address.split(".")[0]);
  // 127.0.0.0/8 is loopback; 0.0.0.0/8 is "this host" (0.0.0.0 connects to localhost on Linux).
  return first === 127 || first === 0;
}

/** Expands an IPv6 address (no brackets, no zone) into its 8 groups of 16 bits. */
function ipv6Groups(address: string): number[] | undefined {
  let text = address;
  // An embedded dotted IPv4 tail (::ffff:127.0.0.1) takes the place of the last two groups.
  const tail = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail) {
    const octets = (tail[2] as string).split(".").map(Number);
    if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
      return undefined;
    }
    const high = ((octets[0] as number) << 8) | (octets[1] as number);
    const low = ((octets[2] as number) << 8) | (octets[3] as number);
    text = `${tail[1]}${high.toString(16)}:${low.toString(16)}`;
  }
  const [head = "", rest, ...extra] = text.split("::");
  if (extra.length > 0) return undefined;
  const left = head === "" ? [] : head.split(":");
  const right = rest === undefined || rest === "" ? [] : rest.split(":");
  const missing = 8 - left.length - right.length;
  if (rest === undefined ? missing !== 0 : missing < 1) return undefined;
  const groups = [
    ...left,
    ...new Array<string>(rest === undefined ? 0 : missing).fill("0"),
    ...right,
  ];
  const numbers = groups.map((g) => Number.parseInt(g, 16));
  return numbers.length === 8 && numbers.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff)
    ? numbers
    : undefined;
}

function isLocalIPv6(address: string): boolean {
  const groups = ipv6Groups(address);
  if (!groups) return false;
  const firstFiveZero = groups.slice(0, 5).every((g) => g === 0);
  if (firstFiveZero && groups[5] === 0 && groups[6] === 0 && (groups[7] === 0 || groups[7] === 1)) {
    return true; // :: (unspecified) and ::1 (loopback)
  }
  // ::ffff:a.b.c.d (IPv4-mapped) carries an IPv4 address: judge it like the IPv4 address.
  const first = (groups[6] as number) >> 8;
  if (firstFiveZero && groups[5] === 0xffff) return first === 127 || first === 0;
  // ::a.b.c.d (IPv4-compatible, deprecated) only counts for 127/8; `::2` is just some address.
  if (firstFiveZero && groups[5] === 0) return first === 127;
  return false;
}

export function isLoopbackHost(hostname: string): boolean {
  let host = hostname.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  // "localhost." (a fully qualified name with the root dot) is the same host.
  host = host.replace(/\.+$/, "");
  if (host === "") return false;

  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(DOCKER_HOST_SUFFIX)) return true;
  if (isIPv4(host)) return isLocalIPv4(host);
  if (isIPv6(host)) return isLocalIPv6(host);
  return false;
}
