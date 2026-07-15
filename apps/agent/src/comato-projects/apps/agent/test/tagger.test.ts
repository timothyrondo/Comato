/**
 * Tagger tests — the C1 mechanism. Verifies the ERC-8021 marker
 * (0x80218021...) is appended, the code is embedded, and round-trip
 * decode/verify works. If these fail, Track 1 volume silently drops to zero.
 */

import { describe, expect, test } from "bun:test";
import { encodeFunctionData, concat, type Hex } from "viem";
import {
  buildTagSuffix,
  tagCalldata,
  endsWithMarker,
  containsMarker,
  decodeTag,
  verifyTaggedTx,
  ERC_8021_MARKER,
  MARKER_HEX,
} from "../src/tagger.ts";
import { aavePoolAbi } from "../src/abis.ts";

const CODE = "timo_comato";
const MARKER_NO_0X = "80218021802180218021802180218021";

describe("tagger / ERC-8021 (C1)", () => {
  test("marker constant is the exact 16-byte Dune filter marker", () => {
    expect(ERC_8021_MARKER).toBe("0x80218021802180218021802180218021");
    expect(MARKER_HEX).toBe(MARKER_NO_0X);
  });

  test("suffix ends with the marker and embeds the code (ascii)", () => {
    const suffix = buildTagSuffix(CODE);
    expect(endsWithMarker(suffix)).toBe(true);
    // "timo_comato" ascii hex must appear before the length/schema/marker.
    const codeHex = Buffer.from(CODE, "utf8").toString("hex");
    expect(suffix.toLowerCase()).toContain(codeHex);
    // layout: 0x <code> <len=0b> <schema=00> <marker>
    expect(suffix.toLowerCase().endsWith(`0b00${MARKER_NO_0X}`)).toBe(true);
  });

  test("tagCalldata appends the marker to real calldata (repay)", () => {
    const raw = encodeFunctionData({
      abi: aavePoolAbi,
      functionName: "repay",
      args: [
        "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
        1_000_000n,
        2n,
        "0x00000000000000000000000000000000000000A1",
      ],
    });
    const tagged = tagCalldata(raw, CODE);
    expect(tagged.startsWith(raw)).toBe(true); // original calldata preserved
    expect(endsWithMarker(tagged)).toBe(true); // marker at the very end
    expect(containsMarker(tagged)).toBe(true);
    expect(tagged.length).toBeGreaterThan(raw.length);
  });

  test("untagged calldata does NOT contain the marker", () => {
    const raw = encodeFunctionData({
      abi: aavePoolAbi,
      functionName: "repay",
      args: [
        "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
        1n,
        2n,
        "0x00000000000000000000000000000000000000A1",
      ],
    });
    expect(containsMarker(raw)).toBe(false);
    expect(endsWithMarker(raw)).toBe(false);
  });

  test("decodeTag round-trips the code and schema", () => {
    const suffix = buildTagSuffix(CODE);
    const decoded = decodeTag(suffix);
    expect(decoded).not.toBeNull();
    expect(decoded!.codes).toEqual([CODE]);
    expect(decoded!.schemaId).toBe(0);
  });

  test("multiple codes are supported", () => {
    const suffix = buildTagSuffix([CODE, "celo_defai"]);
    expect(endsWithMarker(suffix)).toBe(true);
    expect(decodeTag(suffix)!.codes).toEqual([CODE, "celo_defai"]);
  });

  test("verifyTaggedTx confirms our code on a tagged tx input", async () => {
    const raw = encodeFunctionData({
      abi: aavePoolAbi,
      functionName: "repay",
      args: [
        "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
        1n,
        2n,
        "0x00000000000000000000000000000000000000A1",
      ],
    });
    const tagged = concat([raw, buildTagSuffix(CODE)]) as Hex;
    const mockClient = {
      getTransaction: async (_: { hash: `0x${string}` }) => ({ input: tagged }),
    };
    expect(await verifyTaggedTx(mockClient, "0xabc" as `0x${string}`, CODE)).toBe(true);
    expect(await verifyTaggedTx(mockClient, "0xabc" as `0x${string}`, "someone_else")).toBe(false);
  });

  test("verifyTaggedTx returns false for an untagged tx", async () => {
    const mockClient = {
      getTransaction: async () => ({ input: "0xdeadbeef" }),
    };
    expect(await verifyTaggedTx(mockClient, "0xabc" as `0x${string}`)).toBe(false);
  });
});
