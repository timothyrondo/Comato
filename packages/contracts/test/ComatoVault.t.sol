// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ComatoVault} from "../src/ComatoVault.sol";
import {ComatoVaultFactory} from "../src/ComatoVaultFactory.sol";
import {MockAavePool} from "./mocks/MockAavePool.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockSwapRouter} from "./mocks/MockSwapRouter.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";

/// @notice Unit tests for {ComatoVault} driven through a real factory-deployed beacon proxy against a
///         deterministic mock Aave pool + mock swap router. Covers access control (only the subscriber
///         moves funds, only the operator may deleverage), init validation, and — the heart of the
///         vault — the three deleverage bounds: must be breached, must improve HF, must not overshoot.
///         No fork / RPC required.
contract ComatoVaultTest is Test {
    ComatoVaultFactory internal factory;
    ComatoVault internal vault;
    MockAavePool internal pool;
    MockSwapRouter internal router;
    MockERC20 internal collateral; // CELO-like, 18 dec
    MockERC20 internal debt; // USDC-like, 6 dec

    address internal admin = makeAddr("admin");
    address internal operator = makeAddr("operator");
    address internal subscriber = makeAddr("subscriber");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal stranger = makeAddr("stranger");

    // Deleverage-bounds scenario. The mock computes HF = collateral * ltBps / 1e4 / debt (WAD), so:
    //   HF_before = 20_000 * 0.78 / 15_000 = 1.04e18  (breached vs the 1.30 threshold).
    uint256 internal constant ACCT_COLLATERAL = 20_000e6;
    uint256 internal constant ACCT_DEBT = 15_000e6;
    uint256 internal constant LT_BPS = 7800; // 78%
    uint256 internal constant HF_BREACHED = 1.04e18;

    uint24 internal constant POOL_FEE = 100;
    uint256 internal constant FEE_BPS = 500; // 5%
    uint256 internal constant HF_THRESHOLD = 1.3e18;
    uint256 internal constant TARGET_HF = 1.6e18;

    // Cached in setUp: reading `vault.MAX_FEE_BPS()` inline AFTER a vm.prank/expectRevert would consume
    // the prank (the view is the "next call"), so we snapshot it up front (mirrors ComatoGuard.t.sol).
    uint256 internal MAX_FEE;

    function setUp() public {
        pool = new MockAavePool();
        router = new MockSwapRouter();
        collateral = new MockERC20("Celo", "CELO", 18);
        debt = new MockERC20("USD Coin", "USDC", 6);

        factory = new ComatoVaultFactory(address(pool), address(router), admin);

        vault = _createVault(
            subscriber,
            address(collateral),
            address(debt),
            POOL_FEE,
            operator,
            feeRecipient,
            FEE_BPS,
            HF_THRESHOLD,
            TARGET_HF
        );

        MAX_FEE = vault.MAX_FEE_BPS();
    }

    function _createVault(
        address caller,
        address collateralAsset,
        address debtAsset,
        uint24 poolFee,
        address operator_,
        address feeRecipient_,
        uint256 feeBps,
        uint256 hfThreshold,
        uint256 targetHf
    ) internal returns (ComatoVault) {
        vm.prank(caller);
        return ComatoVault(
            factory.createVault(
                collateralAsset,
                debtAsset,
                poolFee,
                operator_,
                feeRecipient_,
                feeBps,
                hfThreshold,
                targetHf
            )
        );
    }

    /// @dev Put the vault into the breached position and pre-fund the pool (collateral to withdraw)
    ///      and router (debt to pay out on the swap).
    function _armBreached() internal {
        pool.setAccount(address(vault), ACCT_COLLATERAL, ACCT_DEBT, LT_BPS);
        collateral.mint(address(pool), 1000e18);
        debt.mint(address(router), 100_000e6);
    }

    function _hf() internal view returns (uint256 hf) {
        (,,,,, hf) = pool.getUserAccountData(address(vault));
    }

    /*//////////////////////////////////////////////////////////////
                             INITIALIZATION
    //////////////////////////////////////////////////////////////*/

    function test_Init_SetsConfig() public view {
        assertEq(vault.subscriber(), subscriber);
        assertEq(vault.collateralAsset(), address(collateral));
        assertEq(vault.debtAsset(), address(debt));
        assertEq(vault.poolFee(), POOL_FEE);
        assertEq(vault.operator(), operator);
        assertEq(vault.feeRecipient(), feeRecipient);
        assertEq(vault.feeBps(), FEE_BPS);
        assertEq(vault.hfThreshold(), HF_THRESHOLD);
        assertEq(vault.targetHf(), TARGET_HF);
        assertEq(address(vault.POOL()), address(pool));
        assertEq(address(vault.SWAP_ROUTER()), address(router));
        assertEq(factory.vaultOf(subscriber), address(vault));
        assertTrue(factory.isVault(address(vault)));
        assertEq(factory.vaultCount(), 1);
    }

    function test_Init_SubscriberIsForcedToCaller() public {
        // Even if someone tries to create a vault, `subscriber` is msg.sender — never a passed arg.
        address alice = makeAddr("alice");
        ComatoVault v = _createVault(
            alice,
            address(collateral),
            address(debt),
            POOL_FEE,
            operator,
            feeRecipient,
            0,
            HF_THRESHOLD,
            TARGET_HF
        );
        assertEq(v.subscriber(), alice);
    }

    function test_Init_RevertOnSecondInitialize() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        vault.initialize(
            subscriber,
            address(collateral),
            address(debt),
            POOL_FEE,
            operator,
            feeRecipient,
            FEE_BPS,
            HF_THRESHOLD,
            TARGET_HF
        );
    }

    function test_Init_ImplementationIsLocked() public {
        ComatoVault impl = factory.implementation();
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(
            subscriber,
            address(collateral),
            address(debt),
            POOL_FEE,
            operator,
            feeRecipient,
            FEE_BPS,
            HF_THRESHOLD,
            TARGET_HF
        );
    }

    function test_Init_RevertOnDuplicateVault() public {
        vm.prank(subscriber);
        vm.expectRevert(ComatoVaultFactory.VaultExists.selector);
        factory.createVault(
            address(collateral),
            address(debt),
            POOL_FEE,
            operator,
            feeRecipient,
            0,
            HF_THRESHOLD,
            TARGET_HF
        );
    }

    /*//////////////////////////////////////////////////////////////
                          INIT VALIDATION (bounds)
    //////////////////////////////////////////////////////////////*/

    address internal badSub = makeAddr("badSub");

    function test_Init_RevertOnZeroCollateral() public {
        vm.prank(badSub);
        vm.expectRevert(ComatoVault.ZeroAddress.selector);
        factory.createVault(
            address(0), address(debt), POOL_FEE, operator, feeRecipient, 0, HF_THRESHOLD, TARGET_HF
        );
    }

    function test_Init_RevertOnZeroDebt() public {
        vm.prank(badSub);
        vm.expectRevert(ComatoVault.ZeroAddress.selector);
        factory.createVault(
            address(collateral),
            address(0),
            POOL_FEE,
            operator,
            feeRecipient,
            0,
            HF_THRESHOLD,
            TARGET_HF
        );
    }

    function test_Init_RevertOnIdenticalAssets() public {
        vm.prank(badSub);
        vm.expectRevert(ComatoVault.IdenticalAssets.selector);
        factory.createVault(
            address(collateral),
            address(collateral),
            POOL_FEE,
            operator,
            feeRecipient,
            0,
            HF_THRESHOLD,
            TARGET_HF
        );
    }

    function test_Init_RevertOnFeeTooHigh() public {
        uint256 tooHigh = vault.MAX_FEE_BPS() + 1;
        vm.prank(badSub);
        vm.expectRevert(ComatoVault.FeeTooHigh.selector);
        factory.createVault(
            address(collateral),
            address(debt),
            POOL_FEE,
            operator,
            feeRecipient,
            tooHigh,
            HF_THRESHOLD,
            TARGET_HF
        );
    }

    function test_Init_RevertOnZeroThreshold() public {
        vm.prank(badSub);
        vm.expectRevert(ComatoVault.BadThresholds.selector);
        factory.createVault(
            address(collateral), address(debt), POOL_FEE, operator, feeRecipient, 0, 0, TARGET_HF
        );
    }

    function test_Init_RevertOnTargetNotAboveThreshold() public {
        // targetHf <= hfThreshold is invalid (deleverage lifts HF from < threshold up toward target).
        vm.prank(badSub);
        vm.expectRevert(ComatoVault.BadThresholds.selector);
        factory.createVault(
            address(collateral),
            address(debt),
            POOL_FEE,
            operator,
            feeRecipient,
            0,
            HF_THRESHOLD,
            HF_THRESHOLD
        );
    }

    /*//////////////////////////////////////////////////////////////
                    ACCESS CONTROL — SUBSCRIBER-ONLY
    //////////////////////////////////////////////////////////////*/

    function test_Supply_RevertForNonSubscriber() public {
        vm.prank(stranger);
        vm.expectRevert(ComatoVault.NotSubscriber.selector);
        vault.supply(1);
    }

    function test_Borrow_RevertForNonSubscriber() public {
        vm.prank(stranger);
        vm.expectRevert(ComatoVault.NotSubscriber.selector);
        vault.borrow(1);
    }

    function test_Repay_RevertForNonSubscriber() public {
        vm.prank(stranger);
        vm.expectRevert(ComatoVault.NotSubscriber.selector);
        vault.repay(1);
    }

    function test_WithdrawCollateral_RevertForNonSubscriber() public {
        vm.prank(stranger);
        vm.expectRevert(ComatoVault.NotSubscriber.selector);
        vault.withdrawCollateral(1, stranger);
    }

    function test_SetOperator_RevertForNonSubscriber() public {
        vm.prank(stranger);
        vm.expectRevert(ComatoVault.NotSubscriber.selector);
        vault.setOperator(stranger);
    }

    function test_SetTerms_RevertForNonSubscriber() public {
        vm.prank(stranger);
        vm.expectRevert(ComatoVault.NotSubscriber.selector);
        vault.setTerms(0, HF_THRESHOLD, TARGET_HF);
    }

    /// @dev Even the operator (who can deleverage) has no power over the subscriber's funds.
    function test_WithdrawCollateral_RevertForOperator() public {
        vm.prank(operator);
        vm.expectRevert(ComatoVault.NotSubscriber.selector);
        vault.withdrawCollateral(1, operator);
    }

    /*//////////////////////////////////////////////////////////////
                     SUBSCRIBER HAPPY PATHS (positive)
    //////////////////////////////////////////////////////////////*/

    function test_Supply_SubscriberMovesFunds() public {
        uint256 amount = 100e18;
        collateral.mint(subscriber, amount);
        vm.startPrank(subscriber);
        collateral.approve(address(vault), amount);
        vault.supply(amount);
        vm.stopPrank();
        // Mock pool pulled the collateral from the subscriber via the vault.
        assertEq(collateral.balanceOf(subscriber), 0, "subscriber funded the supply");
        assertEq(collateral.balanceOf(address(pool)), amount, "pool received collateral");
    }

    function test_SetOperator_SubscriberCanRotateAndRevoke() public {
        address newOp = makeAddr("newOp");
        vm.prank(subscriber);
        vault.setOperator(newOp);
        assertEq(vault.operator(), newOp);

        // Revoke entirely (fire Comato).
        vm.prank(subscriber);
        vault.setOperator(address(0));
        assertEq(vault.operator(), address(0));
    }

    function test_SetTerms_SubscriberUpdatesAndHardCapEnforced() public {
        vm.prank(subscriber);
        vault.setTerms(250, 1.1e18, 1.5e18);
        assertEq(vault.feeBps(), 250);
        assertEq(vault.hfThreshold(), 1.1e18);
        assertEq(vault.targetHf(), 1.5e18);

        // Fee over hard cap reverts.
        vm.prank(subscriber);
        vm.expectRevert(ComatoVault.FeeTooHigh.selector);
        vault.setTerms(MAX_FEE + 1, 1.1e18, 1.5e18);

        // Bad thresholds revert.
        vm.prank(subscriber);
        vm.expectRevert(ComatoVault.BadThresholds.selector);
        vault.setTerms(250, 1.5e18, 1.5e18);
    }

    /*//////////////////////////////////////////////////////////////
                 ACCESS CONTROL + BOUNDS — DELEVERAGE
    //////////////////////////////////////////////////////////////*/

    function test_Deleverage_RevertForNonOperator() public {
        _armBreached();
        // The subscriber themselves cannot deleverage — only the operator can.
        vm.prank(subscriber);
        vm.expectRevert(ComatoVault.NotOperator.selector);
        vault.deleverage(1e18, 0);

        vm.prank(stranger);
        vm.expectRevert(ComatoVault.NotOperator.selector);
        vault.deleverage(1e18, 0);
    }

    function test_Deleverage_RevertOnZeroAmount() public {
        _armBreached();
        vm.prank(operator);
        vm.expectRevert(ComatoVault.ZeroAmount.selector);
        vault.deleverage(0, 0);
    }

    function test_Deleverage_RevertWhenNotBreached() public {
        // Healthy position: HF = 20_000 * 0.78 / 10_000 = 1.56e18 >= 1.30 threshold.
        pool.setAccount(address(vault), ACCT_COLLATERAL, 10_000e6, LT_BPS);
        collateral.mint(address(pool), 1000e18);
        debt.mint(address(router), 100_000e6);
        uint256 hf = _hf();
        assertEq(hf, 1.56e18, "healthy precondition");

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(ComatoVault.NotBreached.selector, hf, HF_THRESHOLD));
        vault.deleverage(100e18, 0);
    }

    function test_Deleverage_RevertOnHfNotImproved() public {
        _armBreached();
        assertEq(_hf(), HF_BREACHED, "breached precondition");
        // Swap yields nothing -> nothing repaid -> HF unchanged -> HfNotImproved.
        router.setAmountOut(0);

        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(ComatoVault.HfNotImproved.selector, HF_BREACHED, HF_BREACHED)
        );
        vault.deleverage(100e18, 0);
    }

    function test_Deleverage_RevertOnOvershoot() public {
        _armBreached();
        // Huge swap output repays so much debt that HF blows past targetHf (1.60) -> Overshoot.
        //   out = 9_000e6, fee 5% = 450e6, repay 8_550e6 -> debt 6_450e6 -> HF ~2.42e18 > 1.60.
        router.setAmountOut(9000e6);

        // Overshoot carries (hfAfter, target) args; match on the selector only.
        vm.prank(operator);
        vm.expectPartialRevert(ComatoVault.Overshoot.selector);
        vault.deleverage(100e18, 0);
    }

    function test_Deleverage_HappyPath_LiftsHfWithinBoundsAndPaysFee() public {
        _armBreached();
        uint256 hfBefore = _hf();
        assertEq(hfBefore, HF_BREACHED);
        (, uint256 debtBefore,) = vault.position();

        // out = 2_000e6, fee 5% = 100e6, repay 1_900e6 -> debt 13_100e6 -> HF ~1.19e18 (in bounds).
        uint256 out = 2000e6;
        router.setAmountOut(out);
        uint256 expectedFee = (out * FEE_BPS) / 10_000;

        vm.prank(operator);
        uint256 repaid = vault.deleverage(100e18, 1900e6);

        uint256 hfAfter = _hf();
        (, uint256 debtAfter,) = vault.position();

        assertEq(repaid, out - expectedFee, "repaid == swap out minus fee");
        assertGt(hfAfter, hfBefore, "HF improved");
        assertLe(hfAfter, TARGET_HF, "HF did not overshoot the target");
        assertLt(debtAfter, debtBefore, "debt decreased");
        assertEq(debt.balanceOf(feeRecipient), expectedFee, "fee reached the recipient");
        assertEq(debt.balanceOf(address(vault)), 0, "no debt token left stranded in the vault");
        assertEq(debt.allowance(address(vault), address(pool)), 0, "no residual pool allowance");

        emit log_named_decimal_uint("HF before", hfBefore, 18);
        emit log_named_decimal_uint("HF after ", hfAfter, 18);
    }

    function test_Deleverage_ZeroFeeWhenFeeBpsZero() public {
        // Fresh subscriber with feeBps = 0.
        address sub0 = makeAddr("sub0");
        ComatoVault v = _createVault(
            sub0,
            address(collateral),
            address(debt),
            POOL_FEE,
            operator,
            feeRecipient,
            0,
            HF_THRESHOLD,
            TARGET_HF
        );
        pool.setAccount(address(v), ACCT_COLLATERAL, ACCT_DEBT, LT_BPS);
        collateral.mint(address(pool), 1000e18);
        debt.mint(address(router), 100_000e6);
        router.setAmountOut(2000e6);

        vm.prank(operator);
        uint256 repaid = v.deleverage(100e18, 0);
        assertEq(repaid, 2000e6, "full swap output repaid, no fee");
        assertEq(debt.balanceOf(feeRecipient), 0, "no fee taken");
    }
}
