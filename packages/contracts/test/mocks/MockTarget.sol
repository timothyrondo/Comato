// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Minimal call target for exercising the guard's whitelist-gated `execute`/`executeBatch`.
/// @dev Records the last call and can be told to revert, so tests can assert both success and
///      bubbled-revert behaviour without moving any tokens (keeps float-conservation invariants clean).
contract MockTarget {
    uint256 public callCount;
    uint256 public lastNum;
    uint256 public lastValue;
    address public lastCaller;
    bool public shouldRevert;

    error ForcedRevert();

    event Pinged(address indexed caller, uint256 value, uint256 num);

    function setShouldRevert(bool v) external {
        shouldRevert = v;
    }

    /// @notice Records the call and returns `num * 2`. Reverts if armed.
    function ping(uint256 num) external payable returns (uint256) {
        if (shouldRevert) revert ForcedRevert();
        callCount++;
        lastNum = num;
        lastValue = msg.value;
        lastCaller = msg.sender;
        emit Pinged(msg.sender, msg.value, num);
        return num * 2;
    }
}
