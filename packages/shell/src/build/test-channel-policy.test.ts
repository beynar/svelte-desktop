import { expect, test } from "bun:test";
import { keepsTestChannel } from "./test-channel-policy.ts";

test("a build signed to be distributed has no test channel; any other keeps it", () => {
  expect(keepsTestChannel({}, {})).toBe(true);
  expect(keepsTestChannel({ sign: { identity: "-" } }, {})).toBe(true); // ad-hoc: this machine's
  expect(keepsTestChannel({}, { CODESIGN_IDENTITY: "-" })).toBe(true);
  expect(keepsTestChannel({ sign: { identity: "Developer ID Application: A" } }, {})).toBe(false);
  expect(keepsTestChannel({}, { CODESIGN_IDENTITY: "Developer ID Application: A" })).toBe(false);
  expect(keepsTestChannel({ sign: { windows: { certificateFile: "c.pfx" } } }, {})).toBe(false);
  expect(keepsTestChannel({ sign: { windows: { command: ["sign", "{file}"] } } }, {})).toBe(false);
  expect(keepsTestChannel({}, { WINDOWS_CERT_PFX: "c.pfx" })).toBe(false);
});

test("kitop build --release has none, signed or not, whatever else is set", () => {
  expect(keepsTestChannel({}, { KITOP_RELEASE: "1" })).toBe(false);
  expect(keepsTestChannel({}, { KITOP_RELEASE: "1", KITOP_TEST_BUILD: "1" })).toBe(false);
});

test("KITOP_TEST_BUILD keeps it, to test a signed build", () => {
  expect(keepsTestChannel({ sign: { identity: "Developer ID Application: A" } }, { KITOP_TEST_BUILD: "1" })).toBe(true);
});
