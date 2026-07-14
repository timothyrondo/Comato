// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ComatoGuard} from "../src/ComatoGuard.sol";
import {ComatoGuardFactory} from "../src/ComatoGuardFactory.sol";
import {ComatoPolicy} from "../src/ComatoPolicy.sol";
import {IAaveV3Pool} from "../src/interfaces/IAaveV3Pool.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";

/// @notice Fork integration test against the live Aave V3 pool on Celo mainnet (chain 42220): the
///         factory deploys a real beacon-proxy guard, funds it, and rescues a genuinely-at-risk
///         position — restoring the health factor above the policy threshold while taking a bounded,
///         capped protocol fee. Also exercises the whitelist-gated `executeBatch` deleverage path.
/// @dev Requires network access to https://forno.celo.org. If the RPC is unreachable this whole file
///      self-skips in setUp (the `forked` guard) and the test bodies early-return.
contract ComatoGuardForkTest is Test {
    address internal constant POOL = 0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402;
    address internal constant USDC = 0xcebA9300f2b948710d2653dD7B07f33A8B32118C; // 6 dec, debt asset
    address internal constant USDT = 0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e; // 6 dec, collateral

    uint256 internal constant VARIABLE_RATE_MODE = 2;
    uint16 internal constant REFERRAL = 0;
    uint16 internal constant FEE_BPS = 500; // 5%

    IAaveV3Pool internal pool;
    ComatoPolicy internal registry;
    ComatoGuardFactory internal factory;

    address internal admin = makeAddr("admin");
    address internal operator = makeAddr("operator");
    address internal guardian = makeAddr("guardian");
    address internal subscriber = makeAddr("subscriber");
    address internal feeRecipient = makeAddr("feeRecipient");

    bool internal forked;

    function setUp() public {
        try vm.createSelectFork(vm.rpcUrl("celo")) {
            forked = true;
        } catch {
            forked = false;
            return;
        }
        assertEq(block.chainid, 42_220, "not on Celo mainnet fork");

        pool = IAaveV3Pool(POOL);
        registry = new ComatoPolicy(admin);

        address[] memory template = new address[](4);
        template[0] = POOL;
        template[1] = USDC;
        template[2] = USDT;
        template[3] = address(pool); // duplicate is de-duped by the set

        factory = new ComatoGuardFactory(
            POOL, address(registry), admin, operator, guardian, feeRecipient, FEE_BPS, template
        );
    }

    /// @dev Supplies USDT collateral and borrows USDC to ~99% of LTV, leaving HF just above 1.
    function _openEdgePosition() internal returns (uint256 borrowedUsdc) {
        uint256 collateralAmount = 2000e6; // 2,000 USDT
        deal(USDT, subscriber, collateralAmount);

        vm.startPrank(subscriber);
        IERC20(USDT).approve(POOL, collateralAmount);
        pool.supply(USDT, collateralAmount, subscriber, REFERRAL);

        (,, uint256 availableBorrowsBase,,,) = pool.getUserAccountData(subscriber);
        borrowedUsdc = (availableBorrowsBase * 99) / 100 / 100;
        pool.borrow(USDC, borrowedUsdc, VARIABLE_RATE_MODE, REFERRAL, subscriber);
        vm.stopPrank();
    }

    function _newGuard(uint256 threshold, uint256 rescueCap) internal returns (ComatoGuard guard) {
        vm.prank(subscriber);
        uint256 policyId = registry.createPolicy(USDT, USDC, threshold, rescueCap, 1e5);
        vm.prank(admin);
        guard = ComatoGuard(payable(factory.createGuard(subscriber, policyId)));
    }

    /*//////////////////////////////////////////////////////////////
                     FACTORY GUARD RESCUE (SAFETY + FEE)
    //////////////////////////////////////////////////////////////*/

    function test_Fork_FactoryGuard_RescueRestoresHfAndTakesCappedFee() public {
        if (!forked) return;

        uint256 borrowedUsdc = _openEdgePosition();
        (,,,,, uint256 hfBefore) = pool.getUserAccountData(subscriber);
        assertGt(hfBefore, 1e18, "still solvent before rescue");
        assertLt(hfBefore, 2e18, "near the edge");

        uint256 threshold = hfBefore + 0.02e18;
        uint256 rescueCap = borrowedUsdc / 4;
        ComatoGuard guard = _newGuard(threshold, rescueCap);

        // Fund the guard's USDC float generously (enough for repay + fee).
        deal(USDC, address(guard), rescueCap + 100e6);
        uint256 floatBefore = IERC20(USDC).balanceOf(address(guard));

        vm.prank(operator);
        (uint256 repaid, uint256 fee) = guard.rescue();

        (,,,,, uint256 hfAfter) = pool.getUserAccountData(subscriber);

        assertGt(repaid, 0, "something repaid");
        assertLe(repaid, rescueCap, "repaid within cap");
        assertEq(fee, (repaid * FEE_BPS) / 10_000, "fee == repaid * feeBps");
        assertLe(fee, (repaid * guard.MAX_FEE_BPS()) / 10_000, "fee within hard cap");
        assertEq(IERC20(USDC).balanceOf(feeRecipient), fee, "fee delivered");
        assertEq(
            IERC20(USDC).balanceOf(address(guard)), floatBefore - repaid - fee, "float debited once"
        );
        assertGt(hfAfter, hfBefore, "HF rose");
        assertGt(hfAfter, threshold, "HF restored above threshold");
        assertEq(IERC20(USDC).allowance(address(guard), POOL), 0, "no residual allowance");

        emit log_named_decimal_uint("HF before", hfBefore, 18);
        emit log_named_decimal_uint("HF after ", hfAfter, 18);
        emit log_named_decimal_uint("USDC repaid", repaid, 6);
        emit log_named_decimal_uint("USDC fee", fee, 6);
    }

    /// @notice Whitelist-gated deleverage path: the operator drives an atomic approve+repay batch
    ///         through the guard against the whitelisted USDC + Pool targets.
    function test_Fork_FactoryGuard_ExecuteBatchRepayThroughWhitelist() public {
        if (!forked) return;

        uint256 borrowedUsdc = _openEdgePosition();
        (, uint256 debtBefore,,,,) = pool.getUserAccountData(subscriber);
        assertGt(debtBefore, 0, "has debt");

        ComatoGuard guard = _newGuard(10e18, borrowedUsdc);
        uint256 repayAmount = borrowedUsdc / 5;
        deal(USDC, address(guard), repayAmount);

        // Atomic deleverage batch: approve USDC to the Pool, then repay — both whitelisted targets.
        ComatoGuard.Call[] memory calls = new ComatoGuard.Call[](2);
        calls[0] = ComatoGuard.Call(USDC, 0, abi.encodeCall(IERC20.approve, (POOL, repayAmount)));
        calls[1] = ComatoGuard.Call(
            POOL,
            0,
            abi.encodeCall(IAaveV3Pool.repay, (USDC, repayAmount, VARIABLE_RATE_MODE, subscriber))
        );

        vm.prank(operator);
        guard.executeBatch(calls);

        (, uint256 debtAfter,,,,) = pool.getUserAccountData(subscriber);
        assertLt(debtAfter, debtBefore, "debt reduced via whitelisted executeBatch");
    }

    function test_Fork_FactoryGuard_ExecuteRevertsForNonWhitelisted() public {
        if (!forked) return;

        ComatoGuard guard = _newGuard(10e18, 100e6);
        address rogue = makeAddr("rogueTarget");
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(ComatoGuard.NotWhitelisted.selector, rogue));
        guard.execute(rogue, 0, abi.encodeCall(IERC20.approve, (POOL, 1)));
    }
}
