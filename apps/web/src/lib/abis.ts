/**
 * Minimal read-only ABIs (viem `const` tuples) for the live-data layer.
 * Layouts mirror the verified sources:
 *   - Aave V3 Pool  → packages/contracts/src/interfaces/IAaveV3Pool.sol
 *   - Comato        → packages/contracts/src/ComatoPolicy.sol / ComatoExecutor.sol
 * Only the members the UI reads are declared.
 */

/** Aave V3 Pool — the account-data read that yields the health factor. */
export const aavePoolAbi = [
  {
    type: "function",
    name: "getUserAccountData",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [
      { name: "totalCollateralBase", type: "uint256" },
      { name: "totalDebtBase", type: "uint256" },
      { name: "availableBorrowsBase", type: "uint256" },
      { name: "currentLiquidationThreshold", type: "uint256" },
      { name: "ltv", type: "uint256" },
      { name: "healthFactor", type: "uint256" },
    ],
  },
] as const;

/** ComatoPolicy — read a policy record (threshold, assets, active). */
export const comatoPolicyAbi = [
  {
    type: "function",
    name: "getPolicy",
    stateMutability: "view",
    inputs: [{ name: "policyId", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "subscriber", type: "address" },
          { name: "collateralAsset", type: "address" },
          { name: "debtAsset", type: "address" },
          { name: "hfThreshold", type: "uint256" },
          { name: "rescueCap", type: "uint256" },
          { name: "premiumRatePerInterval", type: "uint256" },
          { name: "active", type: "bool" },
        ],
      },
    ],
  },
] as const;

/** ComatoExecutor — the RescueExecuted event drives the rescue history feed. */
export const comatoExecutorAbi = [
  {
    type: "event",
    name: "RescueExecuted",
    inputs: [
      { name: "policyId", type: "uint256", indexed: true },
      { name: "subscriber", type: "address", indexed: true },
      { name: "asset", type: "address", indexed: true },
      { name: "amountRepaid", type: "uint256", indexed: false },
      { name: "hfBefore", type: "uint256", indexed: false },
      { name: "hfAfter", type: "uint256", indexed: false },
    ],
  },
] as const;
