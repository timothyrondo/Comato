// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IAaveV3Pool} from "./interfaces/IAaveV3Pool.sol";
import {ISwapRouter02} from "./interfaces/ISwapRouter02.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

/// @title ComatoVault
/// @author Comato
/// @notice Non-custodial Aave V3 position manager (one per subscriber, behind a beacon proxy).
///
/// @dev THE MODEL. The SUBSCRIBER owns the position: they `supply` collateral, `borrow`, `repay`, and
///      `withdrawCollateral` at will, and can exit any time. The vault holds the Aave position (it is
///      the Aave account), so a rescue works on the subscriber's OWN funds — no Comato capital.
///
///      Comato's OPERATOR has exactly ONE power: `deleverage` — and only when the health factor is
///      below `hfThreshold`. It withdraws part of the subscriber's collateral, swaps it to the debt
///      asset, and repays the debt, lifting HF. It is bounded three ways: (1) HF must be breached,
///      (2) HF must strictly improve, (3) HF must not overshoot `targetHf` (so the operator can't
///      unwind the whole position and skim fees on all of it). Comato can NEVER move funds out to
///      itself; the only value it extracts is a fee capped at `MAX_FEE_BPS` on the swapped amount.
///      The subscriber can change or revoke the operator (`setOperator`) — fire Comato — any time.
///
/// @dev UPGRADEABILITY (hackathon trade-off, deliberate). Vaults are BeaconProxies over one beacon
///      the {ComatoVaultFactory} owns, so a single `upgrade` can fix a bug across every vault — the
///      escape hatch against funds getting stranded in a young contract. The cost: the beacon admin
///      (Comato) could upgrade to malicious code, so this is NOT fully trustless. Accepted for the
///      hackathon (small sums, Comato-operated wallets) where "stuck funds" is the realer risk than
///      a self-rug. A production build would put the upgrade behind a timelock or the subscriber's
///      own consent. Storage is append-only; `Initializable` (ERC-7201) + transient reentrancy guard
///      use collision-free slots, and per-vault state below occupies the leading proxy slots.
contract ComatoVault is Initializable, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                                CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Aave variable interest-rate mode (stable is disabled on Celo).
    uint256 public constant VARIABLE_RATE_MODE = 2;
    /// @notice Hard cap on the service fee: 10% of the value deleveraged.
    uint256 public constant MAX_FEE_BPS = 1000;
    uint256 internal constant BPS = 10_000;
    uint16 private constant REFERRAL = 0;

    /*//////////////////////////////////////////////////////////////
                               IMMUTABLES (impl)
    //////////////////////////////////////////////////////////////*/

    /// @notice Aave V3 Pool (global; immutable in the shared implementation).
    IAaveV3Pool public immutable POOL;
    /// @notice Uniswap V3 SwapRouter02 used for deleverage swaps (global; immutable).
    ISwapRouter02 public immutable SWAP_ROUTER;

    /*//////////////////////////////////////////////////////////////
                             PER-VAULT STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice The position owner. Only they move funds in/out.
    address public subscriber;
    /// @notice Collateral asset supplied to Aave.
    address public collateralAsset;
    /// @notice Borrowed (debt) asset a deleverage repays.
    address public debtAsset;
    /// @notice Uniswap V3 fee tier for the collateral -> debt swap.
    uint24 public poolFee;
    /// @notice Comato agent allowed to call `deleverage`. Subscriber can change/revoke.
    address public operator;
    /// @notice Where the service fee is sent.
    address public feeRecipient;
    /// @notice Service fee on the deleveraged amount (<= MAX_FEE_BPS).
    uint256 public feeBps;
    /// @notice WAD health factor strictly below which a deleverage may fire.
    uint256 public hfThreshold;
    /// @notice WAD ceiling a deleverage may raise HF to (bounds over-deleverage + fee skim).
    uint256 public targetHf;

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event VaultInitialized(address indexed subscriber, address collateralAsset, address debtAsset);
    event Supplied(uint256 amount);
    event Borrowed(uint256 amount);
    event Repaid(uint256 amount);
    event CollateralWithdrawn(uint256 amount, address indexed to);
    event Deleveraged(
        uint256 collateralWithdrawn,
        uint256 debtRepaid,
        uint256 fee,
        uint256 hfBefore,
        uint256 hfAfter
    );
    event OperatorChanged(address indexed operator);
    event TermsChanged(uint256 feeBps, uint256 hfThreshold, uint256 targetHf);

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error ZeroAddress();
    error ZeroAmount();
    error IdenticalAssets();
    error NotSubscriber();
    error NotOperator();
    error FeeTooHigh();
    error BadThresholds();
    error NotBreached(uint256 hf, uint256 threshold);
    error HfNotImproved(uint256 before, uint256 afterHf);
    error Overshoot(uint256 afterHf, uint256 target);

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR / INIT
    //////////////////////////////////////////////////////////////*/

    /// @param pool Aave V3 Pool. @param swapRouter Uniswap V3 SwapRouter02.
    constructor(address pool, address swapRouter) {
        if (pool == address(0) || swapRouter == address(0)) revert ZeroAddress();
        POOL = IAaveV3Pool(pool);
        SWAP_ROUTER = ISwapRouter02(swapRouter);
        _disableInitializers();
    }

    /// @notice One-time proxy setup with the subscriber's chosen terms.
    function initialize(
        address subscriber_,
        address collateralAsset_,
        address debtAsset_,
        uint24 poolFee_,
        address operator_,
        address feeRecipient_,
        uint256 feeBps_,
        uint256 hfThreshold_,
        uint256 targetHf_
    ) external initializer {
        if (subscriber_ == address(0) || collateralAsset_ == address(0) || debtAsset_ == address(0))
        {
            revert ZeroAddress();
        }
        if (collateralAsset_ == debtAsset_) revert IdenticalAssets();
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        // threshold must be below target (deleverage lifts HF from < threshold up toward target).
        if (hfThreshold_ == 0 || targetHf_ <= hfThreshold_) revert BadThresholds();

        subscriber = subscriber_;
        collateralAsset = collateralAsset_;
        debtAsset = debtAsset_;
        poolFee = poolFee_;
        operator = operator_;
        feeRecipient = feeRecipient_;
        feeBps = feeBps_;
        hfThreshold = hfThreshold_;
        targetHf = targetHf_;
        emit VaultInitialized(subscriber_, collateralAsset_, debtAsset_);
    }

    modifier onlySubscriber() {
        if (msg.sender != subscriber) revert NotSubscriber();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    /*//////////////////////////////////////////////////////////////
                     SUBSCRIBER — full position control
    //////////////////////////////////////////////////////////////*/

    /// @notice Pull `amount` collateral from the subscriber and supply it to Aave (vault is the account).
    function supply(uint256 amount) external onlySubscriber nonReentrant {
        if (amount == 0) revert ZeroAmount();
        IERC20(collateralAsset).safeTransferFrom(msg.sender, address(this), amount);
        IERC20(collateralAsset).forceApprove(address(POOL), amount);
        POOL.supply(collateralAsset, amount, address(this), REFERRAL);
        emit Supplied(amount);
    }

    /// @notice Borrow `amount` of the debt asset against the vault's collateral, sent to the subscriber.
    function borrow(uint256 amount) external onlySubscriber nonReentrant {
        if (amount == 0) revert ZeroAmount();
        POOL.borrow(debtAsset, amount, VARIABLE_RATE_MODE, REFERRAL, address(this));
        IERC20(debtAsset).safeTransfer(subscriber, amount);
        emit Borrowed(amount);
    }

    /// @notice Repay `amount` of the vault's debt, pulled from the subscriber.
    function repay(uint256 amount) external onlySubscriber nonReentrant {
        if (amount == 0) revert ZeroAmount();
        IERC20(debtAsset).safeTransferFrom(msg.sender, address(this), amount);
        IERC20(debtAsset).forceApprove(address(POOL), amount);
        uint256 repaid = POOL.repay(debtAsset, amount, VARIABLE_RATE_MODE, address(this));
        // Return any dust Aave did not pull (debt was smaller than `amount`).
        if (repaid < amount) IERC20(debtAsset).safeTransfer(subscriber, amount - repaid);
        emit Repaid(repaid);
    }

    /// @notice Withdraw `amount` collateral to `to`. Aave reverts if it would breach HF, so the
    ///         subscriber can always pull whatever their position can safely give back — Comato has
    ///         no say here. This is what makes the vault non-custodial.
    function withdrawCollateral(uint256 amount, address to) external onlySubscriber nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();
        uint256 got = POOL.withdraw(collateralAsset, amount, to);
        emit CollateralWithdrawn(got, to);
    }

    /// @notice Change or revoke the Comato operator (set to zero to fire Comato entirely).
    function setOperator(address newOperator) external onlySubscriber {
        operator = newOperator;
        emit OperatorChanged(newOperator);
    }

    /// @notice Adjust service terms. `feeBps` is still hard-capped at `MAX_FEE_BPS`.
    function setTerms(uint256 feeBps_, uint256 hfThreshold_, uint256 targetHf_)
        external
        onlySubscriber
    {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        if (hfThreshold_ == 0 || targetHf_ <= hfThreshold_) revert BadThresholds();
        feeBps = feeBps_;
        hfThreshold = hfThreshold_;
        targetHf = targetHf_;
        emit TermsChanged(feeBps_, hfThreshold_, targetHf_);
    }

    /*//////////////////////////////////////////////////////////////
                   OPERATOR — deleverage only, bounded
    //////////////////////////////////////////////////////////////*/

    /// @notice Deleverage the subscriber's OWN position to lift HF: withdraw `collateralIn` collateral,
    ///         swap it to the debt asset (min `minDebtOut`), and repay the debt. Fee is skimmed from
    ///         the swap output. Callable only by the operator, only while HF < `hfThreshold`, and it
    ///         must improve HF without overshooting `targetHf`.
    /// @param collateralIn Collateral units to withdraw and swap.
    /// @param minDebtOut Minimum debt-asset out from the swap (slippage guard; caller computes it).
    /// @return repaid Debt actually repaid to Aave.
    function deleverage(uint256 collateralIn, uint256 minDebtOut)
        external
        onlyOperator
        nonReentrant
        returns (uint256 repaid)
    {
        if (collateralIn == 0) revert ZeroAmount();
        (,,,,, uint256 hfBefore) = POOL.getUserAccountData(address(this));
        if (hfBefore >= hfThreshold) revert NotBreached(hfBefore, hfThreshold);

        // 1. Withdraw the subscriber's collateral (the vault holds the aTokens).
        uint256 got = POOL.withdraw(collateralAsset, collateralIn, address(this));

        // 2. Swap collateral -> debt asset on Uniswap V3.
        IERC20(collateralAsset).forceApprove(address(SWAP_ROUTER), got);
        uint256 out = SWAP_ROUTER.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: collateralAsset,
                tokenOut: debtAsset,
                fee: poolFee,
                recipient: address(this),
                amountIn: got,
                amountOutMinimum: minDebtOut,
                sqrtPriceLimitX96: 0
            })
        );

        // 3. Skim the capped service fee; repay the rest onto the subscriber's own debt.
        uint256 fee = (out * feeBps) / BPS;
        uint256 toRepay = out - fee;
        IERC20(debtAsset).forceApprove(address(POOL), toRepay);
        repaid = POOL.repay(debtAsset, toRepay, VARIABLE_RATE_MODE, address(this));
        if (repaid < toRepay) IERC20(debtAsset).safeTransfer(subscriber, toRepay - repaid);
        if (fee > 0) IERC20(debtAsset).safeTransfer(feeRecipient, fee);

        // 4. Bound the action: HF must improve and must not overshoot the target (no full unwind).
        (,,,,, uint256 hfAfter) = POOL.getUserAccountData(address(this));
        if (hfAfter <= hfBefore) revert HfNotImproved(hfBefore, hfAfter);
        if (hfAfter > targetHf) revert Overshoot(hfAfter, targetHf);

        emit Deleveraged(got, repaid, fee, hfBefore, hfAfter);
    }

    /*//////////////////////////////////////////////////////////////
                              VIEW HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @notice The vault position's current health factor (WAD).
    function healthFactor() external view returns (uint256 hf) {
        (,,,,, hf) = POOL.getUserAccountData(address(this));
    }

    /// @notice Aggregate position data (collateral, debt, HF) in Aave base units.
    function position()
        external
        view
        returns (uint256 collateralBase, uint256 debtBase, uint256 hf)
    {
        (collateralBase, debtBase,,,, hf) = POOL.getUserAccountData(address(this));
    }
}
