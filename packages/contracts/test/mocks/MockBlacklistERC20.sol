// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice ERC-20 that can blacklist addresses and revert transfers to/from them — models Celo
///         USDC's issuer freeze/blacklist, used to prove the guard's rescue survives a
///         fee-recipient blacklist (the fee is skipped, the repay still lands).
contract MockBlacklistERC20 is ERC20 {
    uint8 private immutable _DECIMALS;

    mapping(address account => bool) public blacklisted;

    error AccountBlacklisted(address account);

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _DECIMALS = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _DECIMALS;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlacklisted(address account, bool value) external {
        blacklisted[account] = value;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (blacklisted[from]) revert AccountBlacklisted(from);
        if (blacklisted[to]) revert AccountBlacklisted(to);
        super._update(from, to, value);
    }
}
