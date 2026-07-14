// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ComatoPolicy} from "./ComatoPolicy.sol";
import {IAaveV3Pool} from "./interfaces/IAaveV3Pool.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

/// @title ComatoGuard
/// @author Timo (timothyrondo)
/// @notice Per-subscriber, whitelist-gated executor + bounded liquidation-rescue guard for Aave V3
///         on Celo. One guard protects one subscriber's Aave position. It holds a debt-asset float,
///         lets the Comato agent (`OPERATOR_ROLE`) run whitelist-confined calls (repay / deleverage
///         via the Aave Pool + a DEX router + the stablecoins) and a dedicated bounded `rescue`, and
///         charges a hard-capped protocol fee on a successful rescue.
///
/// @dev DEPLOYMENT: this contract is the shared implementation behind one {BeaconProxy} per
///      subscriber, all pointing at a single {UpgradeableBeacon} the {ComatoGuardFactory} owns.
///      `POOL` and `POLICY_REGISTRY` are global to a deployment, so they are `immutable` (baked into
///      the implementation bytecode, shared by every proxy, gas-cheap). Per-subscriber state lives in
///      proxy storage and is set once by {initialize}. The implementation's constructor calls
///      {_disableInitializers} so the logic contract itself can never be initialized/hijacked.
///
/// @dev STORAGE SAFETY (upgrades): the OpenZeppelin bases used here are proxy-safe:
///      - {Initializable} and {ReentrancyGuardTransient} use ERC-7201 namespaced / transient slots.
///      - {AccessControl} (`_roles`) has no constructor; {Pausable}'s constructor writes only the
///        ZERO-value default (`_paused = false`). So a proxy that never runs those constructors is
///        still correct: roles are granted in {initialize}, and `_paused` is already `false` (0).
///      Upgrades MUST only append new state variables, never reorder/remove existing ones.
///
/// @dev ATTRIBUTION (read `packages/contracts/CLAUDE.md`): actions routed through THIS contract have
///      `transfer.from == address(this)`, i.e. the contract, not the tx-sending EOA. They therefore
///      DO NOT count for Track 1 volume (constraint C1). That is intentional — the guard is the
///      **safety + fee** layer. The Track-1 volume path stays EOA-direct in the off-chain agent.
///
/// @dev TRUST MODEL (audit-informed — do NOT auto-rescue naively, and treat the operator as trusted):
///      1. `rescue` is an *unpriced* outflow of the guard's own float. Eligibility (premium paid via
///         x402, genuine distress, correct variable-debt asset, per-policy rate-limiting) is NOT
///         enforced on-chain and is the OPERATOR's (off-chain agent's) responsibility. On-chain,
///         `rescue` is `OPERATOR_ROLE`-only and bounded by `min(policy.rescueCap, float-after-fee)`
///         and Aave's outstanding debt.
///      2. `execute`/`executeBatch` run arbitrary calldata against WHITELISTED targets only. The
///         whitelist confines *targets* (Aave Pool, DEX router, USDC/USDT), NOT selectors — a
///         compromised operator could, within the whitelist, move funds (e.g. `USDC.transfer`) or
///         plant a standing `approve`. Containment is: `GUARDIAN_ROLE` pause (halts execute +
///         rescue), admin operator rotation, admin whitelist control, admin `withdrawFloat`, and
///         admin `revokeAllowance` (neutralizes a standing approval that would otherwise survive
///         pause/rotation). A per-target selector allow-list is a documented, deferred hardening
///         (see CLAUDE.md open questions).
contract ComatoGuard is Initializable, AccessControl, Pausable, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.AddressSet;

    /*//////////////////////////////////////////////////////////////
                                 ROLES
    //////////////////////////////////////////////////////////////*/

    /// @notice The Comato agent hot wallet: may `rescue` and run whitelisted `execute`/`executeBatch`.
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    /// @notice Emergency pauser: may `pause` the guard (halting rescue + execute). Admin unpauses.
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    /*//////////////////////////////////////////////////////////////
                                CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Aave variable interest-rate mode (stable rate is disabled on Celo).
    uint256 public constant VARIABLE_RATE_MODE = 2;

    /// @notice Aave referral code (unused; kept at 0 per Aave convention).
    uint16 private constant REFERRAL_CODE = 0;

    /// @notice Basis-point denominator (100% = 10_000 bps).
    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @notice Hard ceiling on the protocol rescue fee (10%). `feeBps` can NEVER exceed this.
    /// @dev The fee is a percentage of the debt *repaid* by a rescue (see {rescue}); the product's
    ///      "5–10% success fee" is realized by the operator sizing rescues, and the on-chain cap
    ///      bounds it at 10% of principal moved. Not a percentage of the penalty avoided.
    uint16 public constant MAX_FEE_BPS = 1000;

    /*//////////////////////////////////////////////////////////////
                               IMMUTABLES
    //////////////////////////////////////////////////////////////*/

    /// @notice The Aave V3 Pool this guard rescues positions on (global; in implementation bytecode).
    IAaveV3Pool public immutable POOL;

    /// @notice The Comato policy registry read to authorize and bound each rescue (global).
    ComatoPolicy public immutable POLICY_REGISTRY;

    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice The factory that deployed this guard (msg.sender at {initialize}).
    address public factory;

    /// @notice The borrower whose Aave position this guard protects.
    address public subscriber;

    /// @notice The {ComatoPolicy} id bound to this guard; its terms bound every rescue.
    uint256 public policyId;

    /// @notice Recipient of the protocol rescue fee. Packed with {feeBps} into one slot.
    address public feeRecipient;

    /// @notice Current protocol rescue fee in basis points; always `<= MAX_FEE_BPS`.
    uint16 public feeBps;

    /// @notice Allowed call targets for `execute`/`executeBatch` (Aave Pool, DEX router, USDC/USDT).
    EnumerableSet.AddressSet private _whitelist;

    /*//////////////////////////////////////////////////////////////
                                 TYPES
    //////////////////////////////////////////////////////////////*/

    /// @notice A single whitelisted call in a batch.
    /// @param target The contract to call (must be whitelisted).
    /// @param value Native value to forward (usually 0 on Celo — assets are ERC-20).
    /// @param data ABI-encoded calldata.
    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Emitted once when the proxy is initialized with its subscriber/policy binding.
    event GuardInitialized(
        address indexed factory,
        address indexed subscriber,
        uint256 indexed policyId,
        address feeRecipient,
        uint16 feeBps
    );

    /// @notice Emitted when a target is added to or removed from the whitelist.
    event WhitelistUpdated(address indexed target, bool allowed);

    /// @notice Emitted when the fee configuration changes.
    event FeeConfigUpdated(address indexed feeRecipient, uint16 feeBps);

    /// @notice Emitted for every whitelisted call executed (single or within a batch).
    event Executed(address indexed target, uint256 value, bytes4 selector);

    /// @notice Emitted on a successful rescue.
    event RescueExecuted(
        uint256 indexed policyId,
        address indexed subscriber,
        address indexed asset,
        uint256 amountRepaid,
        uint256 hfBefore,
        uint256 hfAfter
    );

    /// @notice Emitted when a protocol fee is taken on a rescue.
    event FeeCharged(address indexed feeRecipient, address indexed asset, uint256 amount);

    /// @notice Emitted when float is deposited into the guard.
    event FloatDeposited(address indexed asset, address indexed from, uint256 amount);

    /// @notice Emitted when the admin withdraws float from the guard.
    event FloatWithdrawn(address indexed asset, address indexed to, uint256 amount);

    /// @notice Emitted when native balance is swept out by the admin.
    event NativeSwept(address indexed to, uint256 amount);

    /// @notice Emitted when a rescue's protocol fee could not be delivered and was skipped (the
    ///         reserved amount stays as admin-recoverable float). The rescue itself still succeeded.
    event FeeSkipped(address indexed feeRecipient, address indexed asset);

    /// @notice Emitted when the admin resets a token allowance the guard had granted a spender.
    event AllowanceRevoked(address indexed token, address indexed spender);

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    /// @notice A required address argument was the zero address.
    error ZeroAddress();
    /// @notice A required amount argument was zero.
    error ZeroAmount();
    /// @notice The call target is not whitelisted.
    error NotWhitelisted(address target);
    /// @notice The whitelisted target has no code (a low-level call would silently succeed).
    error TargetHasNoCode(address target);
    /// @notice A whitelisted call reverted; the target's revert data is bubbled up when available.
    error CallFailed(address target);
    /// @notice `pushFee` was called by anything other than the guard itself.
    error OnlySelf();
    /// @notice A batch was submitted with no calls.
    error EmptyBatch();
    /// @notice The policy is not active, so it cannot be rescued.
    error PolicyNotActive();
    /// @notice The bound policy's subscriber does not match this guard's subscriber.
    error SubscriberMismatch();
    /// @notice The subscriber's health factor is at/above the policy threshold; no rescue needed.
    error HealthFactorNotBreached(uint256 healthFactor, uint256 threshold);
    /// @notice The guard holds no float in the debt asset, so nothing can be repaid.
    error NoFloatAvailable();
    /// @notice `feeBps` exceeds `MAX_FEE_BPS`.
    error FeeTooHigh(uint16 feeBps);

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /// @param pool The Aave V3 Pool address (global to the deployment).
    /// @param policyRegistry The {ComatoPolicy} registry address (global to the deployment).
    /// @dev Sets the shared immutables and locks the implementation so it can never be initialized
    ///      directly — only proxies pointing at the beacon are initialized (via {initialize}).
    constructor(address pool, address policyRegistry) {
        if (pool == address(0) || policyRegistry == address(0)) revert ZeroAddress();
        POOL = IAaveV3Pool(pool);
        POLICY_REGISTRY = ComatoPolicy(policyRegistry);
        _disableInitializers();
    }

    /*//////////////////////////////////////////////////////////////
                              INITIALIZER
    //////////////////////////////////////////////////////////////*/

    /// @notice Initializes a freshly-deployed guard proxy. Callable exactly once, atomically inside
    ///         the {BeaconProxy} constructor by the factory.
    /// @param admin The Comato admin (holds `DEFAULT_ADMIN_ROLE`: whitelist/fee/roles/withdraw).
    /// @param operator The Comato agent hot wallet (holds `OPERATOR_ROLE`).
    /// @param guardian The emergency pauser (holds `GUARDIAN_ROLE`).
    /// @param subscriber_ The protected borrower.
    /// @param policyId_ The bound {ComatoPolicy} id.
    /// @param feeRecipient_ The protocol fee recipient.
    /// @param feeBps_ The initial protocol fee in bps (`<= MAX_FEE_BPS`).
    /// @param whitelist_ Initial whitelisted call targets (seeded from the factory template).
    function initialize(
        address admin,
        address operator,
        address guardian,
        address subscriber_,
        uint256 policyId_,
        address feeRecipient_,
        uint16 feeBps_,
        address[] calldata whitelist_
    ) external initializer {
        if (admin == address(0) || subscriber_ == address(0) || feeRecipient_ == address(0)) {
            revert ZeroAddress();
        }
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh(feeBps_);

        factory = msg.sender;
        subscriber = subscriber_;
        policyId = policyId_;
        feeRecipient = feeRecipient_;
        feeBps = feeBps_;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        if (operator != address(0)) _grantRole(OPERATOR_ROLE, operator);
        if (guardian != address(0)) _grantRole(GUARDIAN_ROLE, guardian);

        uint256 len = whitelist_.length;
        for (uint256 i = 0; i < len; ++i) {
            address target = whitelist_[i];
            if (target == address(0)) revert ZeroAddress();
            if (_whitelist.add(target)) emit WhitelistUpdated(target, true);
        }

        emit GuardInitialized(msg.sender, subscriber_, policyId_, feeRecipient_, feeBps_);
    }

    /*//////////////////////////////////////////////////////////////
                          WHITELISTED EXECUTION
    //////////////////////////////////////////////////////////////*/

    /// @notice Executes a single arbitrary call to a whitelisted `target`. Operator-only.
    /// @dev Non-reentrant, pausable. Reverts {NotWhitelisted} for a non-whitelisted target and
    ///      bubbles the target's revert reason on failure.
    /// @param target The whitelisted contract to call.
    /// @param value Native value to forward.
    /// @param data ABI-encoded calldata.
    /// @return result The raw return data.
    function execute(address target, uint256 value, bytes calldata data)
        external
        onlyRole(OPERATOR_ROLE)
        whenNotPaused
        nonReentrant
        returns (bytes memory result)
    {
        result = _execute(target, value, data);
    }

    /// @notice Executes a batch of whitelisted calls atomically. Operator-only. If ANY target is
    ///         non-whitelisted or ANY call reverts, the whole batch reverts.
    /// @dev This is the deleverage path (e.g. withdraw collateral -> swap on router -> repay), kept
    ///      atomic. Non-reentrant, pausable.
    /// @param calls The calls to execute in order.
    /// @return results The raw return data for each call.
    function executeBatch(Call[] calldata calls)
        external
        onlyRole(OPERATOR_ROLE)
        whenNotPaused
        nonReentrant
        returns (bytes[] memory results)
    {
        uint256 len = calls.length;
        if (len == 0) revert EmptyBatch();
        results = new bytes[](len);
        for (uint256 i = 0; i < len; ++i) {
            results[i] = _execute(calls[i].target, calls[i].value, calls[i].data);
        }
    }

    /// @dev Whitelist check + low-level call + event. Shared by {execute} and {executeBatch}.
    function _execute(address target, uint256 value, bytes calldata data)
        private
        returns (bytes memory)
    {
        if (!_whitelist.contains(target)) revert NotWhitelisted(target);
        // A low-level call to a codeless address returns success while doing nothing (and would
        // strand any forwarded native value). Reject it so a mis-whitelisted EOA can't silent-no-op.
        if (target.code.length == 0) revert TargetHasNoCode(target);

        (bool ok, bytes memory ret) = target.call{value: value}(data);
        if (!ok) {
            // Bubble the original revert reason if present.
            if (ret.length > 0) {
                assembly {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
            revert CallFailed(target);
        }

        // Truncating `data` to its 4-byte selector for the event is intentional and length-guarded.
        // forge-lint: disable-next-line(unsafe-typecast)
        emit Executed(target, value, data.length >= 4 ? bytes4(data) : bytes4(0));
        return ret;
    }

    /*//////////////////////////////////////////////////////////////
                                 RESCUE
    //////////////////////////////////////////////////////////////*/

    /// @notice Rescues this guard's subscriber if their health factor is below the bound policy's
    ///         threshold, repaying up to `min(rescueCap, float-after-fee)` of the debt asset, then
    ///         charging the protocol fee.
    /// @dev Operator-only, pausable, non-reentrant, checks-effects-interactions.
    ///      Fee semantics: `feeAmount = amountRepaid * feeBps / 10_000` — a percentage of the debt
    ///      *repaid* (the principal moved), NOT of the liquidation penalty avoided; it is bounded by
    ///      `MAX_FEE_BPS` and flows to the admin-set `feeRecipient`. The fee is reserved from the
    ///      float FIRST (`repay + fee <= float` always), so it never fails for lack of balance.
    ///      SAFETY-CRITICALITY: the fee transfer is decoupled from the repay — if it reverts (e.g. a
    ///      blacklisted/paused `feeRecipient` on the USDC/USDT debt asset), the fee is SKIPPED (the
    ///      reserved amount simply stays as admin-recoverable float) rather than reverting the
    ///      life-saving repay. The rescue always restores HF regardless of `feeRecipient` state.
    /// @return amountRepaid The USDC/USDT amount repaid to Aave on the subscriber's behalf.
    /// @return feeAmount The protocol fee actually taken to `feeRecipient` (0 if the fee was skipped).
    function rescue()
        external
        onlyRole(OPERATOR_ROLE)
        whenNotPaused
        nonReentrant
        returns (uint256 amountRepaid, uint256 feeAmount)
    {
        // ---- Checks ----
        ComatoPolicy.Policy memory policy = POLICY_REGISTRY.getPolicy(policyId);
        if (!policy.active) revert PolicyNotActive();
        if (policy.subscriber != subscriber) revert SubscriberMismatch();

        (,,,,, uint256 hfBefore) = POOL.getUserAccountData(subscriber);
        if (hfBefore >= policy.hfThreshold) {
            revert HealthFactorNotBreached(hfBefore, policy.hfThreshold);
        }

        address debtAsset = policy.debtAsset;
        uint256 floatBalance = IERC20(debtAsset).balanceOf(address(this));
        if (floatBalance == 0) revert NoFloatAvailable();

        // Reserve the fee up front: cap the repay so that `repay + repay*feeBps/BPS <= float`.
        // NOTE on dust: `maxRepayAfterFee` floor-divides, so for a tiny float it can round to 0
        // (e.g. float=1, feeBps=1000 -> 0); that is caught by the `repayTarget == 0` fail-closed
        // revert below. For any float >= (BPS_DENOMINATOR + feeBps) the reserved repay is positive.
        uint256 _feeBps = feeBps;
        uint256 maxRepayAfterFee = (floatBalance * BPS_DENOMINATOR) / (BPS_DENOMINATOR + _feeBps);
        uint256 repayTarget =
            policy.rescueCap < maxRepayAfterFee ? policy.rescueCap : maxRepayAfterFee;
        if (repayTarget == 0) revert NoFloatAvailable();

        // ---- Interactions: repay (the safety-critical leg) ----
        IERC20(debtAsset).forceApprove(address(POOL), repayTarget);
        amountRepaid = POOL.repay(debtAsset, repayTarget, VARIABLE_RATE_MODE, subscriber);
        if (amountRepaid < repayTarget) {
            IERC20(debtAsset).forceApprove(address(POOL), 0);
        }

        // ---- Interactions: fee (decoupled — its failure must NEVER revert the repay above) ----
        // Bounded by construction to <= remaining float. Routed through an external self-call so a
        // blacklist/pause revert on `feeRecipient` is caught and the fee is skipped, not propagated.
        feeAmount = (amountRepaid * _feeBps) / BPS_DENOMINATOR;
        if (feeAmount > 0) {
            try this.pushFee(debtAsset, feeRecipient, feeAmount) {
                emit FeeCharged(feeRecipient, debtAsset, feeAmount);
            } catch {
                feeAmount = 0;
                emit FeeSkipped(feeRecipient, debtAsset);
            }
        }

        (,,,,, uint256 hfAfter) = POOL.getUserAccountData(subscriber);
        emit RescueExecuted(policyId, subscriber, debtAsset, amountRepaid, hfBefore, hfAfter);
    }

    /// @notice Transfers a rescue fee to `to`. Callable ONLY by the guard itself (`this.pushFee`),
    ///         wrapped in a try/catch by {rescue} so a fee-transfer revert cannot roll back the repay.
    /// @dev Not `nonReentrant`: it runs inside {rescue}'s transient guard and only moves the fee that
    ///      {rescue} already reserved from float. External actors are rejected by the self-call check.
    function pushFee(address asset, address to, uint256 amount) external {
        if (msg.sender != address(this)) revert OnlySelf();
        IERC20(asset).safeTransfer(to, amount);
    }

    /*//////////////////////////////////////////////////////////////
                           FLOAT MANAGEMENT
    //////////////////////////////////////////////////////////////*/

    /// @notice Deposits `amount` of `asset` as rescue float, pulled from `msg.sender`.
    /// @dev Permissionless funding; requires prior ERC-20 approval to this guard.
    function depositFloat(address asset, uint256 amount) external nonReentrant {
        if (asset == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        emit FloatDeposited(asset, msg.sender, amount);
    }

    /// @notice Withdraws `amount` of `asset` float to `to`. Admin only.
    function withdrawFloat(address asset, uint256 amount, address to)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        nonReentrant
    {
        if (asset == address(0) || to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        IERC20(asset).safeTransfer(to, amount);
        emit FloatWithdrawn(asset, to, amount);
    }

    /// @notice Sweeps any native balance (from `execute` `value` refunds) to `to`. Admin only.
    function sweepNative(address to) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 bal = address(this).balance;
        if (bal == 0) revert ZeroAmount();
        (bool ok,) = to.call{value: bal}("");
        if (!ok) revert CallFailed(to);
        emit NativeSwept(to, bal);
    }

    /// @notice Resets the guard's ERC-20 allowance for `spender` on `token` to zero. Admin only.
    /// @dev Containment for a compromised operator: `execute` can grant standing allowances on
    ///      whitelisted tokens (e.g. `USDC.approve(x, max)`) that survive `pause`, operator rotation,
    ///      and `withdrawFloat`. This lets the admin neutralize such an allowance DIRECTLY, without
    ///      having to self-grant `OPERATOR_ROLE` and route an approval-reset through `execute`.
    function revokeAllowance(address token, address spender) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == address(0) || spender == address(0)) revert ZeroAddress();
        IERC20(token).forceApprove(spender, 0);
        emit AllowanceRevoked(token, spender);
    }

    /*//////////////////////////////////////////////////////////////
                          WHITELIST ADMIN
    //////////////////////////////////////////////////////////////*/

    /// @notice Adds or removes a call target from the whitelist. Admin only.
    /// @param target The target to update.
    /// @param allowed True to whitelist, false to remove.
    function setWhitelist(address target, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (target == address(0)) revert ZeroAddress();
        bool changed = allowed ? _whitelist.add(target) : _whitelist.remove(target);
        if (changed) emit WhitelistUpdated(target, allowed);
    }

    /*//////////////////////////////////////////////////////////////
                             FEE ADMIN
    //////////////////////////////////////////////////////////////*/

    /// @notice Updates the protocol fee configuration. Admin only. `feeBps_` is hard-capped.
    /// @param feeRecipient_ The new fee recipient (non-zero).
    /// @param feeBps_ The new fee in bps (`<= MAX_FEE_BPS`).
    function setFeeConfig(address feeRecipient_, uint16 feeBps_)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (feeRecipient_ == address(0)) revert ZeroAddress();
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh(feeBps_);
        feeRecipient = feeRecipient_;
        feeBps = feeBps_;
        emit FeeConfigUpdated(feeRecipient_, feeBps_);
    }

    /*//////////////////////////////////////////////////////////////
                                PAUSE
    //////////////////////////////////////////////////////////////*/

    /// @notice Emergency-pauses the guard (halts `rescue` + `execute`/`executeBatch`). Guardian only.
    function pause() external onlyRole(GUARDIAN_ROLE) {
        _pause();
    }

    /// @notice Resumes the guard. Admin only (a guardian halts fast; the admin decides to resume).
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    /*//////////////////////////////////////////////////////////////
                              VIEW HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @notice Whether `target` is a whitelisted call target.
    function isWhitelisted(address target) external view returns (bool) {
        return _whitelist.contains(target);
    }

    /// @notice The full set of whitelisted call targets.
    function whitelistedTargets() external view returns (address[] memory) {
        return _whitelist.values();
    }

    /// @notice The number of whitelisted call targets.
    function whitelistLength() external view returns (uint256) {
        return _whitelist.length();
    }

    /// @notice Current float held by the guard in `asset`.
    function floatOf(address asset) external view returns (uint256) {
        return IERC20(asset).balanceOf(address(this));
    }

    /// @notice The subscriber's current health factor (WAD) from the Aave pool.
    function healthFactor() external view returns (uint256 hf) {
        (,,,,, hf) = POOL.getUserAccountData(subscriber);
    }

    /// @notice Accept native value (e.g. `execute` value refunds); sweepable by the admin.
    receive() external payable {}
}
