import { describe, expect, it } from "vitest";
import { isPrivateOrReservedAddress } from "../../src/authz/network-guard.js";

describe("isPrivateOrReservedAddress", () => {
  it("flags RFC1918 IPv4 ranges", () => {
    expect(isPrivateOrReservedAddress("10.0.0.1")).toBe(true);
    expect(isPrivateOrReservedAddress("172.16.5.5")).toBe(true);
    expect(isPrivateOrReservedAddress("172.31.255.254")).toBe(true);
    expect(isPrivateOrReservedAddress("192.168.1.1")).toBe(true);
  });

  it("flags loopback and link-local IPv4", () => {
    expect(isPrivateOrReservedAddress("127.0.0.1")).toBe(true);
    expect(isPrivateOrReservedAddress("169.254.169.254")).toBe(true); // cloud metadata endpoint
  });

  it("flags CGNAT and reserved/multicast IPv4", () => {
    expect(isPrivateOrReservedAddress("100.64.0.1")).toBe(true);
    expect(isPrivateOrReservedAddress("224.0.0.1")).toBe(true);
    expect(isPrivateOrReservedAddress("255.255.255.255")).toBe(true);
  });

  it("does not flag ordinary public IPv4 addresses", () => {
    expect(isPrivateOrReservedAddress("8.8.8.8")).toBe(false);
    expect(isPrivateOrReservedAddress("1.1.1.1")).toBe(false);
    expect(isPrivateOrReservedAddress("172.15.0.1")).toBe(false); // just outside 172.16/12
    expect(isPrivateOrReservedAddress("172.32.0.1")).toBe(false); // just outside 172.16/12
  });

  it("flags IPv6 loopback, link-local and unique-local", () => {
    expect(isPrivateOrReservedAddress("::1")).toBe(true);
    expect(isPrivateOrReservedAddress("fe80::1")).toBe(true);
    expect(isPrivateOrReservedAddress("fc00::1")).toBe(true);
    expect(isPrivateOrReservedAddress("fd12:3456:789a::1")).toBe(true);
  });

  it("unwraps IPv4-mapped IPv6 addresses before checking", () => {
    expect(isPrivateOrReservedAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateOrReservedAddress("::ffff:8.8.8.8")).toBe(false);
  });

  it("does not flag a public IPv6 address", () => {
    expect(isPrivateOrReservedAddress("2606:4700:4700::1111")).toBe(false);
  });

  it("fails closed on unrecognized input", () => {
    expect(isPrivateOrReservedAddress("not-an-ip")).toBe(true);
  });
});
