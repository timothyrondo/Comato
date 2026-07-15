// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ComatoExecutor} from "../../src/ComatoExecutor.sol";
import {ComatoPolicy} from "../../src/ComatoPolicy.sol";
import {MockAavePool} from "../mocks/MockAavePool.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {Test} from "forge-std/Test.sol";

/// @notice Stateful handler exercising float deposits/withdrawals and rescues against a mock pool,
///         tracking ghost accounting so the invariant runner can check conservation and bounds.
contract ExecutorHandler is Test {
    ComatoExecutor public executor;
    ComatoPolicy public registry;
    MockAavePool public pool;
    MockERC20 public debt;
    address public owner;
    address public subscriber;
    uint256 public policyId;

    uint256 public totalDeposited;
    uint256 public totalWithdrawn;
    uint256 public totalRepaid;
    uint256 public capViolations;

    uint256 internal constant LT_BPS = 7800;

    constructor(
        ComatoExecutor executor_,
        ComatoPolicy registry_,
        MockAavePool pool_,
        MockERC20 debt_,
        address owner_,
        address subscriber_,
        uint256 policyId_
    ) {
        executor = executor_;
        registry = registry_;
        pool = pool_;
        debt = debt_;
        owner = owner_;
        subscriber = subscriber_;
        policyId = policyId_;
    }

    function depositFloat(uint256 amt) external {
        amt = bound(amt, 1, 1e30);
        debt.mint(address(this), amt);
        debt.approve(address(executor), amt);
        executor.depositFloat(address(debt), amt);
        totalDeposited += amt;
    }

    function withdrawFloat(uint256 amt) external {
        uint256 bal = debt.balanceOf(address(executor));
        if (bal == 0) return;
        amt = bound(amt, 1, bal);
        vm.prank(owner);
        executor.withdrawFloat(address(debt), amt, owner);
        totalWithdrawn += amt;
    }

    function setPosition(uint256 collateral, uint256 debtUnits) external {
        collateral = bound(collateral, 1, 1e30);
        debtUnits = bound(debtUnits, 1, 1e30);
        pool.setAccount(subscriber, collateral, debtUnits, LT_BPS);
    }

    function rescue(uint256) external {
        uint256 cap = registry.getPolicy(policyId).rescueCap;
        try executor.rescue(policyId) returns (uint256 repaid) {
            totalRepaid += repaid;
            if (repaid > cap) capViolations++;
        } catch {}
    }
}

/// @notice Invariants for the executor: float conservation, the rescue cap is never exceeded, and
///         no residual pool allowance ever lingers.
contract ComatoExecutorInvariants is Test {
    ComatoExecutor internal executor;
    ComatoPolicy internal registry;
    MockAavePool internal pool;
    MockERC20 internal debt;
    ExecutorHandler internal handler;

    address internal owner = makeAddr("owner");
    address internal subscriber = makeAddr("subscriber");

    uint256 internal constant THRESHOLD = 10e18; // max: almost any position with debt is "breached"

    function setUp() public {
        pool = new MockAavePool();
        debt = new MockERC20("Debt USDC", "USDC", 6);
        registry = new ComatoPolicy(owner);
        executor = new ComatoExecutor(address(pool), address(registry), owner);

        MockERC20 collateral = new MockERC20("Collateral", "COL", 6);
        vm.prank(subscriber);
        uint256 policyId =
            registry.createPolicy(address(collateral), address(debt), THRESHOLD, 5000e6, 0);

        handler = new ExecutorHandler(executor, registry, pool, debt, owner, subscriber, policyId);

        // Authorize the handler as an operator so it can trigger rescues.
        bytes32 role = executor.OPERATOR_ROLE();
        vm.prank(owner);
        executor.grantRole(role, address(handler));

        // Seed a live breached position.
        pool.setAccount(subscriber, 20_000e6, 15_000e6, 7800);

        targetContract(address(handler));
    }

    /// @dev Float held equals everything deposited minus everything that legitimately left
    ///      (withdrawals + rescue repayments). No token appears or vanishes unaccounted for.
    function invariant_FloatConservation() public view {
        assertEq(
            debt.balanceOf(address(executor)),
            handler.totalDeposited() - handler.totalWithdrawn() - handler.totalRepaid(),
            "float conserved"
        );
    }

    /// @dev A rescue never repays more than the policy cap.
    function invariant_RepayNeverExceedsCap() public view {
        assertEq(handler.capViolations(), 0, "cap never exceeded");
    }

    /// @dev No residual pool allowance ever lingers after a rescue (approve -> repay -> reset).
    function invariant_NoResidualPoolAllowance() public view {
        assertEq(debt.allowance(address(executor), address(pool)), 0, "no residual allowance");
    }
}
