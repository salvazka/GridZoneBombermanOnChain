// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {GridZoneArena} from "../src/GridZoneArena.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Deploys the settlement token and the arena, then writes the
///         addresses to `deployments/<chainid>.json` for the game server.
/// @dev MockUSDC ships with a permissionless faucet on purpose (PRD §9.4) so
///      demo viewers can fund themselves. Never reuse this token off testnet.
contract DeployGridZone is Script {
    function run() external {
        uint256 deployerPk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPk);

        console.log("chain id :", block.chainid);
        console.log("deployer :", deployer);
        console.log("balance  :", deployer.balance);

        vm.startBroadcast(deployerPk);

        MockUSDC usdc = new MockUSDC();
        console.log("MockUSDC :", address(usdc));

        GridZoneArena arena = new GridZoneArena(IERC20(address(usdc)), deployer);
        console.log("Arena    :", address(arena));

        // Seed the deployer so the demo lobby and bot funding work immediately.
        usdc.mint(deployer, 100_000e6);

        vm.stopBroadcast();

        _writeDeployment(address(usdc), address(arena), deployer);
    }

    function _writeDeployment(address usdc, address arena, address deployer) private {
        string memory obj = "deployment";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeAddress(obj, "deployer", deployer);
        vm.serializeAddress(obj, "mockUsdc", usdc);
        string memory json = vm.serializeAddress(obj, "arena", arena);

        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
        console.log("written  :", path);
    }
}
