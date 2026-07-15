// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ComatoVaultFactory} from "../src/ComatoVaultFactory.sol";
import {Script, console2} from "forge-std/Script.sol";

/// @notice Deploys the ComatoVaultFactory (Model C: non-custodial deleverage vaults) to Celo mainnet.
/// @dev Deployer (env `PRIVATE_KEY`, never logged) becomes the beacon-upgrade admin. Aave Pool +
///      Uniswap SwapRouter02 fixed to verified Celo addresses. The factory deploys the vault
///      implementation + an UpgradeableBeacon it owns. Run:
///        PRIVATE_KEY=<key> forge script script/DeployVault.s.sol:DeployVault --rpc-url celo            # simulate
///        PRIVATE_KEY=<key> forge script script/DeployVault.s.sol:DeployVault --rpc-url celo --broadcast # deploy
contract DeployVault is Script {
    address internal constant AAVE_V3_POOL = 0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402;
    address internal constant UNISWAP_SWAP_ROUTER_02 = 0x5615CDAb10dc425a742d643d949a7F474C01abc4;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address admin = vm.addr(pk);
        console2.log("deployer / admin:", admin);

        vm.startBroadcast(pk);
        ComatoVaultFactory factory =
            new ComatoVaultFactory(AAVE_V3_POOL, UNISWAP_SWAP_ROUTER_02, admin);
        vm.stopBroadcast();

        console2.log("ComatoVaultFactory:", address(factory));
        console2.log("vault implementation:", address(factory.implementation()));
        console2.log("beacon:", address(factory.beacon()));
    }
}
