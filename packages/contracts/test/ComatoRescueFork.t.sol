// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ComatoExecutor} from "../src/ComatoExecutor.sol";
import {ComatoPolicy} from "../src/ComatoPolicy.sol";
import {IAaveV3Pool} from "../src/interfaces/IAaveV3Pool.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";

/// @notice Fork integration test against the live Aave V3 pool on Celo mainnet (chain 42220).
/// @dev Scenario: a subscriber supplies USDT collateral and borrows USDC up to near the LTV limit,
///      leaving the health factor just above 1. A policy is created with a threshold above that HF
///      (a genuine "position sitting at the edge of liquidation" state). The {ComatoExecutor} then
///      repays part of the USDC debt from its float and the health factor is asserted to rise back
///      above the policy threshold.
///
///      Requires network access to https://forno.celo.org. If the RPC is unreachable this whole
///      file fails to set up; the unit suites (ComatoPolicy.t.sol / ComatoExecutor.t.sol) are
///      fork-independent and still verify all contract logic.
contract ComatoRescueForkTest is Test {
    // --- Verified Celo mainnet addresses (packages/shared/src/addresses.ts) ---
    address internal constant POOL = 0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402;
    address internal constant USDC = 0xcebA9300f2b948710d2653dD7B07f33A8B32118C; // 6 dec, debt asset
    address internal constant USDT = 0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e; // 6 dec, collateral

    uint256 internal constant VARIABLE_RATE_MODE = 2;
    uint16 internal constant REFERRAL = 0;

    IAaveV3Pool internal pool;
    ComatoPolicy internal registry;
    ComatoExecutor internal executor;

    address internal owner = makeAddr("owner");
    address internal subscriber = makeAddr("subscriber");

    bool internal forked;

    function setUp() public {
        // Create the Celo fork. If the RPC endpoint is missing/unreachable, skip gracefully.
        try vm.createSelectFork(vm.rpcUrl("celo")) {
            forked = true;
        } catch {
            forked = false;
            return;
        }
        assertEq(block.chainid, 42_220, "not on Celo mainnet fork");

        pool = IAaveV3Pool(POOL);
        registry = new ComatoPolicy(owner);
        executor = new ComatoExecutor(POOL, address(registry), owner);
    }

    /// @dev Supplies USDT collateral and borrows USDC to ~99% of LTV, leaving HF just above 1.
    /// @return borrowedUsdc The USDC amount borrowed.
    function _openEdgePosition() internal returns (uint256 borrowedUsdc) {
        uint256 collateralAmount = 2000e6; // 2,000 USDT

        deal(USDT, subscriber, collateralAmount);

        vm.startPrank(subscriber);
        IERC20(USDT).approve(POOL, collateralAmount);
        pool.supply(USDT, collateralAmount, subscriber, REFERRAL);

        (,, uint256 availableBorrowsBase,,,) = pool.getUserAccountData(subscriber);
        // Base currency is USD with 8 decimals; USDC (~$1) has 6 decimals => USDC ≈ base / 1e2.
        // Borrow 99% of the available headroom so HF lands just above 1.
        borrowedUsdc = (availableBorrowsBase * 99) / 100 / 100;
        pool.borrow(USDC, borrowedUsdc, VARIABLE_RATE_MODE, REFERRAL, subscriber);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                        EXECUTOR RESCUE (SAFETY PATH)
    //////////////////////////////////////////////////////////////*/

    function test_Fork_ExecutorRescue_RestoresHealthFactor() public {
        if (!forked) return;

        uint256 borrowedUsdc = _openEdgePosition();

        (,,,,, uint256 hfBefore) = pool.getUserAccountData(subscriber);
        assertLt(hfBefore, 2e18, "position should be near the edge, not deeply healthy");
        assertGt(hfBefore, 1e18, "position still solvent before rescue");

        // Threshold set above the current HF so the position is "breached" for protection purposes.
        uint256 threshold = hfBefore + 0.02e18;
        // Repay a quarter of the debt -> HF rises ~33%, comfortably above threshold.
        uint256 rescueCap = borrowedUsdc / 4;

        vm.prank(subscriber);
        uint256 policyId = registry.createPolicy(USDT, USDC, threshold, rescueCap, 1e5);

        // Fund the executor's USDC float generously.
        deal(USDC, address(executor), rescueCap + 100e6);

        vm.prank(owner);
        uint256 repaid = executor.rescue(policyId);

        (,,,,, uint256 hfAfter) = pool.getUserAccountData(subscriber);

        assertGt(repaid, 0, "something was repaid");
        assertLe(repaid, rescueCap, "repaid within cap");
        assertGt(hfAfter, hfBefore, "HF rose after rescue");
        assertGt(hfAfter, threshold, "HF restored above the policy threshold");

        emit log_named_decimal_uint("HF before", hfBefore, 18);
        emit log_named_decimal_uint("HF after ", hfAfter, 18);
        emit log_named_decimal_uint("USDC repaid", repaid, 6);
    }

    function test_Fork_ExecutorRescue_RevertWhenHealthy() public {
        if (!forked) return;

        _openEdgePosition();
        (,,,,, uint256 hf) = pool.getUserAccountData(subscriber);

        // Threshold BELOW current HF -> not breached -> rescue must revert.
        uint256 threshold = hf > 0.01e18 ? hf - 0.01e18 : 1e18;
        vm.prank(subscriber);
        uint256 policyId = registry.createPolicy(USDT, USDC, threshold, 100e6, 1e5);

        deal(USDC, address(executor), 200e6);
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(ComatoExecutor.HealthFactorNotBreached.selector, hf, threshold)
        );
        executor.rescue(policyId);
    }

    /*//////////////////////////////////////////////////////////////
                   EOA-DIRECT REPAY (TRACK 1 VOLUME PATH)
    //////////////////////////////////////////////////////////////*/

    /// @notice Demonstrates the attribution-counting path: an EOA (the simulated COMATO_WALLET)
    ///         repays the subscriber's debt directly. Here `repay` pulls USDC via
    ///         `transferFrom(agentEoa, ...)`, so the transfer's `from == tx sender EOA` — the shape
    ///         Track 1 (constraint C1) counts. This is the volume-earning path the off-chain agent
    ///         uses; the executor path above is the atomic safety net that does NOT count for C1.
    function test_Fork_EoaDirectRepay_RestoresHealthFactor() public {
        if (!forked) return;

        uint256 borrowedUsdc = _openEdgePosition();
        (,,,,, uint256 hfBefore) = pool.getUserAccountData(subscriber);

        address agentEoa = makeAddr("comatoWalletEoa");
        uint256 repayAmount = borrowedUsdc / 4;
        deal(USDC, agentEoa, repayAmount);

        vm.startPrank(agentEoa);
        IERC20(USDC).approve(POOL, repayAmount);
        uint256 repaid = pool.repay(USDC, repayAmount, VARIABLE_RATE_MODE, subscriber);
        vm.stopPrank();

        (,,,,, uint256 hfAfter) = pool.getUserAccountData(subscriber);
        assertGt(repaid, 0, "EOA-direct repay moved funds");
        assertGt(hfAfter, hfBefore, "EOA-direct repay restored HF");
    }
}
