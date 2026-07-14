/**
 * ERC-8021 attribution tagger — the mechanism behind **C1** (Track 1 volume).
 *
 * Track 1 only counts a token transfer when it lives inside a tx whose calldata
 * (a) contains our attribution code and (b) ends with the 16-byte marker
 * `0x80218021...`. `@celo/attribution-tags` `toDataSuffix(code)` produces exactly
 * that suffix: `<ascii code><lenByte><schemaByte><16-byte marker>`. We append it
 * to EVERY EOA-direct tx via `concat([callData, suffix])`, so the pulled transfer
 * (`from == tx_from == COMATO_WALLET`) is attributed to us.
 *
 * Relayers can strip a data suffix — that is why counted actions MUST be
 * EOA-direct (viem `sendTransaction`), never routed through a relayer/facilitator.
 */

import { concat, type Hex } from "viem";
import {
  toDataSuffix,
  fromDataSuffix,
  verifyTx as verifyTxLib,
  ERC_8021_MARKER,
} from "@celo/attribution-tags";

export { ERC_8021_MARKER };

/** The 16-byte marker without the leading 0x, for substring checks. */
export const MARKER_HEX = ERC_8021_MARKER.slice(2).toLowerCase();

/** Build the ERC-8021 data suffix for `code` (single code or multiple). */
export function buildTagSuffix(code: string | readonly string[]): Hex {
  return toDataSuffix(code);
}

/**
 * Append the attribution suffix to raw calldata. This is THE tagging call —
 * use it for every EOA-direct tx (rescues, treasury swaps, approvals).
 */
export function tagCalldata(callData: Hex, code: string | readonly string[]): Hex {
  return concat([callData, buildTagSuffix(code)]);
}

/** True if `data` ends with the ERC-8021 marker (what the Dune filter checks). */
export function endsWithMarker(data: Hex): boolean {
  return data.toLowerCase().endsWith(MARKER_HEX);
}

/** True if `data` contains the ERC-8021 marker anywhere. */
export function containsMarker(data: Hex): boolean {
  return data.toLowerCase().includes(MARKER_HEX);
}

/** Decode the codes/schema out of a tagged calldata suffix (null if untagged). */
export function decodeTag(data: Hex): { codes: string[]; schemaId: number } | null {
  return fromDataSuffix(data);
}

export interface VerifyTxClient {
  getTransaction(args: { hash: `0x${string}` }): Promise<{ input?: string } | null | undefined>;
}

/**
 * Verify an on-chain tx actually carried our tag. Fetches the tx input and
 * decodes the suffix; returns true iff `expectedCode` is present. Use this to
 * confirm a counted action landed tagged (post-send audit).
 */
export async function verifyTaggedTx(
  client: VerifyTxClient,
  hash: `0x${string}`,
  expectedCode?: string,
): Promise<boolean> {
  const decoded = await verifyTxLib({ client, hash });
  if (!decoded) return false;
  if (expectedCode) return decoded.codes.includes(expectedCode);
  return decoded.codes.length > 0;
}
