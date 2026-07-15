/**
 * Monitor — polls each subscriber's Aave V3 account data and derives a health
 * factor. `Pool.getUserAccountData(user)` returns HF in WAD (1e18); `< 1e18` is
 * liquidatable. A position is "breached" (rescue candidate) when HF drops below
 * the subscriber's configured `hfThreshold`.
 *
 * Reads only — no tx, no attribution. The counted actions are downstream
 * (rescue.ts, treasury.ts).
 */

import { formatUnits, type Address, type PublicClient } from "viem";
import { MAINNET } from "@comato/shared/addresses";
import { aavePoolAbi } from "./abis.ts";
import { withRetry } from "./retry.ts";
import type { Config, SubscriberConfig } from "./config.ts";
import type { Logger } from "./logger.ts";

const POOL = MAINNET.aaveV3.pool as Address;

/** viem returns MaxUint256 for HF when a user has no debt (infinitely healthy). */
export const HF_NO_DEBT = (1n << 256n) - 1n;

export interface HealthSnapshot {
  subscriber: Address;
  healthFactor: bigint; // WAD
  hfThreshold: bigint; // WAD
  totalCollateralBase: bigint; // USD, 8 dec
  totalDebtBase: bigint; // USD, 8 dec
  hasDebt: boolean;
  breached: boolean;
  at: number;
}

export function isBreached(hf: bigint, threshold: bigint, hasDebt: boolean): boolean {
  return hasDebt && hf < threshold;
}

export class Monitor {
  constructor(
    private readonly publicClient: PublicClient,
    private readonly config: Config,
    private readonly log: Logger,
  ) {}

  async pollSubscriber(sub: SubscriberConfig): Promise<HealthSnapshot> {
    const [totalCollateralBase, totalDebtBase, , , , healthFactor] = await withRetry(
      () =>
        this.publicClient.readContract({
          address: POOL,
          abi: aavePoolAbi,
          functionName: "getUserAccountData",
          args: [sub.address],
        }),
      { label: `monitor.read.${sub.address}`, logger: this.log, retries: 4 },
    );

    const hasDebt = totalDebtBase > 0n;
    const breached = isBreached(healthFactor, sub.hfThreshold, hasDebt);

    const snap: HealthSnapshot = {
      subscriber: sub.address,
      healthFactor,
      hfThreshold: sub.hfThreshold,
      totalCollateralBase,
      totalDebtBase,
      hasDebt,
      breached,
      at: Date.now(),
    };

    this.log.info("health snapshot", {
      event: "monitor.snapshot",
      subscriber: sub.address,
      hf: healthFactor === HF_NO_DEBT ? "inf" : formatUnits(healthFactor, 18),
      threshold: formatUnits(sub.hfThreshold, 18),
      collateralUsd: formatUnits(totalCollateralBase, 8),
      debtUsd: formatUnits(totalDebtBase, 8),
      breached,
    });

    return snap;
  }

  async pollAll(): Promise<HealthSnapshot[]> {
    const results: HealthSnapshot[] = [];
    for (const sub of this.config.subscribers) {
      try {
        results.push(await this.pollSubscriber(sub));
      } catch (err) {
        this.log.error("failed to poll subscriber", {
          event: "monitor.error",
          subscriber: sub.address,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return results;
  }
}
