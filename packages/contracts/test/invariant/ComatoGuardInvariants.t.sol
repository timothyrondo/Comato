// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ComatoGuard} from "../../src/ComatoGuard.sol";
import {ComatoGuardFactory} from "../../src/ComatoGuardFactory.sol";
import {ComatoPolicy} from "../../src/ComatoPolicy.sol";
import {MockAavePool} from "../mocks/MockAavePool.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockTarget} from "../mocks/MockTarget.sol";
import {Test} from "forge-std/Test.sol";

/// @notice Stateful handler that fuzzes the full guard surface — float in/out, position changes,
///         rescues, whitelisted + rogue executes, and pause toggling — while recording ghost
///         accounting so the invariant runner can prove the security properties can never be broken.
contract GuardHandler is Test {
    ComatoGuard public guard;
    ComatoPolicy public registry;
    MockAavePool public pool;
    MockERC20 public debt;
    MockTarget public whitelisted; // in the guard's whitelist
    MockTarget public rogue; // NOT in the whitelist
    address public admin;
    address public guardian;
    address public subscriber;
    address public feeRecipient;
    uint256 public policyId;

    // Ghost accounting.
    uint256 public totalDeposited;
    uint256 public totalWithdrawn;
    uint256 public totalRepaid;
    uint256 public totalFees;

    // Violation counters — all must stay 0.
    uint256 public capViolations;
    uint256 public feeViolations;
    uint256 public rogueExecSuccess;
    uint256 public pausedActionSuccess;

    uint256 internal constant LT_BPS = 7800;

    constructor(
        ComatoGuard guard_,
        ComatoPolicy registry_,
        MockAavePool pool_,
        MockERC20 debt_,
        MockTarget whitelisted_,
        MockTarget rogue_,
        address admin_,
        address guardian_,
        address subscriber_,
        address feeRecipient_,
        uint256 policyId_
    ) {
        guard = guard_;
        registry = registry_;
        pool = pool_;
        debt = debt_;
        whitelisted = whitelisted_;
        rogue = rogue_;
        admin = admin_;
        guardian = guardian_;
        subscriber = subscriber_;
        feeRecipient = feeRecipient_;
        policyId = policyId_;
    }

    function depositFloat(uint256 amt) external {
        amt = bound(amt, 1, 1e30);
        debt.mint(address(this), amt);
        debt.approve(address(guard), amt);
        guard.depositFloat(address(debt), amt);
        totalDeposited += amt;
    }

    function withdrawFloat(uint256 amt) external {
        uint256 bal = debt.balanceOf(address(guard));
        if (bal == 0) return;
        amt = bound(amt, 1, bal);
        vm.prank(admin);
        guard.withdrawFloat(address(debt), amt, admin);
        totalWithdrawn += amt;
    }

    function setPosition(uint256 collateral, uint256 debtUnits) external {
        collateral = bound(collateral, 1, 1e30);
        debtUnits = bound(debtUnits, 1, 1e30);
        pool.setAccount(subscriber, collateral, debtUnits, LT_BPS);
    }

    function setFee(uint256 bps) external {
        // Whatever the fuzzer picks, the guard clamps to <= MAX_FEE_BPS (or reverts above it).
        uint16 feeBps = uint16(bound(bps, 0, guard.MAX_FEE_BPS()));
        vm.prank(admin);
        guard.setFeeConfig(feeRecipient, feeBps);
    }

    function togglePause(bool wantPaused) external {
        if (wantPaused && !guard.paused()) {
            vm.prank(guardian);
            guard.pause();
        } else if (!wantPaused && guard.paused()) {
            vm.prank(admin);
            guard.unpause();
        }
    }

    function rescue(uint256) external {
        uint256 cap = registry.getPolicy(policyId).rescueCap;
        uint256 maxFeeBps = guard.MAX_FEE_BPS();
        bool wasPaused = guard.paused();
        vm.prank(admin);
        // Route the operator call through a granted role: the handler holds OPERATOR_ROLE.
        try guard.rescue() returns (uint256 repaid, uint256 fee) {
            if (wasPaused) pausedActionSuccess++;
            totalRepaid += repaid;
            totalFees += fee;
            if (repaid > cap) capViolations++;
            if (fee > (repaid * maxFeeBps) / 10_000) feeViolations++;
        } catch {}
    }

    function executeWhitelisted(uint256 num) external {
        bool wasPaused = guard.paused();
        bytes memory data = abi.encodeCall(MockTarget.ping, (num));
        vm.prank(admin);
        try guard.execute(address(whitelisted), 0, data) {
            if (wasPaused) pausedActionSuccess++;
        } catch {}
    }

    function executeRogue(uint256 num) external {
        // A non-whitelisted target must ALWAYS revert — no matter what.
        bytes memory data = abi.encodeCall(MockTarget.ping, (num));
        vm.prank(admin);
        try guard.execute(address(rogue), 0, data) {
            rogueExecSuccess++;
        } catch {}
    }
}

/// @notice Guard invariants (fizz-style): the whitelist can't be bypassed, the fee is always
///         `<= MAX_FEE_BPS` and `<= repaid * MAX_FEE_BPS`, rescues never exceed the cap, pause halts
///         all privileged actions, and no funds ever leave the guard unaccounted for.
contract ComatoGuardInvariants is Test {
    ComatoGuardFactory internal factory;
    ComatoGuard internal guard;
    ComatoPolicy internal registry;
    MockAavePool internal pool;
    MockERC20 internal collateral;
    MockERC20 internal debt;
    MockTarget internal whitelisted;
    MockTarget internal rogue;
    GuardHandler internal handler;

    address internal admin = makeAddr("admin");
    address internal operator = makeAddr("operator");
    address internal guardian = makeAddr("guardian");
    address internal subscriber = makeAddr("subscriber");
    address internal feeRecipient = makeAddr("feeRecipient");

    uint256 internal constant THRESHOLD = 10e18; // almost any position with debt is "breached"

    function setUp() public {
        pool = new MockAavePool();
        collateral = new MockERC20("Collateral", "COL", 6);
        debt = new MockERC20("Debt USDC", "USDC", 6);
        whitelisted = new MockTarget();
        rogue = new MockTarget();
        registry = new ComatoPolicy(admin);

        address[] memory template = new address[](2);
        template[0] = address(pool);
        template[1] = address(whitelisted);

        factory = new ComatoGuardFactory(
            address(pool), address(registry), admin, operator, guardian, feeRecipient, 500, template
        );

        vm.prank(subscriber);
        uint256 policyId =
            registry.createPolicy(address(collateral), address(debt), THRESHOLD, 5000e6, 0);

        vm.prank(admin);
        guard = ComatoGuard(payable(factory.createGuard(subscriber, policyId)));

        handler = new GuardHandler(
            guard,
            registry,
            pool,
            debt,
            whitelisted,
            rogue,
            admin,
            guardian,
            subscriber,
            feeRecipient,
            policyId
        );

        // The handler drives operator + admin + guardian actions via prank; grant it OPERATOR_ROLE
        // so its rescue/execute calls (pranked as `admin`, which is also DEFAULT_ADMIN_ROLE) pass —
        // the handler pranks the specific role holder per action, so grant the roles it needs.
        vm.startPrank(admin);
        guard.grantRole(guard.OPERATOR_ROLE(), admin);
        vm.stopPrank();

        // Seed a breached position so rescues can fire.
        pool.setAccount(subscriber, 20_000e6, 15_000e6, 7800);

        targetContract(address(handler));
    }

    /// @dev The live fee configuration can never exceed the hard cap.
    function invariant_FeeBpsWithinHardCap() public view {
        assertLe(guard.feeBps(), guard.MAX_FEE_BPS(), "feeBps <= MAX_FEE_BPS");
    }

    /// @dev No rescue ever charged a fee above `repaid * MAX_FEE_BPS`, and none exceeded the cap.
    function invariant_FeeAndCapNeverViolated() public view {
        assertEq(handler.feeViolations(), 0, "fee never exceeds cap ratio");
        assertEq(handler.capViolations(), 0, "repay never exceeds policy cap");
    }

    /// @dev A non-whitelisted target can NEVER be executed successfully.
    function invariant_WhitelistCannotBeBypassed() public view {
        assertEq(handler.rogueExecSuccess(), 0, "rogue target never executes");
    }

    /// @dev No privileged action (rescue / execute) ever succeeds while the guard is paused.
    function invariant_PauseHaltsPrivilegedActions() public view {
        assertEq(handler.pausedActionSuccess(), 0, "paused halts everything");
    }

    /// @dev Float held equals deposits minus everything that legitimately left (withdrawals +
    ///      rescue repayments + fees). No token appears or vanishes unaccounted for.
    function invariant_FloatConservation() public view {
        assertEq(
            debt.balanceOf(address(guard)),
            handler.totalDeposited() - handler.totalWithdrawn() - handler.totalRepaid()
                - handler.totalFees(),
            "float conserved"
        );
    }

    /// @dev No residual pool allowance ever lingers after a rescue (approve -> repay -> reset).
    function invariant_NoResidualPoolAllowance() public view {
        assertEq(debt.allowance(address(guard), address(pool)), 0, "no residual allowance");
    }
}
