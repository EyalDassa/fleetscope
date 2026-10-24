import { describe, expect, it } from "vitest";
import { isLoopbackHost } from "./hosts";
import { buildDataSource, parseGrafanaUrl } from "./push";
import { testPassword } from "./test-fixtures";

describe("isLoopbackHost", () => {
  it("recognises every spelling of this machine", () => {
    for (const host of [
      "localhost",
      "LOCALHOST",
      "localhost.", // QA-M2-07: the root dot
      "app.localhost", // *.localhost resolves to loopback (RFC 6761)
      "app.localhost.",
      "127.0.0.1",
      "127.0.0.2", // QA-M2-07: the whole 127/8
      "127.255.255.254",
      "0.0.0.0", // QA-M2-07
      "0.1.2.3",
      "::1",
      "[::1]",
      "::",
      "[::]",
      "::ffff:127.0.0.1", // IPv4-mapped, dotted
      "::ffff:7f00:1", // the same, as the URL parser prints it
      "::ffff:7f00:2",
      "::ffff:0.0.0.0",
      "::127.0.0.1", // IPv4-compatible
      "0:0:0:0:0:0:0:1", // uncompressed ::1
      "host.docker.internal",
      "gateway.docker.internal",
    ]) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
  });

  it("does not take other hosts for this machine", () => {
    for (const host of [
      "",
      "grafana.net",
      "localhost.evil.com", // starts with localhost, is not it
      "notlocalhost",
      "mylocalhost",
      "evil-localhost.com",
      "128.0.0.1",
      "126.255.255.255",
      "10.0.0.1", // private, but not this machine
      "192.168.1.20",
      "8.8.8.8",
      "1.127.0.0.1x",
      "::2",
      "2001:db8::1",
      "fe80::1",
      "::ffff:8.8.8.8",
      "::ffff:808:808",
      "clickhouse", // a compose service name: a different machine from the point of view of a remote Grafana
      "abc.eu-central-1.aws.clickhouse.cloud",
    ]) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });

  it("works on what the URL parser hands over, for the odd spellings it normalises", () => {
    for (const url of [
      "http://127.1:8123", // -> 127.0.0.1
      "http://2130706433:8123", // decimal form of 127.0.0.1
      "http://0x7f.0.0.1:8123",
      "http://[::ffff:127.0.0.1]:8123",
      "http://[0:0:0:0:0:ffff:7f00:1]:8123",
      "http://LocalHost.:8123",
      "http://0:8123", // -> 0.0.0.0
    ]) {
      expect(isLoopbackHost(new URL(url).hostname), url).toBe(true);
    }
    expect(isLoopbackHost(new URL("http://8.8.8.8:8123").hostname)).toBe(false);
  });
});

describe("the push rules that use it", () => {
  const env = (url: string): NodeJS.ProcessEnv => ({
    CLICKHOUSE_URL: url,
    CLICKHOUSE_GRAFANA_USER: "grafana_ro",
    CLICKHOUSE_GRAFANA_PASSWORD: testPassword(),
  });

  it("refuses these ClickHouse addresses for a remote Grafana", () => {
    for (const url of [
      "http://127.0.0.2:8123",
      "http://0.0.0.0:8123",
      "http://localhost.:8123",
      "http://127.1:8123",
      "http://[::ffff:127.0.0.1]:8123",
      "http://db.localhost:8123",
    ]) {
      expect(() => buildDataSource(env(url), false), url).toThrow(/your own machine/);
    }
  });

  it("allows them for a Grafana on this machine, and a public host for either", () => {
    expect(() => buildDataSource(env("http://127.0.0.2:8123"), true)).not.toThrow();
    expect(() => buildDataSource(env("https://abc.clickhouse.cloud:8443"), false)).not.toThrow();
  });

  it("accepts plain http for GRAFANA_URL on any loopback spelling, and only there", () => {
    expect(parseGrafanaUrl("http://127.0.0.2:3001").local).toBe(true);
    expect(parseGrafanaUrl("http://localhost.:3001").local).toBe(true);
    expect(() => parseGrafanaUrl("http://10.0.0.5:3001")).toThrow(/https/);
  });
});
