// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ComatoPolicy} from "../../src/ComatoPolicy.sol";
import {Test} from "forge-std/Test.sol";

/// @notice Stateful handler that drives random-but-valid policy lifecycle actions so the invariant
///         runner can explore reachable registry states.
contract PolicyHandler is Test {
    ComatoPolicy public registry;
    address[] internal subscribers;

    uint256 public createdCount;
    uint256[] public deactivatedIds;

    constructor(ComatoPolicy registry_, address[] memory subscribers_) {
        registry = registry_;
        subscribers = subscribers_;
    }

    function createPolicy(
        uint256 subSeed,
        uint256 collateralSeed,
        uint256 debtSeed,
        uint256 hf,
        uint256 cap,
        uint256 premium
    ) external {
        address sub = subscribers[subSeed % subscribers.length];
        address collateral = address(uint160(bound(collateralSeed, 1, type(uint160).max)));
        address debt = address(uint160(bound(debtSeed, 1, type(uint160).max)));
        if (debt == collateral) {
            debt = address(uint160(bound(uint256(uint160(collateral)) + 1, 1, type(uint160).max)));
            if (debt == collateral) debt = address(uint160(uint256(uint160(collateral)) - 1));
        }
        hf = bound(hf, registry.MIN_HF_THRESHOLD(), registry.MAX_HF_THRESHOLD());
        cap = bound(cap, 1, registry.MAX_RESCUE_CAP());

        vm.prank(sub);
        registry.createPolicy(collateral, debt, hf, cap, premium);
        createdCount++;
    }

    function deactivate(uint256 idSeed) external {
        uint256 next = registry.nextPolicyId();
        if (next <= 1) return;
        uint256 id = bound(idSeed, 1, next - 1);
        if (!registry.isActive(id)) return;
        address sub = registry.subscriberOf(id);
        vm.prank(sub);
        registry.deactivatePolicy(id);
        deactivatedIds.push(id);
    }

    function deactivatedCount() external view returns (uint256) {
        return deactivatedIds.length;
    }
}

/// @notice Invariants for the policy registry: id accounting, well-formedness, and the one-way
///         active -> inactive transition.
contract ComatoPolicyInvariants is Test {
    ComatoPolicy internal registry;
    PolicyHandler internal handler;

    function setUp() public {
        registry = new ComatoPolicy(address(this));
        address[] memory subs = new address[](3);
        subs[0] = makeAddr("sub1");
        subs[1] = makeAddr("sub2");
        subs[2] = makeAddr("sub3");
        handler = new PolicyHandler(registry, subs);
        targetContract(address(handler));
    }

    /// @dev Ids are dense and monotonic: exactly one id is consumed per successful create.
    function invariant_NextPolicyIdEqualsCreatedPlusOne() public view {
        assertEq(registry.nextPolicyId(), handler.createdCount() + 1);
    }

    /// @dev Every created policy is well-formed and never silently disappears.
    function invariant_AllPoliciesWellFormed() public view {
        uint256 next = registry.nextPolicyId();
        for (uint256 id = 1; id < next; id++) {
            ComatoPolicy.Policy memory p = registry.getPolicy(id);
            assertTrue(p.subscriber != address(0), "subscriber set");
            assertGe(p.hfThreshold, registry.MIN_HF_THRESHOLD(), "threshold >= min");
            assertLe(p.hfThreshold, registry.MAX_HF_THRESHOLD(), "threshold <= max");
            assertGt(p.rescueCap, 0, "cap > 0");
            assertLe(p.rescueCap, registry.MAX_RESCUE_CAP(), "cap <= max");
            assertTrue(p.collateralAsset != p.debtAsset, "assets differ");
        }
    }

    /// @dev A deactivated policy can never become active again (no reactivate path exists).
    function invariant_DeactivatedStaysInactive() public view {
        uint256 c = handler.deactivatedCount();
        for (uint256 i = 0; i < c; i++) {
            assertFalse(registry.isActive(handler.deactivatedIds(i)), "stays inactive");
        }
    }
}
