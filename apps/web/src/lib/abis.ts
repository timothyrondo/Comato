/**
 * Minimal ABIs (viem `const` tuples) for the Comato UI.
 *
 * Read-only layer (live monitor):
 *   - Aave V3 Pool  → packages/contracts/src/interfaces/IAaveV3Pool.sol
 *   - Comato        → packages/contracts/src/ComatoPolicy.sol / ComatoExecutor.sol
 *
 * Wallet layer (subscribe + position flow — signed txns from the browser):
 *   - ComatoVault        → packages/contracts/src/ComatoVault.sol
 *   - ComatoVaultFactory → packages/contracts/src/ComatoVaultFactory.sol
 *   - erc20              → the CELO collateral approve/allowance path
 *
 * Only the members the UI touches are declared; layouts match the sources 1:1.
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

/*//////////////////////////////////////////////////////////////
                    WALLET LAYER — signed txns
//////////////////////////////////////////////////////////////*/

/**
 * ComatoVault — the subscriber's per-position vault. The browser drives the
 * OWNER actions (supply / borrow / repay / withdraw / setOperator) and reads the
 * live position; the OPERATOR-only `deleverage` is the off-chain agent's job and
 * is intentionally not exposed here.
 */
export const comatoVaultAbi = [
  {
    type: "function",
    name: "supply",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "borrow",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "repay",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "withdrawCollateral",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "to", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setOperator",
    stateMutability: "nonpayable",
    inputs: [{ name: "newOperator", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "healthFactor",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "hf", type: "uint256" }],
  },
  {
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
    name: "subscriber",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "collateralAsset",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "debtAsset",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "hfThreshold",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "targetHf",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "operator",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "event",
    name: "Deleveraged",
    inputs: [
      { name: "collateralWithdrawn", type: "uint256", indexed: false },
      { name: "debtRepaid", type: "uint256", indexed: false },
      { name: "fee", type: "uint256", indexed: false },
      { name: "hfBefore", type: "uint256", indexed: false },
      { name: "hfAfter", type: "uint256", indexed: false },
    ],
  },
] as const;

/** ComatoVaultFactory — deploy the caller's own vault + look it up by subscriber. */
export const comatoVaultFactoryAbi = [
  {
    type: "function",
    name: "createVault",
    stateMutability: "nonpayable",
    inputs: [
      { name: "collateralAsset", type: "address" },
      { name: "debtAsset", type: "address" },
      { name: "poolFee", type: "uint24" },
      { name: "operator", type: "address" },
      { name: "feeRecipient", type: "address" },
      { name: "feeBps", type: "uint256" },
      { name: "hfThreshold", type: "uint256" },
      { name: "targetHf", type: "uint256" },
    ],
    outputs: [{ name: "vault", type: "address" }],
  },
  {
    type: "function",
    name: "vaultOf",
    stateMutability: "view",
    inputs: [{ name: "subscriber", type: "address" }],
    outputs: [{ name: "vault", type: "address" }],
  },
  {
    type: "event",
    name: "VaultCreated",
    inputs: [
      { name: "subscriber", type: "address", indexed: true },
      { name: "vault", type: "address", indexed: true },
      { name: "operator", type: "address", indexed: false },
    ],
  },
] as const;

/** Minimal ERC-20 — the CELO collateral approve/allowance the vault's `supply` needs. */
export const erc20Abi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;
