// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ComatoGuard} from "./ComatoGuard.sol";
import {ComatoPolicy} from "./ComatoPolicy.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {BeaconProxy} from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

/// @title ComatoGuardFactory
/// @author Timo (timothyrondo)
/// @notice Deploys and tracks one {ComatoGuard} per subscriber, holds the canonical whitelist
///         template + fee defaults used to seed new guards, and controls the single upgrade path for
///         every guard.
///
/// @dev UPGRADE CHOICE — BEACON (justification): all guards are {BeaconProxy} instances pointing at
///      one {UpgradeableBeacon} that THIS factory owns. A single admin call
///      ({upgradeGuards}) atomically re-points every guard at a new implementation — no per-guard
///      migration, no redeploy. This is deliberately chosen over minimal-proxy {Clones}: Clones are
///      cheaper to deploy but are NON-upgradeable, so a logic fix would require redeploying every
///      guard and migrating each subscriber's float/whitelist/policy binding individually. For a
///      "real money" guard that may need a hot fix, one-switch upgradeability wins over per-deploy
///      gas. The trade-off (beacon proxies cost more gas per deploy, and the beacon is a trust
///      anchor) is accepted and contained: the beacon is owned by this factory and only
///      `DEFAULT_ADMIN_ROLE` can trigger an upgrade or move beacon ownership.
///
/// @dev ATTRIBUTION: guards produced here are the safety + fee layer; their token movements have
///      `from == guard`, so they do NOT count for Track 1 volume (constraint C1). See CLAUDE.md.
contract ComatoGuardFactory is AccessControl {
    using EnumerableSet for EnumerableSet.AddressSet;

    /*//////////////////////////////////////////////////////////////
                                 ROLES
    //////////////////////////////////////////////////////////////*/

    /// @notice The Comato agent: may deploy new guards for subscribers.
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    /*//////////////////////////////////////////////////////////////
                                CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Early-fail mirror of {ComatoGuard.MAX_FEE_BPS} (must equal it). The guard's
    ///         {ComatoGuard.initialize} is the HARD enforcement: any `feeBps` above the guard's own
    ///         cap reverts at guard creation, so a divergence here can only fail-closed (block
    ///         creation), never over-permit a fee.
    uint16 public constant MAX_FEE_BPS = 1000;

    /*//////////////////////////////////////////////////////////////
                               IMMUTABLES
    //////////////////////////////////////////////////////////////*/

    /// @notice The Aave V3 Pool guards rescue on.
    address public immutable POOL;

    /// @notice The {ComatoPolicy} registry guards read.
    address public immutable POLICY_REGISTRY;

    /// @notice The upgradeable beacon every guard proxy points at (owned by this factory).
    UpgradeableBeacon public immutable BEACON;

    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice The account granted `DEFAULT_ADMIN_ROLE` on each NEW guard. Stored at deploy time so a
    ///         guard's admin is stable and independent of who calls {createGuard} (the operator may
    ///         create guards but must NOT become their admin).
    address public guardAdmin;

    /// @notice Default operator hot wallet granted `OPERATOR_ROLE` on each new guard.
    address public defaultOperator;

    /// @notice Default guardian granted `GUARDIAN_ROLE` on each new guard.
    address public defaultGuardian;

    /// @notice Default protocol fee recipient seeded into each new guard.
    address public defaultFeeRecipient;

    /// @notice Default protocol fee (bps) seeded into each new guard; always `<= MAX_FEE_BPS`.
    uint16 public defaultFeeBps;

    /// @notice Canonical whitelist template (Aave Pool, DEX router, USDC/USDT) copied into new guards.
    EnumerableSet.AddressSet private _whitelistTemplate;

    /// @notice All guards deployed by this factory, in creation order.
    address[] public allGuards;

    /// @notice subscriber => their guard (0 if none). One guard per subscriber.
    mapping(address subscriber => address guard) public guardOf;

    /// @notice Whether an address is a guard deployed by this factory.
    mapping(address guard => bool) public isGuard;

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Emitted when the factory (and its beacon + implementation) is deployed.
    event FactoryDeployed(address indexed beacon, address indexed implementation, address admin);

    /// @notice Emitted when a new guard is created for a subscriber.
    event GuardCreated(
        address indexed guard,
        address indexed subscriber,
        uint256 indexed policyId,
        address operator
    );

    /// @notice Emitted when the beacon implementation is upgraded (affects ALL guards).
    event GuardsUpgraded(address indexed newImplementation);

    /// @notice Emitted when a guard is retired, freeing the subscriber's slot for re-creation.
    event GuardRetired(address indexed guard, address indexed subscriber);

    /// @notice Emitted when a target is added to or removed from the whitelist template.
    event WhitelistTemplateUpdated(address indexed target, bool allowed);

    /// @notice Emitted when the new-guard defaults change.
    event DefaultsUpdated(address operator, address guardian, address feeRecipient, uint16 feeBps);

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    /// @notice A required address argument was the zero address.
    error ZeroAddress();
    /// @notice `feeBps` exceeds `MAX_FEE_BPS`.
    error FeeTooHigh(uint16 feeBps);
    /// @notice The subscriber already has a guard.
    error GuardAlreadyExists(address subscriber, address guard);
    /// @notice The bound policy does not exist or its subscriber does not match `subscriber`.
    error PolicySubscriberMismatch(uint256 policyId, address subscriber);
    /// @notice The subscriber has no guard to retire.
    error NoGuardForSubscriber(address subscriber);

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /// @param pool The Aave V3 Pool address.
    /// @param policyRegistry The {ComatoPolicy} registry address.
    /// @param admin The Comato admin (holds `DEFAULT_ADMIN_ROLE`; also the operator by default and
    ///        the beacon-upgrade authority).
    /// @param operator The default agent hot wallet granted `OPERATOR_ROLE` on the factory and each
    ///        new guard.
    /// @param guardian The default emergency pauser seeded into each guard.
    /// @param feeRecipient The default protocol fee recipient seeded into each guard.
    /// @param feeBps The default protocol fee (bps), `<= MAX_FEE_BPS`.
    /// @param initialWhitelist Initial whitelisted targets copied into every new guard's template.
    /// @dev Deploys the shared {ComatoGuard} implementation and an {UpgradeableBeacon} owned by this
    ///      factory, so upgrades are gated by this contract's `DEFAULT_ADMIN_ROLE`.
    constructor(
        address pool,
        address policyRegistry,
        address admin,
        address operator,
        address guardian,
        address feeRecipient,
        uint16 feeBps,
        address[] memory initialWhitelist
    ) {
        if (
            pool == address(0) || policyRegistry == address(0) || admin == address(0)
                || feeRecipient == address(0)
        ) {
            revert ZeroAddress();
        }
        if (feeBps > MAX_FEE_BPS) revert FeeTooHigh(feeBps);

        POOL = pool;
        POLICY_REGISTRY = policyRegistry;

        // Deploy the shared implementation and a beacon owned by this factory.
        ComatoGuard implementation = new ComatoGuard(pool, policyRegistry);
        BEACON = new UpgradeableBeacon(address(implementation), address(this));

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        if (operator != address(0)) _grantRole(OPERATOR_ROLE, operator);

        guardAdmin = admin;
        defaultOperator = operator;
        defaultGuardian = guardian;
        defaultFeeRecipient = feeRecipient;
        defaultFeeBps = feeBps;

        uint256 len = initialWhitelist.length;
        for (uint256 i = 0; i < len; ++i) {
            address target = initialWhitelist[i];
            if (target == address(0)) revert ZeroAddress();
            if (_whitelistTemplate.add(target)) emit WhitelistTemplateUpdated(target, true);
        }

        emit FactoryDeployed(address(BEACON), address(implementation), admin);
    }

    /*//////////////////////////////////////////////////////////////
                             GUARD CREATION
    //////////////////////////////////////////////////////////////*/

    /// @notice Deploys a new guard (beacon proxy) for `subscriber`, bound to `policyId`, seeded with
    ///         the current whitelist template and fee defaults. Admin or operator only.
    /// @dev Validates the policy binding ON-CHAIN (`POLICY_REGISTRY.subscriberOf(policyId) ==
    ///      subscriber`) so a wrong/nonexistent id can't permanently brick the subscriber's
    ///      one-guard slot (`guardOf` is set-once; a mis-bound guard's `rescue` reverts forever). If a
    ///      guard ever does need re-binding (e.g. the subscriber renews to a new policy id), the admin
    ///      calls {retireGuard} first to free the slot.
    /// @param subscriber The protected borrower.
    /// @param policyId The {ComatoPolicy} id to bind (must exist and name `subscriber`).
    /// @return guard The deployed guard address.
    function createGuard(address subscriber, uint256 policyId)
        external
        onlyRoleOrOperator
        returns (address guard)
    {
        if (subscriber == address(0)) revert ZeroAddress();
        address existing = guardOf[subscriber];
        if (existing != address(0)) revert GuardAlreadyExists(subscriber, existing);
        // Bind only to a policy that actually names this subscriber (subscriberOf returns 0 for a
        // nonexistent id), so an operator fat-finger/compromise can't brick the slot with a guard
        // whose rescue would always revert SubscriberMismatch/PolicyNotFound.
        if (ComatoPolicy(POLICY_REGISTRY).subscriberOf(policyId) != subscriber) {
            revert PolicySubscriberMismatch(policyId, subscriber);
        }

        // The guard's admin is the factory-configured `guardAdmin`, independent of the caller: an
        // operator may create guards but must never become their admin.
        bytes memory initData = abi.encodeCall(
            ComatoGuard.initialize,
            (
                guardAdmin,
                defaultOperator,
                defaultGuardian,
                subscriber,
                policyId,
                defaultFeeRecipient,
                defaultFeeBps,
                _whitelistTemplate.values()
            )
        );

        guard = address(new BeaconProxy(address(BEACON), initData));

        allGuards.push(guard);
        guardOf[subscriber] = guard;
        isGuard[guard] = true;

        emit GuardCreated(guard, subscriber, policyId, defaultOperator);
    }

    /// @notice Frees a subscriber's guard slot so a corrected/renewed guard can be created. Admin
    ///         only. The retired guard contract still exists (and `isGuard` stays true for
    ///         provenance); the admin should drain its float via `ComatoGuard.withdrawFloat` first.
    /// @param subscriber The subscriber whose guard slot to clear.
    /// @return retired The address of the guard that was un-bound.
    function retireGuard(address subscriber)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        returns (address retired)
    {
        retired = guardOf[subscriber];
        if (retired == address(0)) revert NoGuardForSubscriber(subscriber);
        delete guardOf[subscriber];
        emit GuardRetired(retired, subscriber);
    }

    /*//////////////////////////////////////////////////////////////
                                UPGRADE
    //////////////////////////////////////////////////////////////*/

    /// @notice Upgrades the beacon implementation, atomically upgrading EVERY guard. Admin only.
    /// @param newImplementation The new {ComatoGuard} implementation.
    function upgradeGuards(address newImplementation) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newImplementation == address(0)) revert ZeroAddress();
        BEACON.upgradeTo(newImplementation);
        emit GuardsUpgraded(newImplementation);
    }

    /// @notice Transfers ownership of the beacon out of this factory (escape hatch). Admin only.
    /// @param newOwner The new beacon owner.
    function transferBeaconOwnership(address newOwner) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newOwner == address(0)) revert ZeroAddress();
        BEACON.transferOwnership(newOwner);
    }

    /*//////////////////////////////////////////////////////////////
                          TEMPLATE / DEFAULTS ADMIN
    //////////////////////////////////////////////////////////////*/

    /// @notice Adds or removes a target from the whitelist template used to seed NEW guards. Admin
    ///         only. Does not retroactively change existing guards (update those on the guard itself).
    function setWhitelistTemplate(address target, bool allowed)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (target == address(0)) revert ZeroAddress();
        bool changed = allowed ? _whitelistTemplate.add(target) : _whitelistTemplate.remove(target);
        if (changed) emit WhitelistTemplateUpdated(target, allowed);
    }

    /// @notice Updates the defaults SEEDED into NEW guards. Admin only. `feeBps` is hard-capped.
    /// @dev `operator` here is only the value copied into future guards; it does NOT change who may
    ///      call {createGuard} on this factory. To rotate the factory's own creator, use
    ///      `grantRole`/`revokeRole(OPERATOR_ROLE, ...)` directly — updating `defaultOperator` alone
    ///      leaves the previous factory `OPERATOR_ROLE` holder able to create guards.
    function setDefaults(address operator, address guardian, address feeRecipient, uint16 feeBps)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (feeRecipient == address(0)) revert ZeroAddress();
        if (feeBps > MAX_FEE_BPS) revert FeeTooHigh(feeBps);
        defaultOperator = operator;
        defaultGuardian = guardian;
        defaultFeeRecipient = feeRecipient;
        defaultFeeBps = feeBps;
        emit DefaultsUpdated(operator, guardian, feeRecipient, feeBps);
    }

    /// @notice Updates the admin granted `DEFAULT_ADMIN_ROLE` on NEW guards. Admin only. Does not
    ///         retroactively change existing guards.
    function setGuardAdmin(address newGuardAdmin) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newGuardAdmin == address(0)) revert ZeroAddress();
        guardAdmin = newGuardAdmin;
    }

    /*//////////////////////////////////////////////////////////////
                              VIEW HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @notice The number of guards deployed by this factory.
    function guardCount() external view returns (uint256) {
        return allGuards.length;
    }

    /// @notice The whitelist template targets seeded into new guards.
    function whitelistTemplate() external view returns (address[] memory) {
        return _whitelistTemplate.values();
    }

    /// @notice Whether `target` is in the whitelist template.
    function isTemplateWhitelisted(address target) external view returns (bool) {
        return _whitelistTemplate.contains(target);
    }

    /// @notice The current beacon implementation address (the logic all guards run).
    function guardImplementation() external view returns (address) {
        return BEACON.implementation();
    }

    /*//////////////////////////////////////////////////////////////
                                INTERNAL
    //////////////////////////////////////////////////////////////*/

    /// @dev Restricts to `DEFAULT_ADMIN_ROLE` or `OPERATOR_ROLE`.
    modifier onlyRoleOrOperator() {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender) && !hasRole(OPERATOR_ROLE, msg.sender)) {
            revert AccessControlUnauthorizedAccount(msg.sender, OPERATOR_ROLE);
        }
        _;
    }
}
