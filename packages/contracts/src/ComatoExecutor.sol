// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ComatoPolicy} from "./ComatoPolicy.sol";
import {IAaveV3Pool} from "./interfaces/IAaveV3Pool.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title ComatoExecutor
/// @author Comato
/// @notice Atomic, bounded liquidation-rescue executor for Aave V3 on Celo. Holds a debt-asset
///         float and, on an operator's call, repays part of a protected subscriber's debt to lift
///         their health factor back above the policy threshold.
///
/// @dev ATTRIBUTION TRADE-OFF (read before using this for the hackathon volume track):
///      Track 1 ("Most Revenue" / volume) on the Celo Dune leaderboard counts a token transfer
///      only when `transfer.from == tx.origin` (the EOA that signed the tx) inside an ERC-8021
///      tagged tx (constraint C1). When this contract calls `Pool.repay(...)`, Aave pulls the
///      repayment via `transferFrom(address(this), ...)`, so that transfer's `from` is THIS
///      CONTRACT, not the sending EOA. => Rescues routed through ComatoExecutor DO NOT count for
///      Track 1. They are still correct, atomic and bounded — this is the *safety* path.
///
///      The volume-earning path is the off-chain agent sending an **EOA-direct** `repay(onBehalfOf)`
///      (and EOA-direct treasury swaps) straight from `COMATO_WALLET`, tag appended, so the pulled
///      transfer's `from == tx.origin` and counts. Comato supports both:
///        - EOA-direct (agent):  counts for Track 1, but the two legs (fund -> EOA, EOA -> Aave)
///                               are sequential and non-atomic.
///        - ComatoExecutor:      atomic + capped safety net, but its internal legs are invisible to
///                               Track 1. Prefer EOA-direct for volume; use the Executor when a race
///                               window makes atomicity worth losing attribution.
///
/// @dev SECURITY / TRUST MODEL (audit-informed — do NOT auto-rescue naively):
///      The float held here is Comato's OWN capital, and `rescue` is an *unpriced* outflow: it
///      repays `policy.subscriber`'s Aave debt with that float. Eligibility is deliberately NOT
///      enforced on-chain — `ComatoPolicy.createPolicy` is permissionless (anyone can self-register
///      a policy with a `hfThreshold` up to 10.0 that is "breached" even for a healthy position),
///      and `premiumRatePerInterval` is informational only. On-chain, `rescue` is `onlyOperator` and
///      each repay is bounded by `min(policy.rescueCap, float)` (with `rescueCap <= MAX_RESCUE_CAP`)
///      and by Aave's outstanding-debt cap.
///
///      Therefore the OPERATOR (the off-chain agent) is the eligibility gate and MUST, before
///      calling `rescue`:
///        1. Verify the subscriber has actually PAID (matched x402 premium settlements to the
///           registered wallet) — never rescue an unfunded/free policy.
///        2. Confirm GENUINE distress (position near the liquidation line), not merely
///           `HF < subscriber-chosen threshold`.
///        3. Rate-limit / budget per policy — this contract has no cooldown or cumulative cap, so a
///           re-breaching or re-borrowing subscriber could otherwise drain float across calls.
///        4. Ensure `policy.debtAsset` is the subscriber's actual VARIABLE-rate debt asset; a repay
///           against an asset with no such debt reverts on live Aave (`NO_DEBT_OF_SELECTED_TYPE`).
///      Operator keys are hot wallets: a compromised operator can drain float to an attacker-owned
///      position within these bounds. Containment is the owner's `withdrawFloat` + policy
///      deactivation. A fuller on-chain premium/escrow binding is deferred (see contracts/CLAUDE.md).
contract ComatoExecutor is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                                CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Aave variable interest-rate mode (stable rate is disabled on Celo).
    uint256 public constant VARIABLE_RATE_MODE = 2;

    /// @notice Aave referral code (unused; kept at 0 per Aave convention).
    uint16 private constant REFERRAL_CODE = 0;

    /*//////////////////////////////////////////////////////////////
                               IMMUTABLES
    //////////////////////////////////////////////////////////////*/

    /// @notice The Aave V3 Pool this executor rescues positions on.
    IAaveV3Pool public immutable POOL;

    /// @notice The Comato policy registry read to authorize and bound each rescue.
    ComatoPolicy public immutable POLICY_REGISTRY;

    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice Addresses (besides the owner) allowed to trigger rescues.
    mapping(address account => bool) public isOperator;

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Emitted on a successful rescue.
    /// @param policyId The rescued policy.
    /// @param subscriber The borrower whose position was rescued.
    /// @param asset The debt asset repaid.
    /// @param amountRepaid The actual amount repaid to Aave (capped at outstanding debt).
    /// @param hfBefore Health factor (WAD) before the repay.
    /// @param hfAfter Health factor (WAD) after the repay.
    event RescueExecuted(
        uint256 indexed policyId,
        address indexed subscriber,
        address indexed asset,
        uint256 amountRepaid,
        uint256 hfBefore,
        uint256 hfAfter
    );

    /// @notice Emitted when float is deposited into the executor.
    event FloatDeposited(address indexed asset, address indexed from, uint256 amount);

    /// @notice Emitted when the owner withdraws float from the executor.
    event FloatWithdrawn(address indexed asset, address indexed to, uint256 amount);

    /// @notice Emitted when an operator is authorized or revoked.
    event OperatorSet(address indexed account, bool allowed);

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    /// @notice A required address argument was the zero address.
    error ZeroAddress();
    /// @notice A required amount argument was zero.
    error ZeroAmount();
    /// @notice Caller is neither the owner nor an authorized operator.
    error NotOperator();
    /// @notice The policy is not active, so it cannot be rescued.
    error PolicyNotActive();
    /// @notice The subscriber's health factor is at/above the policy threshold; no rescue needed.
    error HealthFactorNotBreached(uint256 healthFactor, uint256 threshold);
    /// @notice The executor holds no float in the debt asset, so nothing can be repaid.
    error NoFloatAvailable();

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /// @param pool The Aave V3 Pool address.
    /// @param policyRegistry The {ComatoPolicy} registry address.
    /// @param initialOwner The Comato admin/operator that owns the executor and its float.
    constructor(address pool, address policyRegistry, address initialOwner) Ownable(initialOwner) {
        if (pool == address(0) || policyRegistry == address(0)) revert ZeroAddress();
        POOL = IAaveV3Pool(pool);
        POLICY_REGISTRY = ComatoPolicy(policyRegistry);
    }

    /*//////////////////////////////////////////////////////////////
                                MODIFIERS
    //////////////////////////////////////////////////////////////*/

    /// @dev Restricts to the owner or an authorized operator.
    modifier onlyOperator() {
        if (msg.sender != owner() && !isOperator[msg.sender]) revert NotOperator();
        _;
    }

    /*//////////////////////////////////////////////////////////////
                             ADMIN FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Authorizes or revokes an operator allowed to trigger rescues.
    function setOperator(address account, bool allowed) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        isOperator[account] = allowed;
        emit OperatorSet(account, allowed);
    }

    /*//////////////////////////////////////////////////////////////
                           FLOAT MANAGEMENT
    //////////////////////////////////////////////////////////////*/

    /// @notice Deposits `amount` of `asset` as rescue float, pulled from `msg.sender`.
    /// @dev Requires prior ERC20 approval to this contract. Raw `transfer`s to this address also
    ///      work (float is read from `balanceOf`), but this path emits an accounting event.
    function depositFloat(address asset, uint256 amount) external nonReentrant {
        if (asset == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        emit FloatDeposited(asset, msg.sender, amount);
    }

    /// @notice Withdraws `amount` of `asset` float to `to`. Owner only.
    function withdrawFloat(address asset, uint256 amount, address to)
        external
        onlyOwner
        nonReentrant
    {
        if (asset == address(0) || to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        IERC20(asset).safeTransfer(to, amount);
        emit FloatWithdrawn(asset, to, amount);
    }

    /*//////////////////////////////////////////////////////////////
                                 RESCUE
    //////////////////////////////////////////////////////////////*/

    /// @notice Rescues the position behind `policyId` if its health factor is below the policy
    ///         threshold, repaying up to `min(rescueCap, floatBalance)` of the debt asset on the
    ///         subscriber's behalf.
    /// @dev Operator-only, non-reentrant, checks-effects-interactions. The repay amount is bounded
    ///      by the policy `rescueCap` (R13: never over-pull) and by the executor's own float; Aave
    ///      itself caps the pull at the outstanding debt.
    /// @param policyId The policy to rescue.
    /// @return amountRepaid The actual amount repaid to Aave.
    function rescue(uint256 policyId)
        external
        onlyOperator
        nonReentrant
        returns (uint256 amountRepaid)
    {
        // ---- Checks ----
        ComatoPolicy.Policy memory policy = POLICY_REGISTRY.getPolicy(policyId);
        if (!policy.active) revert PolicyNotActive();

        (,,,,, uint256 hfBefore) = POOL.getUserAccountData(policy.subscriber);
        if (hfBefore >= policy.hfThreshold) {
            revert HealthFactorNotBreached(hfBefore, policy.hfThreshold);
        }

        address debtAsset = policy.debtAsset;
        uint256 floatBalance = IERC20(debtAsset).balanceOf(address(this));
        if (floatBalance == 0) revert NoFloatAvailable();

        // Bound the repay by the policy cap and the available float. Aave caps again at the
        // outstanding debt, so a slight overshoot here is safe (it never over-repays on-chain).
        uint256 repayAmount = policy.rescueCap < floatBalance ? policy.rescueCap : floatBalance;

        // ---- Interactions ----
        // Grant Aave a fresh exact allowance, repay, then reset any residue (Aave only pulls up to
        // the outstanding debt, so an unused remainder can linger otherwise).
        IERC20(debtAsset).forceApprove(address(POOL), repayAmount);
        amountRepaid = POOL.repay(debtAsset, repayAmount, VARIABLE_RATE_MODE, policy.subscriber);
        if (amountRepaid < repayAmount) {
            IERC20(debtAsset).forceApprove(address(POOL), 0);
        }

        (,,,,, uint256 hfAfter) = POOL.getUserAccountData(policy.subscriber);

        emit RescueExecuted(policyId, policy.subscriber, debtAsset, amountRepaid, hfBefore, hfAfter);
    }

    /*//////////////////////////////////////////////////////////////
                              VIEW HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @notice Current debt-asset float held by the executor.
    function floatOf(address asset) external view returns (uint256) {
        return IERC20(asset).balanceOf(address(this));
    }

    /// @notice Reads the current health factor (WAD) of `user` from the Aave pool.
    function healthFactorOf(address user) external view returns (uint256 healthFactor) {
        (,,,,, healthFactor) = POOL.getUserAccountData(user);
    }
}
