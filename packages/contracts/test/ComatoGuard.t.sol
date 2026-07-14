// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ComatoGuard} from "../src/ComatoGuard.sol";
import {ComatoGuardFactory} from "../src/ComatoGuardFactory.sol";
import {ComatoPolicy} from "../src/ComatoPolicy.sol";
import {MockAavePool} from "./mocks/MockAavePool.sol";
import {MockBlacklistERC20} from "./mocks/MockBlacklistERC20.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockTarget} from "./mocks/MockTarget.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Test} from "forge-std/Test.sol";

/// @notice Unit tests for {ComatoGuard} driven through a real factory-deployed beacon proxy against a
///         deterministic mock Aave pool. Covers whitelist enforcement, bounded rescue + capped fee,
///         role gating, and pause. No fork / RPC required.
contract ComatoGuardTest is Test {
    ComatoGuardFactory internal factory;
    ComatoGuard internal guard;
    ComatoPolicy internal registry;
    MockAavePool internal pool;
    MockERC20 internal collateral;
    MockERC20 internal debt;
    MockTarget internal target;

    address internal admin = makeAddr("admin");
    address internal operator = makeAddr("operator");
    address internal guardian = makeAddr("guardian");
    address internal subscriber = makeAddr("subscriber");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal stranger = makeAddr("stranger");

    // Position: collateral 20_000, debt 15_000, LT 78% => HF = 1.04 (breached vs 1.05 threshold).
    uint256 internal constant COLLATERAL_UNITS = 20_000e6;
    uint256 internal constant DEBT_UNITS = 15_000e6;
    uint256 internal constant LT_BPS = 7800;
    uint256 internal constant THRESHOLD = 1.05e18;
    uint256 internal constant CAP = 3000e6;
    uint256 internal constant FLOAT = 5000e6;
    uint16 internal constant FEE_BPS = 500; // 5%

    uint256 internal policyId;

    // Cached in setUp: reading these via `guard.X()` inside an expectRevert AFTER a vm.prank would
    // consume the prank (the view call is the "next call"), so we snapshot them up front.
    bytes32 internal ADMIN_ROLE;
    bytes32 internal OPERATOR_ROLE;
    bytes32 internal GUARDIAN_ROLE;
    uint16 internal MAX_FEE;

    event RescueExecuted(
        uint256 indexed policyId,
        address indexed subscriber,
        address indexed asset,
        uint256 amountRepaid,
        uint256 hfBefore,
        uint256 hfAfter
    );
    event FeeCharged(address indexed feeRecipient, address indexed asset, uint256 amount);
    event FeeSkipped(address indexed feeRecipient, address indexed asset);
    event WhitelistUpdated(address indexed target, bool allowed);

    function setUp() public {
        pool = new MockAavePool();
        collateral = new MockERC20("Collateral", "COL", 6);
        debt = new MockERC20("Debt USDC", "USDC", 6);
        target = new MockTarget();

        registry = new ComatoPolicy(admin);

        address[] memory template = new address[](3);
        template[0] = address(pool);
        template[1] = address(debt);
        template[2] = address(target);

        factory = new ComatoGuardFactory(
            address(pool),
            address(registry),
            admin,
            operator,
            guardian,
            feeRecipient,
            FEE_BPS,
            template
        );

        vm.prank(subscriber);
        policyId = registry.createPolicy(address(collateral), address(debt), THRESHOLD, CAP, 0);

        vm.prank(admin);
        guard = ComatoGuard(payable(factory.createGuard(subscriber, policyId)));

        ADMIN_ROLE = guard.DEFAULT_ADMIN_ROLE();
        OPERATOR_ROLE = guard.OPERATOR_ROLE();
        GUARDIAN_ROLE = guard.GUARDIAN_ROLE();
        MAX_FEE = guard.MAX_FEE_BPS();

        // Fund the guard float and set a breached position.
        debt.mint(address(guard), FLOAT);
        pool.setAccount(subscriber, COLLATERAL_UNITS, DEBT_UNITS, LT_BPS);
    }

    function _hf() internal view returns (uint256 hf) {
        (,,,,, hf) = pool.getUserAccountData(subscriber);
    }

    /*//////////////////////////////////////////////////////////////
                             INITIALIZATION
    //////////////////////////////////////////////////////////////*/

    function test_Init_SetsConfigAndRoles() public view {
        assertEq(guard.subscriber(), subscriber);
        assertEq(guard.policyId(), policyId);
        assertEq(guard.feeRecipient(), feeRecipient);
        assertEq(guard.feeBps(), FEE_BPS);
        assertEq(guard.factory(), address(factory));
        assertTrue(guard.hasRole(guard.DEFAULT_ADMIN_ROLE(), admin));
        assertTrue(guard.hasRole(guard.OPERATOR_ROLE(), operator));
        assertTrue(guard.hasRole(guard.GUARDIAN_ROLE(), guardian));
        assertTrue(guard.isWhitelisted(address(pool)));
        assertTrue(guard.isWhitelisted(address(debt)));
        assertTrue(guard.isWhitelisted(address(target)));
        assertEq(guard.whitelistLength(), 3);
    }

    function test_Init_RevertOnSecondCall() public {
        address[] memory empty = new address[](0);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        guard.initialize(admin, operator, guardian, subscriber, policyId, feeRecipient, 0, empty);
    }

    function test_Init_ImplementationIsLocked() public {
        // The shared implementation behind the beacon can never be initialized directly.
        address impl = factory.guardImplementation();
        address[] memory empty = new address[](0);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        ComatoGuard(payable(impl))
            .initialize(admin, operator, guardian, subscriber, policyId, feeRecipient, 0, empty);
    }

    /*//////////////////////////////////////////////////////////////
                          WHITELIST ENFORCEMENT
    //////////////////////////////////////////////////////////////*/

    function test_Execute_WhitelistedTargetSucceeds() public {
        bytes memory data = abi.encodeCall(MockTarget.ping, (21));
        vm.prank(operator);
        bytes memory ret = guard.execute(address(target), 0, data);
        assertEq(abi.decode(ret, (uint256)), 42, "returns num*2");
        assertEq(target.callCount(), 1);
        assertEq(target.lastCaller(), address(guard), "guard is the caller");
    }

    function test_Execute_RevertForNonWhitelistedTarget() public {
        MockTarget rogue = new MockTarget();
        bytes memory data = abi.encodeCall(MockTarget.ping, (1));
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(ComatoGuard.NotWhitelisted.selector, address(rogue)));
        guard.execute(address(rogue), 0, data);
    }

    function test_Execute_RevertForNonOperator() public {
        bytes memory data = abi.encodeCall(MockTarget.ping, (1));
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, OPERATOR_ROLE
            )
        );
        guard.execute(address(target), 0, data);
    }

    function test_Execute_BubblesTargetRevert() public {
        target.setShouldRevert(true);
        bytes memory data = abi.encodeCall(MockTarget.ping, (1));
        vm.prank(operator);
        vm.expectRevert(MockTarget.ForcedRevert.selector);
        guard.execute(address(target), 0, data);
    }

    function test_ExecuteBatch_AllWhitelistedSucceeds() public {
        ComatoGuard.Call[] memory calls = new ComatoGuard.Call[](2);
        calls[0] = ComatoGuard.Call(address(target), 0, abi.encodeCall(MockTarget.ping, (5)));
        calls[1] = ComatoGuard.Call(address(target), 0, abi.encodeCall(MockTarget.ping, (7)));
        vm.prank(operator);
        bytes[] memory results = guard.executeBatch(calls);
        assertEq(abi.decode(results[0], (uint256)), 10);
        assertEq(abi.decode(results[1], (uint256)), 14);
        assertEq(target.callCount(), 2);
    }

    function test_ExecuteBatch_RevertIfAnyTargetNotWhitelisted() public {
        MockTarget rogue = new MockTarget();
        ComatoGuard.Call[] memory calls = new ComatoGuard.Call[](2);
        calls[0] = ComatoGuard.Call(address(target), 0, abi.encodeCall(MockTarget.ping, (5)));
        calls[1] = ComatoGuard.Call(address(rogue), 0, abi.encodeCall(MockTarget.ping, (7)));
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(ComatoGuard.NotWhitelisted.selector, address(rogue)));
        guard.executeBatch(calls);
        // Whole batch reverted -> first call rolled back too.
        assertEq(target.callCount(), 0, "atomic: nothing applied");
    }

    function test_ExecuteBatch_RevertOnEmpty() public {
        ComatoGuard.Call[] memory calls = new ComatoGuard.Call[](0);
        vm.prank(operator);
        vm.expectRevert(ComatoGuard.EmptyBatch.selector);
        guard.executeBatch(calls);
    }

    /*//////////////////////////////////////////////////////////////
                            RESCUE + FEE
    //////////////////////////////////////////////////////////////*/

    function test_Rescue_RepaysRaisesHfAndTakesCappedFee() public {
        uint256 hfBefore = _hf();
        assertLt(hfBefore, THRESHOLD, "precondition: breached");

        vm.prank(operator);
        (uint256 repaid, uint256 fee) = guard.rescue();

        // cap (3000) < float-after-fee (5000*10000/10500 = 4761) => repay bounded by cap.
        assertEq(repaid, CAP, "repaid == cap");
        assertEq(fee, (CAP * FEE_BPS) / 10_000, "fee == repaid * feeBps");
        assertLe(fee, (repaid * guard.MAX_FEE_BPS()) / 10_000, "fee <= hard cap");
        assertEq(debt.balanceOf(feeRecipient), fee, "fee delivered to recipient");
        assertEq(debt.balanceOf(address(guard)), FLOAT - repaid - fee, "float reduced by repay+fee");

        uint256 hfAfter = _hf();
        assertGt(hfAfter, hfBefore, "HF rose");
        assertGt(hfAfter, THRESHOLD, "HF restored above threshold");
    }

    function test_Rescue_EmitsRescueAndFeeEvents() public {
        uint256 fee = (CAP * FEE_BPS) / 10_000;
        vm.expectEmit(true, true, false, true);
        emit FeeCharged(feeRecipient, address(debt), fee);
        vm.prank(operator);
        guard.rescue();
    }

    function test_Rescue_ZeroFeeWhenFeeBpsZero() public {
        vm.prank(admin);
        guard.setFeeConfig(feeRecipient, 0);
        vm.prank(operator);
        (uint256 repaid, uint256 fee) = guard.rescue();
        assertEq(fee, 0, "no fee");
        assertEq(debt.balanceOf(address(guard)), FLOAT - repaid, "only repay left the float");
    }

    function test_Rescue_RepayPlusFeeNeverExceedsFloat() public {
        // Tiny float, max fee: the fee is reserved so repay+fee <= float always.
        vm.prank(admin);
        guard.withdrawFloat(address(debt), FLOAT - 1000e6, admin);
        vm.prank(admin);
        guard.setFeeConfig(feeRecipient, MAX_FEE); // 10%

        vm.prank(operator);
        (uint256 repaid, uint256 fee) = guard.rescue();
        assertLe(repaid + fee, 1000e6, "repay + fee within float");
        assertEq(debt.balanceOf(feeRecipient), fee);
    }

    function test_Rescue_RevertWhenNotBreached() public {
        pool.setAccount(subscriber, COLLATERAL_UNITS, 10_000e6, LT_BPS); // HF 1.56
        uint256 hf = _hf();
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(ComatoGuard.HealthFactorNotBreached.selector, hf, THRESHOLD)
        );
        guard.rescue();
    }

    function test_Rescue_RevertWhenNoFloat() public {
        vm.prank(admin);
        guard.withdrawFloat(address(debt), FLOAT, admin);
        vm.prank(operator);
        vm.expectRevert(ComatoGuard.NoFloatAvailable.selector);
        guard.rescue();
    }

    function test_Rescue_RevertWhenPolicyInactive() public {
        vm.prank(subscriber);
        registry.deactivatePolicy(policyId);
        vm.prank(operator);
        vm.expectRevert(ComatoGuard.PolicyNotActive.selector);
        guard.rescue();
    }

    function test_Rescue_RevertForNonOperator() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, OPERATOR_ROLE
            )
        );
        guard.rescue();
    }

    /*//////////////////////////////////////////////////////////////
                                 PAUSE
    //////////////////////////////////////////////////////////////*/

    function test_Pause_ByGuardianHaltsRescueAndExecute() public {
        vm.prank(guardian);
        guard.pause();
        assertTrue(guard.paused());

        vm.prank(operator);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        guard.rescue();

        bytes memory data = abi.encodeCall(MockTarget.ping, (1));
        vm.prank(operator);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        guard.execute(address(target), 0, data);
    }

    function test_Pause_RevertForNonGuardian() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, GUARDIAN_ROLE
            )
        );
        guard.pause();
    }

    function test_Unpause_AdminOnly_ThenResumes() public {
        vm.prank(guardian);
        guard.pause();

        // Guardian cannot unpause (admin decides to resume).
        vm.prank(guardian);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, guardian, ADMIN_ROLE
            )
        );
        guard.unpause();

        vm.prank(admin);
        guard.unpause();
        assertFalse(guard.paused());

        vm.prank(operator);
        (uint256 repaid,) = guard.rescue();
        assertEq(repaid, CAP, "rescue works after unpause");
    }

    /*//////////////////////////////////////////////////////////////
                          ROLE / CONFIG GATING
    //////////////////////////////////////////////////////////////*/

    function test_SetWhitelist_AdminOnly() public {
        address newTarget = makeAddr("newTarget");
        vm.expectEmit(true, false, false, true);
        emit WhitelistUpdated(newTarget, true);
        vm.prank(admin);
        guard.setWhitelist(newTarget, true);
        assertTrue(guard.isWhitelisted(newTarget));

        vm.prank(admin);
        guard.setWhitelist(newTarget, false);
        assertFalse(guard.isWhitelisted(newTarget));
    }

    function test_SetWhitelist_RevertForNonAdmin() public {
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, operator, ADMIN_ROLE
            )
        );
        guard.setWhitelist(makeAddr("x"), true);
    }

    function test_SetFeeConfig_AdminOnly_AndHardCapEnforced() public {
        vm.prank(admin);
        guard.setFeeConfig(feeRecipient, 750);
        assertEq(guard.feeBps(), 750);

        // Over the hard cap reverts.
        uint16 tooHigh = guard.MAX_FEE_BPS() + 1;
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(ComatoGuard.FeeTooHigh.selector, tooHigh));
        guard.setFeeConfig(feeRecipient, tooHigh);

        // Non-admin cannot set fee.
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, operator, ADMIN_ROLE
            )
        );
        guard.setFeeConfig(feeRecipient, 100);
    }

    function test_WithdrawFloat_AdminOnly() public {
        vm.prank(admin);
        guard.withdrawFloat(address(debt), 1000e6, admin);
        assertEq(debt.balanceOf(admin), 1000e6);

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, ADMIN_ROLE
            )
        );
        guard.withdrawFloat(address(debt), 1000e6, stranger);
    }

    function test_RotateOperator_ByAdmin() public {
        address newOperator = makeAddr("newOperator");
        vm.startPrank(admin);
        guard.revokeRole(guard.OPERATOR_ROLE(), operator);
        guard.grantRole(guard.OPERATOR_ROLE(), newOperator);
        vm.stopPrank();

        // Old operator can no longer rescue.
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, operator, OPERATOR_ROLE
            )
        );
        guard.rescue();

        // New operator can.
        vm.prank(newOperator);
        (uint256 repaid,) = guard.rescue();
        assertEq(repaid, CAP);
    }

    function test_DepositFloat_Permissionless() public {
        debt.mint(stranger, 2000e6);
        vm.startPrank(stranger);
        debt.approve(address(guard), 2000e6);
        guard.depositFloat(address(debt), 2000e6);
        vm.stopPrank();
        assertEq(guard.floatOf(address(debt)), FLOAT + 2000e6);
    }

    /*//////////////////////////////////////////////////////////////
                    HARDENING: FEE DECOUPLING + CONTAINMENT
    //////////////////////////////////////////////////////////////*/

    /// @dev A blacklisted/frozen fee recipient must NOT be able to revert the safety-critical repay:
    ///      the fee is skipped, the reserved amount stays as float, and HF is still restored.
    function test_Rescue_FeeSkippedWhenRecipientBlacklisted_RepayStillLands() public {
        MockBlacklistERC20 blDebt = new MockBlacklistERC20("BL USDC", "USDC", 6);
        address sub2 = makeAddr("sub2");
        vm.prank(sub2);
        uint256 pid = registry.createPolicy(address(collateral), address(blDebt), THRESHOLD, CAP, 0);
        vm.prank(admin);
        ComatoGuard g2 = ComatoGuard(payable(factory.createGuard(sub2, pid)));

        blDebt.mint(address(g2), FLOAT);
        pool.setAccount(sub2, COLLATERAL_UNITS, DEBT_UNITS, LT_BPS);
        blDebt.setBlacklisted(feeRecipient, true); // issuer freezes the treasury

        (,,,,, uint256 hfBefore) = pool.getUserAccountData(sub2);

        vm.expectEmit(true, true, false, false);
        emit FeeSkipped(feeRecipient, address(blDebt));
        vm.prank(operator);
        (uint256 repaid, uint256 fee) = g2.rescue();

        assertEq(repaid, CAP, "repay still landed");
        assertEq(fee, 0, "fee skipped, not reverted");
        assertEq(blDebt.balanceOf(feeRecipient), 0, "no fee delivered");
        assertEq(blDebt.balanceOf(address(g2)), FLOAT - repaid, "reserved fee stays as float");
        (,,,,, uint256 hfAfter) = pool.getUserAccountData(sub2);
        assertGt(hfAfter, hfBefore, "HF restored despite fee failure");
    }

    function test_PushFee_RevertForExternalCaller() public {
        vm.prank(operator);
        vm.expectRevert(ComatoGuard.OnlySelf.selector);
        guard.pushFee(address(debt), feeRecipient, 1);
    }

    /// @dev Admin can neutralize a standing allowance an operator planted via `execute`, without
    ///      having to self-grant OPERATOR_ROLE (the containment gap the audit flagged).
    function test_RevokeAllowance_AdminResetsOperatorPlantedApproval() public {
        address attacker = makeAddr("attacker");
        // Operator plants a max approval on the whitelisted debt token via execute.
        vm.prank(operator);
        guard.execute(
            address(debt), 0, abi.encodeCall(IERC20.approve, (attacker, type(uint256).max))
        );
        assertEq(debt.allowance(address(guard), attacker), type(uint256).max);

        vm.prank(admin);
        guard.revokeAllowance(address(debt), attacker);
        assertEq(debt.allowance(address(guard), attacker), 0, "allowance neutralized");
    }

    function test_RevokeAllowance_RevertForNonAdmin() public {
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, operator, ADMIN_ROLE
            )
        );
        guard.revokeAllowance(address(debt), makeAddr("x"));
    }

    function test_Execute_RevertForCodelessWhitelistedTarget() public {
        address codeless = makeAddr("codelessTarget");
        vm.prank(admin);
        guard.setWhitelist(codeless, true);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(ComatoGuard.TargetHasNoCode.selector, codeless));
        guard.execute(codeless, 0, abi.encodeCall(MockTarget.ping, (1)));
    }
}
