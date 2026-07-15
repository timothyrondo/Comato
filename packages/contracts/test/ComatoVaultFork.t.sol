// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ComatoVault} from "../src/ComatoVault.sol";
import {ComatoVaultFactory} from "../src/ComatoVaultFactory.sol";
import {IAaveV3Pool} from "../src/interfaces/IAaveV3Pool.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";

/// @dev Minimal slice of the Aave `AaveProtocolDataProvider` used to read live reserve caps.
interface IAaveDataProvider {
    function getReserveCaps(address asset)
        external
        view
        returns (uint256 borrowCap, uint256 supplyCap);
    function getReserveData(address asset)
        external
        view
        returns (
            uint256 unbacked,
            uint256 accruedToTreasuryScaled,
            uint256 totalAToken,
            uint256 totalStableDebt,
            uint256 totalVariableDebt,
            uint256 liquidityRate,
            uint256 variableBorrowRate,
            uint256 stableBorrowRate,
            uint256 averageStableBorrowRate,
            uint256 liquidityIndex,
            uint256 variableBorrowIndex,
            uint40 lastUpdateTimestamp
        );
}

/// @notice Fork integration test for {ComatoVault} against the live Aave V3 pool + Uniswap V3 router on
///         Celo mainnet (chain 42220). A subscriber deploys their own non-custodial vault, supplies
///         collateral, borrows to just above the LTV cap (breaching the 1.30 threshold), and the Comato
///         operator runs a bounded `deleverage`: withdraw collateral -> swap to the debt asset on the
///         fee-100 Uniswap pool -> repay debt, lifting HF back toward target while taking a capped fee.
///         Also asserts the non-custodial guarantees: only the subscriber can withdraw collateral, only
///         the operator can deleverage.
///
/// @dev COLLATERAL CHOICE (see report). Model C targets CELO collateral, but on a Foundry fork CELO is
///      unusable two ways over: (1) live Aave Celo caps the CELO reserve supply at 1 token vs ~1.287M
///      already supplied (`SupplyCapExceeded`), and (2) the CELO GoldToken moves value through the Celo
///      native-transfer precompile (0x…fd), which the fork does not implement — transfers report success
///      but credit nothing, so Aave's pull from the vault reverts. Both are environment facts, not vault
///      bugs. We therefore exercise the identical vault code path with USDT collateral / USDC debt (both
///      standard ERC20 proxies with supply headroom, the pair the existing fork suites use) and swap
///      USDT->USDC on the fee-100 pool. `test_Fork_CeloReserveIsSupplyCapped` documents the CELO blocker
///      on-chain; the CELO-shaped (18-dec collateral) logic is covered by ComatoVault.t.sol.
///
/// @dev Requires network access to https://forno.celo.org. If the RPC is unreachable this whole file
///      self-skips in setUp (the `forked` guard) and the test bodies early-return.
///
/// @dev DELEVERAGE SIZING (important — see report). {ComatoVault.deleverage} withdraws collateral BEFORE
///      it repays, so Aave's withdraw HF-check bounds a single call: the mid-transaction state (collateral
///      removed, debt not yet repaid) must keep HF >= 1. For a position breached near the threshold that
///      caps `collateralIn` well below the position size. We size it dynamically from live account data so
///      the withdraw stays solvent and the post-repay HF lands under `targetHf`.
contract ComatoVaultForkTest is Test {
    // --- Verified Celo mainnet addresses (packages/shared/src/addresses.ts) ---
    address internal constant POOL = 0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402;
    address internal constant SWAP_ROUTER = 0x5615CDAb10dc425a742d643d949a7F474C01abc4;
    address internal constant DATA_PROVIDER = 0x2e0f8D3B1631296cC7c56538D6Eb6032601E15ED;
    address internal constant CELO = 0x471EcE3750Da237f93B8E339c536989b8978a438; // 18 dec
    address internal constant USDC = 0xcebA9300f2b948710d2653dD7B07f33A8B32118C; // 6 dec, debt
    address internal constant USDT = 0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e; // 6 dec, collateral

    uint24 internal constant POOL_FEE = 100; // Uniswap fee tier 100 (USDT/USDC stable pool)
    uint256 internal constant FEE_BPS = 500; // 5%
    uint256 internal constant HF_THRESHOLD = 1.3e18;
    uint256 internal constant TARGET_HF = 1.6e18;

    uint256 internal constant SUPPLY_AMOUNT = 2000e6; // 2,000 USDT collateral (6 dec)
    // Mid-deleverage HF floor: keep the post-withdraw / pre-repay state comfortably solvent.
    uint256 internal constant MID_HF_FLOOR = 1.02e18;

    IAaveV3Pool internal pool;
    ComatoVaultFactory internal factory;

    address internal admin = makeAddr("admin");
    address internal operator = makeAddr("operator");
    address internal subscriber = makeAddr("subscriber");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal stranger = makeAddr("stranger");

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
        factory = new ComatoVaultFactory(POOL, SWAP_ROUTER, admin);
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    function _deployVault() internal returns (ComatoVault v) {
        vm.prank(subscriber);
        v = ComatoVault(
            factory.createVault(
                USDT, USDC, POOL_FEE, operator, feeRecipient, FEE_BPS, HF_THRESHOLD, TARGET_HF
            )
        );
    }

    function _supply(ComatoVault v, uint256 amount) internal {
        deal(USDT, subscriber, amount);
        vm.startPrank(subscriber);
        IERC20(USDT).approve(address(v), amount);
        v.supply(amount);
        vm.stopPrank();
    }

    function _hf(ComatoVault v) internal view returns (uint256 hf) {
        (,,,,, hf) = pool.getUserAccountData(address(v));
    }

    function _borrow(ComatoVault v, uint256 amount6) internal {
        vm.prank(subscriber);
        v.borrow(amount6);
    }

    /// @dev Borrow ~90% of the remaining LTV headroom to push HF to a mild breach (below the 1.30
    ///      threshold but with room to withdraw during deleverage). Price-independent: at the LTV cap
    ///      HF -> LT/LTV, so 90% of headroom lands comfortably under threshold.
    function _breach(ComatoVault v) internal {
        (,, uint256 availableBorrowsBase,,,) = pool.getUserAccountData(address(v));
        uint256 more = (availableBorrowsBase * 90) / 100 / 100; // 8dec base -> 6dec USDC
        _borrow(v, more);
    }

    /// @dev Size a single deleverage from live data: withdraw at most enough collateral value to keep
    ///      the mid-transaction HF (before the repay) >= MID_HF_FLOOR, taking 70% of that room for safety.
    /// @return collateralIn USDT (6dec) to withdraw+swap. @return minDebtOut conservative USDC floor.
    function _sizeDeleverage(ComatoVault v)
        internal
        view
        returns (uint256 collateralIn, uint256 minDebtOut)
    {
        (uint256 collBase, uint256 debtBase,, uint256 lt,,) = pool.getUserAccountData(address(v));
        // minColl: collateral value that must remain so (remaining * lt) / debt >= MID_HF_FLOOR.
        uint256 minColl = (((MID_HF_FLOOR * debtBase) / 1e18) * 1e4) / lt; // 8dec USD
        uint256 vValMax = collBase > minColl ? collBase - minColl : 0; // 8dec USD withdrawable pre-repay
        uint256 vVal = (vValMax * 70) / 100; // 70% of the room
        // Value(8dec USD) -> collateral token (6dec) via the position's per-unit value.
        collateralIn = (SUPPLY_AMOUNT * vVal) / collBase;
        // Expected USDC out ≈ vVal (8dec) -> 6dec; take 70% as a conservative slippage floor.
        minDebtOut = ((vVal / 100) * 70) / 100;
    }

    /*//////////////////////////////////////////////////////////////
              FINDING: live CELO reserve is supply-capped
    //////////////////////////////////////////////////////////////*/

    /// @notice Documents on-chain why Model C cannot open a CELO-collateral position on live Aave Celo:
    ///         the CELO supply cap (1 whole token) is far below the CELO already supplied (~1.287M).
    function test_Fork_CeloReserveIsSupplyCapped() public {
        if (!forked) return;

        (, uint256 supplyCap) = IAaveDataProvider(DATA_PROVIDER).getReserveCaps(CELO);
        (,, uint256 totalACelo,,,,,,,,,) = IAaveDataProvider(DATA_PROVIDER).getReserveData(CELO);

        // supplyCap is in whole tokens; totalAToken is in wei (18 dec).
        assertEq(supplyCap, 1, "CELO supply cap is 1 whole token");
        assertGt(totalACelo, supplyCap * 1e18, "already-supplied CELO exceeds the cap");
        emit log_named_uint("CELO supply cap (whole tokens)", supplyCap);
        emit log_named_decimal_uint("CELO already supplied", totalACelo, 18);
    }

    /*//////////////////////////////////////////////////////////////
                     DELEVERAGE (rescue) — the core path
    //////////////////////////////////////////////////////////////*/

    function test_Fork_Vault_DeleverageRestoresHfAndTakesCappedFee() public {
        if (!forked) return;

        ComatoVault v = _deployVault();
        _supply(v, SUPPLY_AMOUNT);

        // 1) A tiny $6 borrow: position is deeply healthy.
        _borrow(v, 6e6);
        uint256 hfSafe = _hf(v);
        assertGt(hfSafe, HF_THRESHOLD, "position safe after a $6 borrow");

        // 2) Borrow more to breach below the 1.30 threshold.
        _breach(v);
        uint256 hfBefore = _hf(v);
        assertLt(hfBefore, HF_THRESHOLD, "position breached below threshold");
        assertGt(hfBefore, 1e18, "still solvent (not yet liquidatable)");

        (uint256 collateralIn, uint256 minDebtOut) = _sizeDeleverage(v);
        assertGt(collateralIn, 0, "sized a non-zero deleverage");

        (, uint256 debtBefore,) = v.position();
        uint256 feeBalBefore = IERC20(USDC).balanceOf(feeRecipient);

        // 3) Only the operator can deleverage; it lifts HF without overshooting the target.
        vm.prank(operator);
        uint256 repaid = v.deleverage(collateralIn, minDebtOut);

        uint256 hfAfter = _hf(v);
        (, uint256 debtAfter,) = v.position();
        uint256 feeDelivered = IERC20(USDC).balanceOf(feeRecipient) - feeBalBefore;

        assertGt(repaid, 0, "debt was repaid");
        assertGt(hfAfter, hfBefore, "HF improved");
        assertLe(hfAfter, TARGET_HF, "HF did not overshoot the target (bounded)");
        assertLt(debtAfter, debtBefore, "debt decreased");
        assertGt(feeDelivered, 0, "capped fee reached feeRecipient");
        // repaid = swapOut - fee and fee = swapOut * feeBps / 1e4, so fee/repaid = feeBps/(1e4 - feeBps).
        assertLe(
            feeDelivered, (repaid * FEE_BPS) / (10_000 - FEE_BPS) + 1, "fee within the capped ratio"
        );

        emit log_named_decimal_uint("collateralIn (USDT)", collateralIn, 6);
        emit log_named_decimal_uint("HF before", hfBefore, 18);
        emit log_named_decimal_uint("HF after ", hfAfter, 18);
        emit log_named_decimal_uint("USDC repaid", repaid, 6);
        emit log_named_decimal_uint("USDC fee", feeDelivered, 6);
    }

    function test_Fork_Vault_DeleverageRevertsForNonOperator() public {
        if (!forked) return;

        ComatoVault v = _deployVault();
        _supply(v, SUPPLY_AMOUNT);
        _borrow(v, 6e6);
        _breach(v);

        (uint256 collateralIn, uint256 minDebtOut) = _sizeDeleverage(v);

        // The subscriber themselves cannot deleverage — only the operator can.
        vm.prank(subscriber);
        vm.expectRevert(ComatoVault.NotOperator.selector);
        v.deleverage(collateralIn, minDebtOut);

        vm.prank(stranger);
        vm.expectRevert(ComatoVault.NotOperator.selector);
        v.deleverage(collateralIn, minDebtOut);
    }

    function test_Fork_Vault_DeleverageRevertsWhenHealthy() public {
        if (!forked) return;

        ComatoVault v = _deployVault();
        _supply(v, SUPPLY_AMOUNT);
        _borrow(v, 6e6); // deeply healthy, HF >> threshold

        uint256 hf = _hf(v);
        assertGt(hf, HF_THRESHOLD, "healthy precondition");

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(ComatoVault.NotBreached.selector, hf, HF_THRESHOLD));
        v.deleverage(100e6, 0);
    }

    /*//////////////////////////////////////////////////////////////
                 NON-CUSTODIAL: subscriber-only withdraw
    //////////////////////////////////////////////////////////////*/

    function test_Fork_Vault_SubscriberWithdrawIsNonCustodial() public {
        if (!forked) return;

        ComatoVault v = _deployVault();
        _supply(v, SUPPLY_AMOUNT);
        _borrow(v, 6e6); // healthy: plenty of collateral is withdrawable

        uint256 balBefore = IERC20(USDT).balanceOf(subscriber);
        uint256 withdrawAmount = 500e6;

        // The subscriber can always pull collateral their position can safely give back.
        vm.prank(subscriber);
        v.withdrawCollateral(withdrawAmount, subscriber);
        assertEq(
            IERC20(USDT).balanceOf(subscriber) - balBefore,
            withdrawAmount,
            "subscriber got their USDT back"
        );

        // The operator (Comato) has NO power to move the subscriber's collateral out.
        vm.prank(operator);
        vm.expectRevert(ComatoVault.NotSubscriber.selector);
        v.withdrawCollateral(1e6, operator);
    }
}
