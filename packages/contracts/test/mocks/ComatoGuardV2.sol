// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ComatoGuard} from "../../src/ComatoGuard.sol";

/// @notice A trivial next-version guard implementation used only to prove the beacon upgrade path:
///         upgrading the beacon to this impl makes EVERY existing guard proxy expose `version()`
///         while preserving their storage (subscriber, whitelist, roles, float).
contract ComatoGuardV2 is ComatoGuard {
    constructor(address pool, address policyRegistry) ComatoGuard(pool, policyRegistry) {}

    /// @notice New logic added by the upgrade; visible on all proxies once the beacon is switched.
    function version() external pure returns (uint256) {
        return 2;
    }
}
