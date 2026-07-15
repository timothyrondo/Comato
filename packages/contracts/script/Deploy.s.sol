// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ComatoExecutor} from "../src/ComatoExecutor.sol";
import {ComatoPolicy} from "../src/ComatoPolicy.sol";
import {Script, console2} from "forge-std/Script.sol";

/// @notice Deploys the Comato policy registry + reference executor to Celo mainnet.
/// @dev The deployer (read from the `PRIVATE_KEY` env var, never logged) is granted
///      `DEFAULT_ADMIN_ROLE` on both contracts. Aave V3 Pool is fixed to the verified
///      Celo mainnet address. Run:
///        PRIVATE_KEY=<key> forge script script/Deploy.s.sol:Deploy --rpc-url celo            # simulate
///        PRIVATE_KEY=<key> forge script script/Deploy.s.sol:Deploy --rpc-url celo --broadcast # deploy
contract Deploy is Script {
    /// @dev Verified Aave V3 Pool on Celo mainnet (chain 42220) — see packages/shared/addresses.ts.
    address internal constant AAVE_V3_POOL = 0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address admin = vm.addr(pk);
        console2.log("deployer / admin:", admin);
        console2.log("aave pool:", AAVE_V3_POOL);

        vm.startBroadcast(pk);
        ComatoPolicy policy = new ComatoPolicy(admin);
        ComatoExecutor executor = new ComatoExecutor(AAVE_V3_POOL, address(policy), admin);
        vm.stopBroadcast();

        console2.log("ComatoPolicy:", address(policy));
        console2.log("ComatoExecutor:", address(executor));
    }
}
