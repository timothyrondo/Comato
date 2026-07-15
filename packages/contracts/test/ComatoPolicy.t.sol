// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ComatoPolicy} from "../src/ComatoPolicy.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Test} from "forge-std/Test.sol";

/// @notice Unit tests for the policy registry: CRUD, validation, and access control.
///         No fork / RPC required.
contract ComatoPolicyTest is Test {
    ComatoPolicy internal registry;

    address internal owner = makeAddr("owner");
    address internal operator = makeAddr("operator");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    address internal constant COLLATERAL = address(0xC011A);
    address internal constant DEBT = address(0xDeb7);
    uint256 internal constant THRESHOLD = 1.05e18;
    uint256 internal constant CAP = 500e6;
    uint256 internal constant PREMIUM = 1e5;

    event PolicyCreated(
        uint256 indexed policyId,
        address indexed subscriber,
        address indexed collateralAsset,
        address debtAsset,
        uint256 hfThreshold,
        uint256 rescueCap,
        uint256 premiumRatePerInterval
    );
    event PolicyDeactivated(uint256 indexed policyId, address indexed caller);
    event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender);

    function setUp() public {
        registry = new ComatoPolicy(owner);
    }

    function _createAsAlice() internal returns (uint256 policyId) {
        vm.prank(alice);
        policyId = registry.createPolicy(COLLATERAL, DEBT, THRESHOLD, CAP, PREMIUM);
    }

    /*//////////////////////////////////////////////////////////////
                                CREATE
    //////////////////////////////////////////////////////////////*/

    function test_CreatePolicy_StoresFieldsAndEmits() public {
        vm.expectEmit(true, true, true, true);
        emit PolicyCreated(1, alice, COLLATERAL, DEBT, THRESHOLD, CAP, PREMIUM);

        uint256 id = _createAsAlice();
        assertEq(id, 1, "first id is 1");
        assertEq(registry.nextPolicyId(), 2, "nextPolicyId incremented");

        ComatoPolicy.Policy memory p = registry.getPolicy(id);
        assertEq(p.subscriber, alice);
        assertEq(p.collateralAsset, COLLATERAL);
        assertEq(p.debtAsset, DEBT);
        assertEq(p.hfThreshold, THRESHOLD);
        assertEq(p.rescueCap, CAP);
        assertEq(p.premiumRatePerInterval, PREMIUM);
        assertTrue(p.active);
        assertTrue(registry.isActive(id));
        assertEq(registry.subscriberOf(id), alice);
    }

    function test_CreatePolicy_IncrementsIds() public {
        uint256 id1 = _createAsAlice();
        vm.prank(bob);
        uint256 id2 = registry.createPolicy(COLLATERAL, DEBT, THRESHOLD, CAP, PREMIUM);
        assertEq(id1, 1);
        assertEq(id2, 2);
        assertEq(registry.subscriberOf(id2), bob);
    }

    function test_CreatePolicy_RevertOnZeroCollateral() public {
        vm.prank(alice);
        vm.expectRevert(ComatoPolicy.ZeroAddress.selector);
        registry.createPolicy(address(0), DEBT, THRESHOLD, CAP, PREMIUM);
    }

    function test_CreatePolicy_RevertOnZeroDebt() public {
        vm.prank(alice);
        vm.expectRevert(ComatoPolicy.ZeroAddress.selector);
        registry.createPolicy(COLLATERAL, address(0), THRESHOLD, CAP, PREMIUM);
    }

    function test_CreatePolicy_RevertOnIdenticalAssets() public {
        vm.prank(alice);
        vm.expectRevert(ComatoPolicy.IdenticalAssets.selector);
        registry.createPolicy(COLLATERAL, COLLATERAL, THRESHOLD, CAP, PREMIUM);
    }

    function test_CreatePolicy_RevertOnThresholdBelowMin() public {
        uint256 belowMin = registry.MIN_HF_THRESHOLD() - 1;
        vm.prank(alice);
        vm.expectRevert(ComatoPolicy.InvalidThreshold.selector);
        registry.createPolicy(COLLATERAL, DEBT, belowMin, CAP, PREMIUM);
    }

    function test_CreatePolicy_RevertOnThresholdAboveMax() public {
        uint256 aboveMax = registry.MAX_HF_THRESHOLD() + 1;
        vm.prank(alice);
        vm.expectRevert(ComatoPolicy.InvalidThreshold.selector);
        registry.createPolicy(COLLATERAL, DEBT, aboveMax, CAP, PREMIUM);
    }

    function test_CreatePolicy_RevertOnZeroCap() public {
        vm.prank(alice);
        vm.expectRevert(ComatoPolicy.ZeroRescueCap.selector);
        registry.createPolicy(COLLATERAL, DEBT, THRESHOLD, 0, PREMIUM);
    }

    function test_CreatePolicy_RevertOnCapAboveMax() public {
        uint256 tooHigh = registry.MAX_RESCUE_CAP() + 1;
        vm.prank(alice);
        vm.expectRevert(ComatoPolicy.RescueCapTooHigh.selector);
        registry.createPolicy(COLLATERAL, DEBT, THRESHOLD, tooHigh, PREMIUM);
    }

    function test_CreatePolicy_AllowsBoundaryCap() public {
        vm.prank(alice);
        uint256 id =
            registry.createPolicy(COLLATERAL, DEBT, THRESHOLD, registry.MAX_RESCUE_CAP(), PREMIUM);
        assertEq(registry.getPolicy(id).rescueCap, registry.MAX_RESCUE_CAP());
    }

    function test_CreatePolicy_AllowsBoundaryThresholds() public {
        vm.startPrank(alice);
        uint256 idMin = registry.createPolicy(COLLATERAL, DEBT, registry.MIN_HF_THRESHOLD(), CAP, 0);
        uint256 idMax = registry.createPolicy(COLLATERAL, DEBT, registry.MAX_HF_THRESHOLD(), CAP, 0);
        vm.stopPrank();
        assertEq(registry.getPolicy(idMin).hfThreshold, registry.MIN_HF_THRESHOLD());
        assertEq(registry.getPolicy(idMax).hfThreshold, registry.MAX_HF_THRESHOLD());
    }

    /*//////////////////////////////////////////////////////////////
                              DEACTIVATE
    //////////////////////////////////////////////////////////////*/

    function test_Deactivate_BySubscriber() public {
        uint256 id = _createAsAlice();
        vm.expectEmit(true, true, false, false);
        emit PolicyDeactivated(id, alice);
        vm.prank(alice);
        registry.deactivatePolicy(id);
        assertFalse(registry.isActive(id));
    }

    function test_Deactivate_ByOwner() public {
        uint256 id = _createAsAlice();
        vm.prank(owner);
        registry.deactivatePolicy(id);
        assertFalse(registry.isActive(id));
    }

    function test_Deactivate_ByOperator() public {
        uint256 id = _createAsAlice();
        bytes32 role = registry.OPERATOR_ROLE();
        vm.prank(owner);
        registry.grantRole(role, operator);
        vm.prank(operator);
        registry.deactivatePolicy(id);
        assertFalse(registry.isActive(id));
    }

    function test_Deactivate_RevertForStranger() public {
        uint256 id = _createAsAlice();
        vm.prank(bob);
        vm.expectRevert(ComatoPolicy.NotAuthorized.selector);
        registry.deactivatePolicy(id);
    }

    function test_Deactivate_RevertWhenAlreadyInactive() public {
        uint256 id = _createAsAlice();
        vm.prank(alice);
        registry.deactivatePolicy(id);
        vm.prank(alice);
        vm.expectRevert(ComatoPolicy.PolicyInactive.selector);
        registry.deactivatePolicy(id);
    }

    function test_Deactivate_RevertForUnknownPolicy() public {
        vm.prank(alice);
        vm.expectRevert(ComatoPolicy.PolicyNotFound.selector);
        registry.deactivatePolicy(999);
    }

    /*//////////////////////////////////////////////////////////////
                            VIEWS / OPERATOR
    //////////////////////////////////////////////////////////////*/

    function test_GetPolicy_RevertForUnknown() public {
        vm.expectRevert(ComatoPolicy.PolicyNotFound.selector);
        registry.getPolicy(42);
    }

    function test_IsActive_FalseForUnknown() public view {
        assertFalse(registry.isActive(42));
    }

    function test_GrantOperator_ByAdmin() public {
        bytes32 role = registry.OPERATOR_ROLE();
        vm.expectEmit(true, true, true, false);
        emit RoleGranted(role, operator, owner);
        vm.prank(owner);
        registry.grantRole(role, operator);
        assertTrue(registry.hasRole(role, operator));

        vm.prank(owner);
        registry.revokeRole(role, operator);
        assertFalse(registry.hasRole(role, operator));
    }

    function test_GrantOperator_RevertForNonAdmin() public {
        // OPERATOR_ROLE is administered by DEFAULT_ADMIN_ROLE; alice lacks it.
        bytes32 opRole = registry.OPERATOR_ROLE();
        bytes32 adminRole = registry.DEFAULT_ADMIN_ROLE();
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, alice, adminRole
            )
        );
        registry.grantRole(opRole, operator);
    }

    function test_Admin_HasDefaultAdminRole() public view {
        assertTrue(registry.hasRole(registry.DEFAULT_ADMIN_ROLE(), owner));
        assertFalse(registry.hasRole(registry.DEFAULT_ADMIN_ROLE(), alice));
    }

    /*//////////////////////////////////////////////////////////////
                                 FUZZ
    //////////////////////////////////////////////////////////////*/

    function testFuzz_CreatePolicy_ValidThreshold(uint256 hf, uint256 cap) public {
        hf = bound(hf, registry.MIN_HF_THRESHOLD(), registry.MAX_HF_THRESHOLD());
        cap = bound(cap, 1, registry.MAX_RESCUE_CAP());
        vm.prank(alice);
        uint256 id = registry.createPolicy(COLLATERAL, DEBT, hf, cap, PREMIUM);
        ComatoPolicy.Policy memory p = registry.getPolicy(id);
        assertEq(p.hfThreshold, hf);
        assertEq(p.rescueCap, cap);
        assertTrue(p.active);
    }

    function testFuzz_CreatePolicy_RevertOutOfBoundThreshold(uint256 hf) public {
        vm.assume(hf < registry.MIN_HF_THRESHOLD() || hf > registry.MAX_HF_THRESHOLD());
        vm.prank(alice);
        vm.expectRevert(ComatoPolicy.InvalidThreshold.selector);
        registry.createPolicy(COLLATERAL, DEBT, hf, CAP, PREMIUM);
    }
}
