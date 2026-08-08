// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockUSDC
/// @notice 6-decimal test stablecoin with a public, rate-limited faucet.
/// @dev PRD §9.4 requires a public `mint()` so demo viewers/judges can
///      self-service test tokens without asking the team. A cooldown keeps a
///      single address from draining the faucet in a loop.
contract MockUSDC is ERC20 {
    /// @notice Max tokens a single caller can pull per faucet call (100 USDC).
    uint256 public constant FAUCET_AMOUNT = 100e6;

    /// @notice Minimum delay between faucet claims per address.
    uint256 public constant FAUCET_COOLDOWN = 30 seconds;

    /// @notice Hard cap per mint call, protects invariant tests from overflow.
    uint256 public constant MAX_MINT = 1_000_000e6;

    mapping(address => uint256) public lastFaucetClaim;

    error FaucetCooldownActive(uint256 availableAt);
    error MintAmountTooLarge(uint256 requested, uint256 max);

    event FaucetClaimed(address indexed to, uint256 amount);

    constructor() ERC20("Mock USD Coin", "USDC") {}

    /// @notice USDC uses 6 decimals, not the ERC20 default of 18.
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Open faucet used by the lobby "Get Test USDC" button.
    /// @dev Cooldown is per-recipient so a relayer cannot bypass it by rotating callers.
    function faucet(address to) external {
        uint256 availableAt = lastFaucetClaim[to] + FAUCET_COOLDOWN;
        if (lastFaucetClaim[to] != 0 && block.timestamp < availableAt) {
            revert FaucetCooldownActive(availableAt);
        }
        lastFaucetClaim[to] = block.timestamp;
        _mint(to, FAUCET_AMOUNT);
        emit FaucetClaimed(to, FAUCET_AMOUNT);
    }

    /// @notice Unrestricted mint for tests and demo bot funding.
    /// @dev Intentionally permissionless: this token has no value and exists
    ///      only on testnet. Capped per call to keep accounting sane.
    function mint(address to, uint256 amount) external {
        if (amount > MAX_MINT) revert MintAmountTooLarge(amount, MAX_MINT);
        _mint(to, amount);
    }
}
