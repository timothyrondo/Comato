// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ComatoVault} from "./ComatoVault.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {BeaconProxy} from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";

/// @title ComatoVaultFactory
/// @author Comato
/// @notice Deploys one {ComatoVault} BeaconProxy per subscriber over a single beacon this factory
///         owns. `createVault` is permissionless — the caller becomes the vault's `subscriber`
///         (owner) — so vaults stay non-custodial. `upgradeVaults` is the one privileged lever:
///         a `DEFAULT_ADMIN_ROLE` escape hatch that fixes a bug across every vault at once (the
///         reason vaults are upgradeable at all — see {ComatoVault} NatSpec).
contract ComatoVaultFactory is AccessControl {
    /// @notice The shared vault implementation (immutable global pool/router baked in).
    ComatoVault public immutable implementation;
    /// @notice The beacon every vault proxy points at; owned by this factory.
    UpgradeableBeacon public immutable beacon;

    /// @notice subscriber => their vault (one per subscriber).
    mapping(address subscriber => address vault) public vaultOf;
    /// @notice Every vault ever deployed.
    address[] public allVaults;
    /// @notice Quick membership test.
    mapping(address vault => bool) public isVault;

    event VaultCreated(address indexed subscriber, address indexed vault, address operator);
    event VaultsUpgraded(address indexed newImplementation);

    error ZeroAddress();
    error VaultExists();

    /// @param pool Aave V3 Pool. @param swapRouter Uniswap V3 SwapRouter02. @param admin Beacon-upgrade admin.
    constructor(address pool, address swapRouter, address admin) {
        if (pool == address(0) || swapRouter == address(0) || admin == address(0)) {
            revert ZeroAddress();
        }
        implementation = new ComatoVault(pool, swapRouter);
        beacon = new UpgradeableBeacon(address(implementation), address(this));
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice Deploy the caller's own non-custodial vault with their chosen terms.
    /// @dev `subscriber` is forced to `msg.sender` — nobody can create a vault owned by someone else.
    function createVault(
        address collateralAsset,
        address debtAsset,
        uint24 poolFee,
        address operator,
        address feeRecipient,
        uint256 feeBps,
        uint256 hfThreshold,
        uint256 targetHf
    ) external returns (address vault) {
        if (vaultOf[msg.sender] != address(0)) revert VaultExists();

        vault = address(
            new BeaconProxy(
                address(beacon),
                abi.encodeCall(
                    ComatoVault.initialize,
                    (
                        msg.sender,
                        collateralAsset,
                        debtAsset,
                        poolFee,
                        operator,
                        feeRecipient,
                        feeBps,
                        hfThreshold,
                        targetHf
                    )
                )
            )
        );

        vaultOf[msg.sender] = vault;
        isVault[vault] = true;
        allVaults.push(vault);
        emit VaultCreated(msg.sender, vault, operator);
    }

    /// @notice Upgrade the implementation for ALL vaults at once (bug-fix escape hatch). Admin only.
    function upgradeVaults(address newImplementation) external onlyRole(DEFAULT_ADMIN_ROLE) {
        beacon.upgradeTo(newImplementation);
        emit VaultsUpgraded(newImplementation);
    }

    /// @notice Number of vaults deployed.
    function vaultCount() external view returns (uint256) {
        return allVaults.length;
    }
}
