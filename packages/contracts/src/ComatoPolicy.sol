// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title ComatoPolicy
/// @author Comato
/// @notice Registry of gasless liquidation-rescue insurance policies for Aave V3 on Celo.
/// @dev Each policy is owned by its `subscriber` (the borrower being protected). Access is governed
///      by OpenZeppelin {AccessControl} (matching the {ComatoGuard}/{ComatoGuardFactory} layer):
///      `DEFAULT_ADMIN_ROLE` is the Comato admin (manages roles), and `OPERATOR_ROLE` holders (e.g.
///      the off-chain agent's hot wallet or the {ComatoExecutor}) may administer policies. Reads are
///      public views; there are no funds held here — pure registry state, no reentrancy surface.
contract ComatoPolicy is AccessControl {
    /*//////////////////////////////////////////////////////////////
                                CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Role allowed to administer policies alongside the subscriber (e.g. the agent wallet).
    /// @dev `DEFAULT_ADMIN_ROLE` (the deployer/admin) grants and revokes it via {AccessControl}.
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    /// @notice 1.0 in WAD, the health-factor unit used by Aave (`healthFactor < WAD` is liquidatable).
    uint256 public constant WAD = 1e18;

    /// @notice Lowest acceptable rescue threshold: exactly the liquidation line (HF = 1.0).
    /// @dev A threshold below 1.0 would only fire after the position is already liquidatable, which
    ///      is useless for protection, so it is rejected.
    uint256 public constant MIN_HF_THRESHOLD = WAD;

    /// @notice Highest acceptable rescue threshold (HF = 10.0), a sanity cap against fat-finger values.
    uint256 public constant MAX_HF_THRESHOLD = 10 * WAD;

    /// @notice Upper bound on a policy's `rescueCap`, a sanity ceiling mirroring `MAX_HF_THRESHOLD`.
    /// @dev Denominated in the debt asset's smallest unit; sized for 6-decimal stablecoins
    ///      (USDC/USDT), so 1_000_000e6 == $1,000,000 per rescue. Prevents a policy from being
    ///      provisioned with an unbounded (e.g. `type(uint256).max`) cap that would let a single
    ///      rescue lay claim to the executor's entire shared float. The executor additionally bounds
    ///      each repay by its available float and by the subscriber's outstanding Aave debt.
    uint256 public constant MAX_RESCUE_CAP = 1_000_000e6;

    /*//////////////////////////////////////////////////////////////
                                 TYPES
    //////////////////////////////////////////////////////////////*/

    /// @notice A single insurance policy.
    /// @param subscriber The borrower whose Aave position is protected (policy owner).
    /// @param collateralAsset The asset the subscriber posts as collateral on Aave.
    /// @param debtAsset The borrowed asset a rescue repays (must match the {ComatoExecutor} float).
    /// @param hfThreshold Health factor (WAD) strictly below which a rescue may fire.
    /// @param rescueCap Maximum debt-asset amount (token units) a single rescue may repay.
    /// @param premiumRatePerInterval Streaming premium per protection interval (debt-asset units).
    /// @param active Whether the policy is currently armed.
    struct Policy {
        address subscriber;
        address collateralAsset;
        address debtAsset;
        uint256 hfThreshold;
        uint256 rescueCap;
        uint256 premiumRatePerInterval;
        bool active;
    }

    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice Auto-incrementing id of the next policy to be created (ids start at 1).
    uint256 public nextPolicyId = 1;

    /// @notice policyId => policy.
    mapping(uint256 policyId => Policy) private _policies;

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Emitted when a subscriber creates a policy.
    event PolicyCreated(
        uint256 indexed policyId,
        address indexed subscriber,
        address indexed collateralAsset,
        address debtAsset,
        uint256 hfThreshold,
        uint256 rescueCap,
        uint256 premiumRatePerInterval
    );

    /// @notice Emitted when a policy is deactivated. `caller` is whoever deactivated it.
    event PolicyDeactivated(uint256 indexed policyId, address indexed caller);

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    /// @notice A required address argument was the zero address.
    error ZeroAddress();
    /// @notice Collateral and debt assets must differ.
    error IdenticalAssets();
    /// @notice `hfThreshold` was outside `[MIN_HF_THRESHOLD, MAX_HF_THRESHOLD]`.
    error InvalidThreshold();
    /// @notice `rescueCap` must be greater than zero.
    error ZeroRescueCap();
    /// @notice `rescueCap` exceeds `MAX_RESCUE_CAP`.
    error RescueCapTooHigh();
    /// @notice The referenced policy id does not exist.
    error PolicyNotFound();
    /// @notice The policy is already inactive.
    error PolicyInactive();
    /// @notice Caller is neither the policy subscriber nor an authorized operator/owner.
    error NotAuthorized();

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /// @param admin The Comato admin address; receives `DEFAULT_ADMIN_ROLE` (manages operator roles).
    constructor(address admin) {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /*//////////////////////////////////////////////////////////////
                           SUBSCRIBER FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Creates a new policy owned by `msg.sender`.
    /// @param collateralAsset The collateral asset on Aave.
    /// @param debtAsset The borrowed asset a rescue repays.
    /// @param hfThreshold Health factor (WAD) strictly below which a rescue may fire; in
    ///        `[MIN_HF_THRESHOLD, MAX_HF_THRESHOLD]`.
    /// @param rescueCap Max debt-asset amount a single rescue may repay; in `(0, MAX_RESCUE_CAP]`.
    /// @param premiumRatePerInterval Streaming premium per interval (informational on-chain).
    /// @return policyId The id of the newly created policy.
    function createPolicy(
        address collateralAsset,
        address debtAsset,
        uint256 hfThreshold,
        uint256 rescueCap,
        uint256 premiumRatePerInterval
    ) external returns (uint256 policyId) {
        if (collateralAsset == address(0) || debtAsset == address(0)) revert ZeroAddress();
        if (collateralAsset == debtAsset) revert IdenticalAssets();
        if (hfThreshold < MIN_HF_THRESHOLD || hfThreshold > MAX_HF_THRESHOLD) {
            revert InvalidThreshold();
        }
        if (rescueCap == 0) revert ZeroRescueCap();
        if (rescueCap > MAX_RESCUE_CAP) revert RescueCapTooHigh();

        policyId = nextPolicyId++;
        _policies[policyId] = Policy({
            subscriber: msg.sender,
            collateralAsset: collateralAsset,
            debtAsset: debtAsset,
            hfThreshold: hfThreshold,
            rescueCap: rescueCap,
            premiumRatePerInterval: premiumRatePerInterval,
            active: true
        });

        emit PolicyCreated(
            policyId,
            msg.sender,
            collateralAsset,
            debtAsset,
            hfThreshold,
            rescueCap,
            premiumRatePerInterval
        );
    }

    /// @notice Deactivates a policy, disarming future rescues.
    /// @dev Callable by the policy's subscriber, an `OPERATOR_ROLE` holder, or a `DEFAULT_ADMIN_ROLE`
    ///      holder (the admin).
    /// @param policyId The policy to deactivate.
    function deactivatePolicy(uint256 policyId) external {
        Policy storage policy = _policies[policyId];
        if (policy.subscriber == address(0)) revert PolicyNotFound();
        if (!policy.active) revert PolicyInactive();

        bool authorized = msg.sender == policy.subscriber || hasRole(DEFAULT_ADMIN_ROLE, msg.sender)
            || hasRole(OPERATOR_ROLE, msg.sender);
        if (!authorized) revert NotAuthorized();

        policy.active = false;
        emit PolicyDeactivated(policyId, msg.sender);
    }

    /*//////////////////////////////////////////////////////////////
                              VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Returns the full policy record for `policyId`.
    /// @dev Reverts {PolicyNotFound} for unknown ids so callers never act on a zeroed struct.
    function getPolicy(uint256 policyId) external view returns (Policy memory policy) {
        policy = _policies[policyId];
        if (policy.subscriber == address(0)) revert PolicyNotFound();
    }

    /// @notice Returns whether `policyId` exists and is currently active.
    function isActive(uint256 policyId) external view returns (bool) {
        return _policies[policyId].active;
    }

    /// @notice Returns the subscriber that owns `policyId` (zero if it does not exist).
    function subscriberOf(uint256 policyId) external view returns (address) {
        return _policies[policyId].subscriber;
    }
}
