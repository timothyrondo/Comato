/**
 * Minimal ABIs (viem `const` tuples) for the contracts the agent touches.
 * Layouts are copied from the verified sources:
 *   - Aave V3 Pool  -> packages/contracts/src/interfaces/IAaveV3Pool.sol
 *   - SwapRouter02  -> Uniswap IV3SwapRouter (7-field ExactInputSingleParams, NO deadline)
 *   - Comato        -> packages/contracts/src/ComatoPolicy.sol / ComatoExecutor.sol
 * Only the members the agent uses are declared.
 */

export const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
] as const;

/** Aave V3 Pool — subset used by the agent (health factor, reserve tokens, repay). */
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
  {
    // Field order matches IAaveV3Pool.ReserveData exactly; index 10 = variableDebtTokenAddress.
    type: "function",
    name: "getReserveData",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [
      {
        type: "tuple",
        components: [
          {
            name: "configuration",
            type: "tuple",
            components: [{ name: "data", type: "uint256" }],
          },
          { name: "liquidityIndex", type: "uint128" },
          { name: "currentLiquidityRate", type: "uint128" },
          { name: "variableBorrowIndex", type: "uint128" },
          { name: "currentVariableBorrowRate", type: "uint128" },
          { name: "currentStableBorrowRate", type: "uint128" },
          { name: "lastUpdateTimestamp", type: "uint40" },
          { name: "id", type: "uint16" },
          { name: "aTokenAddress", type: "address" },
          { name: "stableDebtTokenAddress", type: "address" },
          { name: "variableDebtTokenAddress", type: "address" },
          { name: "interestRateStrategyAddress", type: "address" },
          { name: "accruedToTreasury", type: "uint128" },
          { name: "unbacked", type: "uint128" },
          { name: "isolationModeTotalDebt", type: "uint128" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "repay",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "interestRateMode", type: "uint256" },
      { name: "onBehalfOf", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

/** Uniswap SwapRouter02 (IV3SwapRouter) — exactInputSingle, 7-field struct, no deadline. */
export const swapRouter02Abi = [
  {
    type: "function",
    name: "exactInputSingle",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

/** ComatoPolicy — read a policy record (safety-path rescue authorization). */
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

/**
 * ComatoVault (Model C) — per-subscriber non-custodial Aave guard. The operator
 * (COMATO_WALLET) has exactly one power: `deleverage`, bounded by the vault to fire
 * only while HF < hfThreshold and only up to targetHf. Layout copied from
 * packages/contracts/src/ComatoVault.sol. Views are used to size the deleverage.
 *
 * NOTE on attribution: `deleverage` moves the SUBSCRIBER'S own funds inside the
 * vault (Aave pulls from the vault, the swap router pulls from the vault), so its
 * legs are contract-internal and do NOT count for Track 1 (C1) — the same trade-off
 * as ComatoExecutor. This is the non-custodial SAFETY path; the Track-1 volume path
 * stays EOA-direct (treasury.ts / rescue.ts EOA-direct repay).
 */
export const comatoVaultAbi = [
  {
    type: "function",
    name: "deleverage",
    stateMutability: "nonpayable",
    inputs: [
      { name: "collateralIn", type: "uint256" },
      { name: "minDebtOut", type: "uint256" },
    ],
    outputs: [{ name: "repaid", type: "uint256" }],
  },
  {
    type: "function",
    name: "healthFactor",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "hf", type: "uint256" }],
  },
  {
    // Aggregate position in Aave base units (USD, 8 dec) + HF (WAD).
    type: "function",
    name: "position",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "collateralBase", type: "uint256" },
      { name: "debtBase", type: "uint256" },
      { name: "hf", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "collateralAsset",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "debtAsset",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "poolFee",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint24" }],
  },
  {
    type: "function",
    name: "hfThreshold",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "targetHf",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "feeBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "subscriber",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
] as const;

/**
 * Aave V3 AaveProtocolDataProvider — per-asset reserve risk parameters. The
 * deleverage deliberation reads `liquidationBonus` (bps offset, e.g. 10750 = a
 * 7.5% seize penalty on liquidation) to weigh the rescue's cost against the
 * penalty it prevents. Returned as separate uints (no bitmap decoding needed).
 */
export const protocolDataProviderAbi = [
  {
    type: "function",
    name: "getReserveConfigurationData",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [
      { name: "decimals", type: "uint256" },
      { name: "ltv", type: "uint256" },
      { name: "liquidationThreshold", type: "uint256" },
      { name: "liquidationBonus", type: "uint256" },
      { name: "reserveFactor", type: "uint256" },
      { name: "usageAsCollateralEnabled", type: "bool" },
      { name: "borrowingEnabled", type: "bool" },
      { name: "stableBorrowRateEnabled", type: "bool" },
      { name: "isActive", type: "bool" },
      { name: "isFrozen", type: "bool" },
    ],
  },
] as const;

/**
 * Uniswap QuoterV2 — off-chain min-out sizing for the deleverage swap.
 *
 * Param tuple order is (tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96) —
 * NOTE this DIFFERS from SwapRouter02's ExactInputSingleParams (which puts `fee`
 * before `amountIn`). Declared `view` so viem `readContract` (an `eth_call`) can
 * type-check and invoke it; the deployed QuoterV2 marks the fn `nonpayable`
 * (it uses the swap-and-revert trick internally), but `eth_call` runs it fine.
 */
export const quoterV2Abi = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "view",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

/** ComatoExecutor — the atomic safety path (does NOT earn Track 1; see C1). */
export const comatoExecutorAbi = [
  {
    type: "function",
    name: "rescue",
    stateMutability: "nonpayable",
    inputs: [{ name: "policyId", type: "uint256" }],
    outputs: [{ name: "amountRepaid", type: "uint256" }],
  },
  {
    type: "function",
    name: "healthFactorOf",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ name: "healthFactor", type: "uint256" }],
  },
  {
    type: "function",
    name: "floatOf",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;
