import test from "node:test";
import assert from "node:assert/strict";
import { assertResolvedTargetBoundary } from "../src/protocol-boundary.js";
import { AppError } from "../src/schema.js";
const own = ["10.7.0.8", "2001:4860:4860::8888", "fd01::8%en0"];
function allowed(address: string) {
  assertResolvedTargetBoundary([{ address }], { ownAddresses: own });
}
function rejected(address: string) {
  assert.throws(() => allowed(address), AppError);
}
test("纯解析策略：正常公网及独立私网可用，保留业务内网边界", () => {
  for (const address of [
    "8.8.8.8",
    "10.7.0.9",
    "172.16.0.9",
    "192.168.10.9",
    "100.100.100.201",
    "fd00:ec2::255",
    "fd02::1",
    "2001:4860:4860::8844",
  ])
    allowed(address);
});
test("纯解析策略：最终DNS解析变化或混合结果不能引入metadata", () => {
  assertResolvedTargetBoundary([{ address: "8.8.8.8" }], { ownAddresses: own });
  for (const address of [
    "169.254.169.254",
    "100.100.100.200",
    "fd00:ec2::254",
    "::ffff:169.254.169.254",
    "::ffff:100.100.100.200",
    "[fd00:0ec2:0000:0000:0000:0000:0000:0254]",
  ]) {
    rejected(address);
    for (const rows of [
      [{ address: "8.8.8.8" }, { address }],
      [{ address }, { address: "8.8.8.8" }],
    ])
      assert.throws(
        () => assertResolvedTargetBoundary(rows, { ownAddresses: own }),
        AppError,
      );
  }
});
test("纯解析策略：所有特殊网络范围与转译IPv6均拒绝", () => {
  for (const address of [
    "127.0.0.1",
    "0.0.0.0",
    "169.254.1.1",
    "224.0.0.1",
    "255.255.255.255",
    "240.0.0.1",
    "192.0.2.1",
    "::",
    "::1",
    "fe80::1%en0",
    "ff02::1",
    "::ffff:127.0.0.1",
    "64:ff9b::a9fe:a9fe",
    "2002:a9fe:a9fe::1",
    "2001::1",
  ])
    rejected(address);
});
test("纯解析策略：本机地址在IPv4映射、IPv6展开与scope变化后仍被拒绝", () => {
  for (const address of [
    "10.7.0.8",
    "::ffff:10.7.0.8",
    "2001:4860:4860:0:0:0:0:8888",
    "fd01:0000:0000:0000:0000:0000:0000:0008%en1",
  ])
    rejected(address);
});
test("纯解析策略：空集合/无效DNS数据失败，不对外解析或发起连接", () => {
  assert.throws(
    () => assertResolvedTargetBoundary([], { ownAddresses: [] }),
    AppError,
  );
  for (const address of [
    "not-an-ip",
    "",
    "1.2.3.999",
    "http://8.8.8.8",
    "[8.8.8.8",
    "8.8.8.8%en0",
  ])
    rejected(address);
});
test("纯解析策略：临时fixture仅对loopback豁免，不豁免其他自身地址/metadata及特殊地址", () => {
  assertResolvedTargetBoundary([{ address: "127.0.0.1" }], {
    ownAddresses: own,
    allowLocalFixture: true,
  });
  for (const address of [
    "10.7.0.8",
    "169.254.169.254",
    "100.100.100.200",
    "fd00:ec2::254",
    "224.0.0.1",
    "fe80::1%en0",
  ])
    assert.throws(
      () =>
        assertResolvedTargetBoundary([{ address }], {
          ownAddresses: own,
          allowLocalFixture: true,
        }),
      AppError,
    );
});
