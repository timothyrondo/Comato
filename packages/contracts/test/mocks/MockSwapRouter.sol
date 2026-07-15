// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ISwapRouter02} from "../../src/interfaces/ISwapRouter02.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Deterministic Uniswap V3 SwapRouter02 stand-in for unit tests.
/// @dev Pulls `amountIn` of `tokenIn` from the caller (mirroring the real router's `transferFrom`
///      after the caller approves it) and pays out a CONFIGURABLE `amountOut` of `tokenOut`. It
///      enforces the `amountOutMinimum` slippage guard exactly like the live router (reverts
///      `TooLittleReceived`), so tests can drive the {ComatoVault} deleverage bounds — a big
///      `amountOut` overshoots the target, a zero `amountOut` fails to improve HF — without a fork.
///      Must be pre-funded with `tokenOut` to settle the swap.
contract MockSwapRouter is ISwapRouter02 {
    /// @notice The `tokenOut` amount the next swap will return (set per test).
    uint256 public amountOut;

    error TooLittleReceived();

    /// @notice Test helper: fix the `tokenOut` amount the next `exactInputSingle` pays out.
    function setAmountOut(uint256 amountOut_) external {
        amountOut = amountOut_;
    }

    /// @inheritdoc ISwapRouter02
    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256)
    {
        // Pull the input exactly like the real router (caller approved us first).
        IERC20(params.tokenIn).transferFrom(msg.sender, address(this), params.amountIn);
        if (amountOut < params.amountOutMinimum) revert TooLittleReceived();
        IERC20(params.tokenOut).transfer(params.recipient, amountOut);
        return amountOut;
    }
}
