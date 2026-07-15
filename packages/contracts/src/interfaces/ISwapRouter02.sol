// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Minimal Uniswap V3 SwapRouter02 interface (Celo: 0x5615CDAb…abc4).
/// @dev Only the single-hop exact-input path Comato needs for deleverage swaps.
interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    /// @notice Swaps `amountIn` of `tokenIn` for as much `tokenOut` as possible.
    /// @return amountOut The amount of `tokenOut` received.
    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);
}
