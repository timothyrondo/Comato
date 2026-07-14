// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ComatoExecutor} from "../src/ComatoExecutor.sol";
import {ComatoPolicy} from "../src/ComatoPolicy.sol";
import {MockAavePool} from "./mocks/MockAavePool.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";

/// @notice Unit tests for the executor's rescue logic, bounds, and access control against a
///         deterministic mock pool. No fork / RPC required.
contract ComatoExecutorTest is Test {
    ComatoPolicy internal registry;
    ComatoExecutor internal executor;
    MockAavePool internal pool;
    MockERC20 internal collateral;
    MockERC20 internal debt;

    address internal owner = makeAddr("owner");
    address internal operator = makeAddr("operator");
    address internal subscriber = makeAddr("subscriber");
    address internal stranger = makeAddr("stranger");

    // Position: collateral 20_000, debt 15_000, LT 78% => HF = 20000 * 0.78 / 15000 = 1.04.
    uint256 internal constant COLLATERAL_UNITS = 20_000e6;
    uint256 internal constant DEBT_UNITS = 15_000e6;
    uint256 internal constant LT_BPS = 7800;
    uint256 internal constant THRESHOLD = 1.05e18; // breached (HF 1.04 < 1.05)
    uint256 internal constant CAP = 3000e6;
    uint256 internal constant FLOAT = 5000e6;

    uint256 internal policyId;

    event RescueExecuted(
        uint256 indexed policyId,
        address indexed subscriber,
        address indexed asset,
        uint256 amountRepaid,
        uint256 hfBefore,
        uint256 hfAfter
    );
    event FloatDeposited(address indexed asset, address indexed from, uint256 amount);
    event FloatWithdrawn(address indexed asset, address indexed to, uint256 amount);

    function setUp() public {
        pool = new MockAavePool();
        collateral = new MockERC20("Collateral", "COL", 6);
        debt = new MockERC20("Debt USDC", "USDC", 6);

        registry = new ComatoPolicy(owner);
        executor = new ComatoExecutor(address(pool), address(registry), owner);

        // Subscriber registers a policy on the debt asset.
        vm.prank(subscriber);
        policyId = registry.createPolicy(address(collateral), address(debt), THRESHOLD, CAP, 0);

        // Position is below threshold in the mock pool.
        pool.setAccount(subscriber, COLLATERAL_UNITS, DEBT_UNITS, LT_BPS);

        // Fund the executor float and give the mock pool no starting debt tokens (it holds repaid
        // funds only). Mint float to the executor directly.
        debt.mint(address(executor), FLOAT);
    }

    function _hf(address user) internal view returns (uint256 hf) {
        (,,,,, hf) = pool.getUserAccountData(user);
    }

    /*//////////////////////////////////////////////////////////////
                              RESCUE HAPPY
    //////////////////////////////////////////////////////////////*/

    function test_Rescue_RepaysCapAndRaisesHealthFactor() public {
        uint256 hfBefore = _hf(subscriber);
        assertLt(hfBefore, THRESHOLD, "precondition: breached");

        // Expect repay bounded by cap (cap < float, cap < debt).
        uint256 floatStart = debt.balanceOf(address(executor));

        vm.prank(owner);
        uint256 repaid = executor.rescue(policyId);

        assertEq(repaid, CAP, "repaid == cap");
        assertEq(debt.balanceOf(address(executor)), floatStart - CAP, "float reduced by repaid");

        uint256 hfAfter = _hf(subscriber);
        assertGt(hfAfter, hfBefore, "HF rose");
        // HF after = 20000*0.78/(15000-3000) = 1.30 > threshold.
        assertGt(hfAfter, THRESHOLD, "HF restored above threshold");
    }

    function test_Rescue_EmitsEvent() public {
        uint256 hfBefore = _hf(subscriber);
        uint256 hfAfter = (COLLATERAL_UNITS * LT_BPS * 1e18) / (1e4 * (DEBT_UNITS - CAP));
        vm.expectEmit(true, true, true, true);
        emit RescueExecuted(policyId, subscriber, address(debt), CAP, hfBefore, hfAfter);
        vm.prank(owner);
        executor.rescue(policyId);
    }

    function test_Rescue_ByAuthorizedOperator() public {
        vm.prank(owner);
        executor.setOperator(operator, true);
        vm.prank(operator);
        uint256 repaid = executor.rescue(policyId);
        assertEq(repaid, CAP);
    }

    /*//////////////////////////////////////////////////////////////
                              RESCUE BOUNDS
    //////////////////////////////////////////////////////////////*/

    function test_Rescue_BoundedByFloatWhenFloatBelowCap() public {
        // Drain most float so float < cap and float < debt.
        vm.prank(owner);
        executor.withdrawFloat(address(debt), FLOAT - 1000e6, owner);
        assertEq(debt.balanceOf(address(executor)), 1000e6);

        vm.prank(owner);
        uint256 repaid = executor.rescue(policyId);
        assertEq(repaid, 1000e6, "repaid == remaining float");
        assertEq(debt.balanceOf(address(executor)), 0, "float fully used");
    }

    function test_Rescue_BoundedByDebtWhenDebtBelowCapAndFloat() public {
        // Small debt: 1_000 < cap(3_000) and < float(5_000). HF still below threshold beforehand.
        pool.setAccount(subscriber, 1030e6, 1000e6, LT_BPS); // HF = 1030*0.78/1000 = 0.8034 < 1.05
        vm.prank(owner);
        uint256 repaid = executor.rescue(policyId);
        assertEq(repaid, 1000e6, "repaid == outstanding debt");
        // Allowance reset to zero because Aave pulled less than approved.
        assertEq(debt.allowance(address(executor), address(pool)), 0, "residual approval cleared");
    }

    /*//////////////////////////////////////////////////////////////
                              RESCUE REVERTS
    //////////////////////////////////////////////////////////////*/

    function test_Rescue_RevertWhenNotBreached() public {
        // Raise HF above threshold: collateral 20000, debt 10000, LT 78% => HF = 1.56.
        pool.setAccount(subscriber, COLLATERAL_UNITS, 10_000e6, LT_BPS);
        uint256 hf = _hf(subscriber);
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(ComatoExecutor.HealthFactorNotBreached.selector, hf, THRESHOLD)
        );
        executor.rescue(policyId);
    }

    function test_Rescue_RevertWhenNoFloat() public {
        vm.prank(owner);
        executor.withdrawFloat(address(debt), FLOAT, owner);
        vm.prank(owner);
        vm.expectRevert(ComatoExecutor.NoFloatAvailable.selector);
        executor.rescue(policyId);
    }

    function test_Rescue_RevertWhenPolicyInactive() public {
        vm.prank(subscriber);
        registry.deactivatePolicy(policyId);
        vm.prank(owner);
        vm.expectRevert(ComatoExecutor.PolicyNotActive.selector);
        executor.rescue(policyId);
    }

    function test_Rescue_RevertForUnknownPolicy() public {
        vm.prank(owner);
        vm.expectRevert(ComatoPolicy.PolicyNotFound.selector);
        executor.rescue(999);
    }

    function test_Rescue_RevertForNonOperator() public {
        vm.prank(stranger);
        vm.expectRevert(ComatoExecutor.NotOperator.selector);
        executor.rescue(policyId);
    }

    /*//////////////////////////////////////////////////////////////
                           FLOAT MANAGEMENT
    //////////////////////////////////////////////////////////////*/

    function test_DepositFloat_PullsAndEmits() public {
        debt.mint(stranger, 2000e6);
        vm.startPrank(stranger);
        debt.approve(address(executor), 2000e6);
        vm.expectEmit(true, true, false, true);
        emit FloatDeposited(address(debt), stranger, 2000e6);
        executor.depositFloat(address(debt), 2000e6);
        vm.stopPrank();
        assertEq(executor.floatOf(address(debt)), FLOAT + 2000e6);
    }

    function test_DepositFloat_RevertOnZeroAmount() public {
        vm.prank(owner);
        vm.expectRevert(ComatoExecutor.ZeroAmount.selector);
        executor.depositFloat(address(debt), 0);
    }

    function test_WithdrawFloat_OwnerOnly() public {
        vm.prank(owner);
        vm.expectEmit(true, true, false, true);
        emit FloatWithdrawn(address(debt), owner, 1000e6);
        executor.withdrawFloat(address(debt), 1000e6, owner);
        assertEq(debt.balanceOf(owner), 1000e6);
    }

    function test_WithdrawFloat_RevertForNonOwner() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        executor.withdrawFloat(address(debt), 1000e6, stranger);
    }

    function test_WithdrawFloat_RevertOnZeroTo() public {
        vm.prank(owner);
        vm.expectRevert(ComatoExecutor.ZeroAddress.selector);
        executor.withdrawFloat(address(debt), 1000e6, address(0));
    }

    /*//////////////////////////////////////////////////////////////
                             CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    function test_Constructor_RevertOnZeroPool() public {
        vm.expectRevert(ComatoExecutor.ZeroAddress.selector);
        new ComatoExecutor(address(0), address(registry), owner);
    }

    function test_Constructor_RevertOnZeroRegistry() public {
        vm.expectRevert(ComatoExecutor.ZeroAddress.selector);
        new ComatoExecutor(address(pool), address(0), owner);
    }

    function test_Constructor_SetsImmutables() public view {
        assertEq(address(executor.POOL()), address(pool));
        assertEq(address(executor.POLICY_REGISTRY()), address(registry));
        assertEq(executor.owner(), owner);
    }

    /*//////////////////////////////////////////////////////////////
                                 FUZZ
    //////////////////////////////////////////////////////////////*/

    /// @dev For any breached position with positive float, a rescue never repays more than the
    ///      policy cap, never more than the float, and always leaves HF >= the prior HF.
    function testFuzz_Rescue_RespectsBoundsAndRaisesHf(
        uint256 debtUnits,
        uint256 floatAmt,
        uint256 cap
    ) public {
        debtUnits = bound(debtUnits, 1e6, 1_000_000e6);
        floatAmt = bound(floatAmt, 1, 1_000_000e6);
        cap = bound(cap, 1, 1_000_000e6);

        // Collateral chosen so HF is below threshold (breached): HF = coll*LT/debt < THRESHOLD.
        // Pick collateral = debt so HF = 0.78 < 1.05 for LT 78%.
        pool.setAccount(subscriber, debtUnits, debtUnits, LT_BPS);

        // Reset the policy cap via a fresh policy carrying the fuzzed cap.
        vm.prank(subscriber);
        uint256 pid = registry.createPolicy(address(collateral), address(debt), THRESHOLD, cap, 0);

        // Reset executor float to exactly floatAmt.
        uint256 cur = debt.balanceOf(address(executor));
        if (cur > 0) {
            vm.prank(owner);
            executor.withdrawFloat(address(debt), cur, owner);
        }
        debt.mint(address(executor), floatAmt);

        uint256 hfBefore = _hf(subscriber);
        vm.prank(owner);
        uint256 repaid = executor.rescue(pid);

        assertLe(repaid, cap, "<= cap");
        assertLe(repaid, floatAmt, "<= float");
        assertLe(repaid, debtUnits, "<= debt");
        assertGe(_hf(subscriber), hfBefore, "HF non-decreasing");
    }
}
