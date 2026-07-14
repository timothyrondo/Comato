// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IAaveV3Pool} from "../../src/interfaces/IAaveV3Pool.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Deterministic Aave V3 Pool stand-in for unit tests.
/// @dev Models a single-collateral / single-debt position per user. Amounts are kept in one
///      abstract unit (only their ratio matters for the health factor), so `collateral` and
///      `debt` are comparable directly. Health factor is `collateral * ltBps / 1e4 / debt` in WAD.
///      `repay` pulls the debt token from `msg.sender` (mirroring Aave's `transferFrom`) and reduces
///      the tracked debt, which raises the health factor exactly like the real pool.
contract MockAavePool is IAaveV3Pool {
    uint256 private constant WAD = 1e18;
    uint256 private constant BPS = 1e4;

    struct Account {
        uint256 collateral; // weighted-comparable collateral units
        uint256 debt; // debt-token units outstanding
        uint256 ltBps; // liquidation threshold in bps
    }

    mapping(address user => Account) public accounts;

    /// @notice Test helper: set a user's synthetic Aave position.
    function setAccount(address user, uint256 collateral, uint256 debt, uint256 ltBps) external {
        accounts[user] = Account(collateral, debt, ltBps);
    }

    /// @inheritdoc IAaveV3Pool
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
        )
    {
        Account memory a = accounts[user];
        totalCollateralBase = a.collateral;
        totalDebtBase = a.debt;
        availableBorrowsBase = 0;
        currentLiquidationThreshold = a.ltBps;
        ltv = a.ltBps;
        healthFactor =
            a.debt == 0 ? type(uint256).max : (a.collateral * a.ltBps * WAD) / (BPS * a.debt);
    }

    /// @inheritdoc IAaveV3Pool
    /// @dev Pulls `min(amount, debt)` of `asset` from the caller and reduces the tracked debt.
    function repay(address asset, uint256 amount, uint256, address onBehalfOf)
        external
        returns (uint256)
    {
        Account storage a = accounts[onBehalfOf];
        uint256 actual = amount < a.debt ? amount : a.debt;
        a.debt -= actual;
        IERC20(asset).transferFrom(msg.sender, address(this), actual);
        return actual;
    }

    // --- Unused-in-unit-tests stubs (present to satisfy the interface) ---

    function getReserveData(address) external pure returns (ReserveData memory data) {
        return data;
    }

    function supply(address asset, uint256 amount, address, uint16) external {
        IERC20(asset).transferFrom(msg.sender, address(this), amount);
    }

    function borrow(address asset, uint256 amount, uint256, uint16, address) external {
        IERC20(asset).transfer(msg.sender, amount);
    }

    function withdraw(address asset, uint256 amount, address to) external returns (uint256) {
        IERC20(asset).transfer(to, amount);
        return amount;
    }
}
