// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ComatoGuard} from "../src/ComatoGuard.sol";
import {ComatoGuardFactory} from "../src/ComatoGuardFactory.sol";
import {ComatoPolicy} from "../src/ComatoPolicy.sol";
import {ComatoGuardV2} from "./mocks/ComatoGuardV2.sol";
import {MockAavePool} from "./mocks/MockAavePool.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Test} from "forge-std/Test.sol";

/// @notice Unit tests for {ComatoGuardFactory}: deployment, guard creation + tracking, seeding,
///         role gating, and the beacon upgrade that swaps the implementation for ALL guards.
contract ComatoGuardFactoryTest is Test {
    ComatoGuardFactory internal factory;
    ComatoPolicy internal registry;
    MockAavePool internal pool;
    MockERC20 internal collateral;
    MockERC20 internal debt;

    address internal admin = makeAddr("admin");
    address internal operator = makeAddr("operator");
    address internal guardian = makeAddr("guardian");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal stranger = makeAddr("stranger");

    uint16 internal constant FEE_BPS = 500;
    uint256 internal constant THRESHOLD = 1.05e18;
    uint256 internal constant CAP = 3000e6;

    address[] internal template;

    // Cached to avoid a role-view call consuming a preceding vm.prank inside expectRevert args.
    bytes32 internal F_ADMIN_ROLE;
    bytes32 internal F_OPERATOR_ROLE;

    function setUp() public {
        pool = new MockAavePool();
        collateral = new MockERC20("Collateral", "COL", 6);
        debt = new MockERC20("Debt USDC", "USDC", 6);
        registry = new ComatoPolicy(admin);

        template = new address[](2);
        template[0] = address(pool);
        template[1] = address(debt);

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

        F_ADMIN_ROLE = factory.DEFAULT_ADMIN_ROLE();
        F_OPERATOR_ROLE = factory.OPERATOR_ROLE();
    }

    function _createPolicy(address sub) internal returns (uint256 id) {
        vm.prank(sub);
        id = registry.createPolicy(address(collateral), address(debt), THRESHOLD, CAP, 0);
    }

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    function test_Constructor_DeploysBeaconImplAndConfig() public view {
        assertTrue(factory.hasRole(factory.DEFAULT_ADMIN_ROLE(), admin));
        assertTrue(factory.hasRole(factory.OPERATOR_ROLE(), operator));
        assertEq(factory.POOL(), address(pool));
        assertEq(factory.POLICY_REGISTRY(), address(registry));
        assertEq(factory.guardAdmin(), admin);
        assertEq(factory.defaultOperator(), operator);
        assertEq(factory.defaultFeeRecipient(), feeRecipient);
        assertEq(factory.defaultFeeBps(), FEE_BPS);
        assertTrue(factory.guardImplementation() != address(0), "impl deployed");
        assertEq(factory.BEACON().owner(), address(factory), "factory owns beacon");
        assertTrue(factory.isTemplateWhitelisted(address(pool)));
        assertTrue(factory.isTemplateWhitelisted(address(debt)));
    }

    function test_Constructor_RevertOnZeroPool() public {
        vm.expectRevert(ComatoGuardFactory.ZeroAddress.selector);
        new ComatoGuardFactory(
            address(0),
            address(registry),
            admin,
            operator,
            guardian,
            feeRecipient,
            FEE_BPS,
            template
        );
    }

    function test_Constructor_RevertOnZeroAdmin() public {
        vm.expectRevert(ComatoGuardFactory.ZeroAddress.selector);
        new ComatoGuardFactory(
            address(pool),
            address(registry),
            address(0),
            operator,
            guardian,
            feeRecipient,
            FEE_BPS,
            template
        );
    }

    function test_Constructor_RevertOnFeeTooHigh() public {
        uint16 tooHigh = factory.MAX_FEE_BPS() + 1;
        vm.expectRevert(abi.encodeWithSelector(ComatoGuardFactory.FeeTooHigh.selector, tooHigh));
        new ComatoGuardFactory(
            address(pool),
            address(registry),
            admin,
            operator,
            guardian,
            feeRecipient,
            tooHigh,
            template
        );
    }

    /*//////////////////////////////////////////////////////////////
                            GUARD CREATION
    //////////////////////////////////////////////////////////////*/

    function test_CreateGuard_ByAdmin_TracksAndSeeds() public {
        uint256 id = _createPolicy(alice);
        vm.prank(admin);
        address guardAddr = factory.createGuard(alice, id);

        assertEq(factory.guardOf(alice), guardAddr);
        assertTrue(factory.isGuard(guardAddr));
        assertEq(factory.guardCount(), 1);
        assertEq(factory.allGuards(0), guardAddr);

        ComatoGuard g = ComatoGuard(payable(guardAddr));
        assertEq(g.subscriber(), alice);
        assertEq(g.policyId(), id);
        assertEq(g.feeBps(), FEE_BPS);
        assertEq(g.feeRecipient(), feeRecipient);
        // Whitelist seeded from template.
        assertTrue(g.isWhitelisted(address(pool)));
        assertTrue(g.isWhitelisted(address(debt)));
        // Guard admin is the configured admin, NOT the caller.
        assertTrue(g.hasRole(g.DEFAULT_ADMIN_ROLE(), admin));
        assertTrue(g.hasRole(g.OPERATOR_ROLE(), operator));
        assertTrue(g.hasRole(g.GUARDIAN_ROLE(), guardian));
    }

    function test_CreateGuard_ByOperator_GuardAdminIsNotOperator() public {
        uint256 id = _createPolicy(alice);
        vm.prank(operator);
        address guardAddr = factory.createGuard(alice, id);

        ComatoGuard g = ComatoGuard(payable(guardAddr));
        assertTrue(g.hasRole(g.DEFAULT_ADMIN_ROLE(), admin), "admin is configured admin");
        assertFalse(g.hasRole(g.DEFAULT_ADMIN_ROLE(), operator), "operator is NOT guard admin");
    }

    function test_CreateGuard_RevertForStranger() public {
        uint256 id = _createPolicy(alice);
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, F_OPERATOR_ROLE
            )
        );
        factory.createGuard(alice, id);
    }

    function test_CreateGuard_RevertOnDuplicateSubscriber() public {
        uint256 id = _createPolicy(alice);
        vm.prank(admin);
        address first = factory.createGuard(alice, id);
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(ComatoGuardFactory.GuardAlreadyExists.selector, alice, first)
        );
        factory.createGuard(alice, id);
    }

    function test_CreateGuard_MultipleSubscribersDistinctGuards() public {
        uint256 idA = _createPolicy(alice);
        uint256 idB = _createPolicy(bob);
        vm.startPrank(admin);
        address gA = factory.createGuard(alice, idA);
        address gB = factory.createGuard(bob, idB);
        vm.stopPrank();
        assertTrue(gA != gB);
        assertEq(factory.guardCount(), 2);
    }

    function test_CreateGuard_RevertOnPolicySubscriberMismatch() public {
        uint256 id = _createPolicy(alice); // policy names alice
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(ComatoGuardFactory.PolicySubscriberMismatch.selector, id, bob)
        );
        factory.createGuard(bob, id); // binding bob to alice's policy is rejected
    }

    function test_CreateGuard_RevertOnNonexistentPolicy() public {
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                ComatoGuardFactory.PolicySubscriberMismatch.selector, uint256(999), alice
            )
        );
        factory.createGuard(alice, 999);
    }

    /*//////////////////////////////////////////////////////////////
                       RETIRE / REBIND RECOVERY
    //////////////////////////////////////////////////////////////*/

    function test_RetireGuard_FreesSlotForRecreation() public {
        uint256 id = _createPolicy(alice);
        vm.prank(admin);
        address g1 = factory.createGuard(alice, id);

        vm.prank(admin);
        address retired = factory.retireGuard(alice);
        assertEq(retired, g1);
        assertEq(factory.guardOf(alice), address(0), "slot freed");

        // Subscriber renews to a new policy; a corrected guard can now be created.
        uint256 id2 = _createPolicy(alice);
        vm.prank(admin);
        address g2 = factory.createGuard(alice, id2);
        assertTrue(g2 != g1, "fresh guard");
        assertEq(factory.guardOf(alice), g2);
    }

    function test_RetireGuard_RevertForNonAdmin() public {
        uint256 id = _createPolicy(alice);
        vm.prank(admin);
        factory.createGuard(alice, id);
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, operator, F_ADMIN_ROLE
            )
        );
        factory.retireGuard(alice);
    }

    function test_RetireGuard_RevertWhenNoGuard() public {
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(ComatoGuardFactory.NoGuardForSubscriber.selector, alice)
        );
        factory.retireGuard(alice);
    }

    /*//////////////////////////////////////////////////////////////
                          BEACON UPGRADE
    //////////////////////////////////////////////////////////////*/

    function test_UpgradeGuards_SwapsImplForAllGuards() public {
        uint256 idA = _createPolicy(alice);
        uint256 idB = _createPolicy(bob);
        vm.startPrank(admin);
        address gA = factory.createGuard(alice, idA);
        address gB = factory.createGuard(bob, idB);
        vm.stopPrank();

        // Before upgrade: version() does not exist on V1.
        vm.expectRevert();
        ComatoGuardV2(payable(gA)).version();

        // Deploy V2 impl and upgrade the single beacon.
        ComatoGuardV2 v2 = new ComatoGuardV2(address(pool), address(registry));
        vm.prank(admin);
        factory.upgradeGuards(address(v2));

        // After upgrade: BOTH guards expose the new logic...
        assertEq(ComatoGuardV2(payable(gA)).version(), 2);
        assertEq(ComatoGuardV2(payable(gB)).version(), 2);
        assertEq(factory.guardImplementation(), address(v2));

        // ...and preserve their storage (subscriber binding, roles, whitelist).
        assertEq(ComatoGuard(payable(gA)).subscriber(), alice);
        assertEq(ComatoGuard(payable(gB)).subscriber(), bob);
        assertTrue(ComatoGuard(payable(gA)).isWhitelisted(address(pool)));
        assertTrue(
            ComatoGuard(payable(gA)).hasRole(ComatoGuard(payable(gA)).OPERATOR_ROLE(), operator)
        );
    }

    function test_UpgradeGuards_RevertForNonAdmin() public {
        ComatoGuardV2 v2 = new ComatoGuardV2(address(pool), address(registry));
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, operator, F_ADMIN_ROLE
            )
        );
        factory.upgradeGuards(address(v2));
    }

    function test_TransferBeaconOwnership_AdminOnly() public {
        address newOwner = makeAddr("newBeaconOwner");
        vm.prank(admin);
        factory.transferBeaconOwnership(newOwner);
        assertEq(factory.BEACON().owner(), newOwner);
    }

    /*//////////////////////////////////////////////////////////////
                        TEMPLATE / DEFAULTS ADMIN
    //////////////////////////////////////////////////////////////*/

    function test_SetWhitelistTemplate_AdminOnly_SeedsFutureGuards() public {
        address router = makeAddr("router");
        vm.prank(admin);
        factory.setWhitelistTemplate(router, true);
        assertTrue(factory.isTemplateWhitelisted(router));

        uint256 id = _createPolicy(alice);
        vm.prank(admin);
        ComatoGuard g = ComatoGuard(payable(factory.createGuard(alice, id)));
        assertTrue(g.isWhitelisted(router), "new guard seeded with updated template");
    }

    function test_SetWhitelistTemplate_RevertForNonAdmin() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, F_ADMIN_ROLE
            )
        );
        factory.setWhitelistTemplate(makeAddr("x"), true);
    }

    function test_SetDefaults_AdminOnly_CapEnforced() public {
        vm.prank(admin);
        factory.setDefaults(operator, guardian, feeRecipient, 800);
        assertEq(factory.defaultFeeBps(), 800);

        uint16 tooHigh = factory.MAX_FEE_BPS() + 1;
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(ComatoGuardFactory.FeeTooHigh.selector, tooHigh));
        factory.setDefaults(operator, guardian, feeRecipient, tooHigh);
    }

    function test_SetGuardAdmin_AdminOnly() public {
        address newAdmin = makeAddr("newAdmin");
        vm.prank(admin);
        factory.setGuardAdmin(newAdmin);
        assertEq(factory.guardAdmin(), newAdmin);

        uint256 id = _createPolicy(alice);
        vm.prank(admin);
        ComatoGuard g = ComatoGuard(payable(factory.createGuard(alice, id)));
        assertTrue(g.hasRole(g.DEFAULT_ADMIN_ROLE(), newAdmin), "new guard uses new admin");
    }
}
