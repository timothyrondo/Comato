// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IAaveV3Pool
/// @notice Minimal subset of the Aave V3 `Pool` interface used by Comato.
/// @dev Targets the live Celo deployment at `0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402`.
///      The `ReserveData` struct layout was verified against that contract (the "legacy" V3
///      layout: `getReserveData(USDC).aTokenAddress == 0xFF8309b9e99bfd2D4021bc71a362aBD93dBd4785`).
///      Only the members Comato touches are declared; the full Aave interface is intentionally omitted.
interface IAaveV3Pool {
    /// @notice Packed reserve configuration bitmap (ltv, liquidation threshold, flags, ...).
    struct ReserveConfigurationMap {
        uint256 data;
    }

    /// @notice On-chain reserve accounting returned by {getReserveData}.
    /// @dev Field order matches the deployed Celo Pool; do not reorder.
    struct ReserveData {
        ReserveConfigurationMap configuration;
        uint128 liquidityIndex;
        uint128 currentLiquidityRate;
        uint128 variableBorrowIndex;
        uint128 currentVariableBorrowRate;
        uint128 currentStableBorrowRate;
        uint40 lastUpdateTimestamp;
        uint16 id;
        address aTokenAddress;
        address stableDebtTokenAddress;
        address variableDebtTokenAddress;
        address interestRateStrategyAddress;
        uint128 accruedToTreasury;
        uint128 unbacked;
        uint128 isolationModeTotalDebt;
    }

    /// @notice Aggregated risk data for a borrower, all base-currency amounts in 8 decimals.
    /// @param user The account to query.
    /// @return totalCollateralBase Total collateral in the pool base currency.
    /// @return totalDebtBase Total debt in the pool base currency.
    /// @return availableBorrowsBase Borrowing power still available.
    /// @return currentLiquidationThreshold Weighted liquidation threshold (bps).
    /// @return ltv Weighted max loan-to-value (bps).
    /// @return healthFactor Position health factor in WAD (1e18); `< 1e18` is liquidatable.
    function getUserAccountData(address user)
        external
        view
        returns (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            uint256 availableBorrowsBase,
            uint256 currentLiquidationThreshold,
            uint256 ltv,
            uint256 healthFactor
        );

    /// @notice Reserve accounting (token addresses, indexes, rates) for `asset`.
    function getReserveData(address asset) external view returns (ReserveData memory);

    /// @notice Supplies `amount` of `asset`, crediting collateral to `onBehalfOf`.
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;

    /// @notice Borrows `amount` of `asset` against `onBehalfOf`'s collateral.
    /// @param interestRateMode 1 = stable, 2 = variable. Comato uses variable (2).
    function borrow(
        address asset,
        uint256 amount,
        uint256 interestRateMode,
        uint16 referralCode,
        address onBehalfOf
    ) external;

    /// @notice Repays up to `amount` of `onBehalfOf`'s debt in `asset`. Pulls funds from `msg.sender`.
    /// @param interestRateMode 1 = stable, 2 = variable.
    /// @return The final amount repaid (capped at the outstanding debt).
    function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf)
        external
        returns (uint256);

    /// @notice Withdraws `amount` of `asset` collateral to `to`.
    /// @return The final amount withdrawn.
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
}
