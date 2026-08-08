// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {GridZoneArena} from "../src/GridZoneArena.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Drives the arena through random-but-legal sequences of actions
///         across several concurrent matches.
/// @dev The point is coverage of *orderings*, not of lines. Value conservation
///      is a property of the sequence, so the fuzzer needs freedom to interleave
///      joins, kills, self-kills, finalizations and escape hatches across
///      matches in any order (PRD §6).
contract ArenaHandler is Test {
    GridZoneArena public arena;
    MockUSDC public usdc;
    address public owner;

    bytes32[] public matchIdList;
    address[] public actors;

    constructor(GridZoneArena arena_, MockUSDC usdc_, address owner_) {
        arena = arena_;
        usdc = usdc_;
        owner = owner_;

        // A fixed actor set keeps the state space explorable.
        for (uint256 i = 0; i < 24; ++i) {
            address a = address(uint160(uint256(keccak256(abi.encode("actor", i)))));
            actors.push(a);
            usdc.mint(a, 1_000e6);
            vm.prank(a);
            usdc.approve(address(arena), type(uint256).max);
        }

        // Three concurrent matches, each with its own sharded relayer key.
        for (uint256 i = 0; i < 3; ++i) {
            bytes32 id = keccak256(abi.encode("match", i));
            matchIdList.push(id);
            vm.prank(owner);
            arena.openMatch(id, _relayerFor(id));
        }
    }

    function _relayerFor(bytes32 matchId) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encode("relayer", matchId)))));
    }

    function _match(uint256 seed) internal view returns (bytes32) {
        return matchIdList[seed % matchIdList.length];
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    // ------------------------------------------------------------------
    // Actions. Illegal ones revert and are discarded by the fuzzer
    // (fail_on_revert = false), which is what lets it probe boundaries.
    // ------------------------------------------------------------------

    function join(uint256 matchSeed, uint256 actorSeed) external {
        bytes32 id = _match(matchSeed);
        address a = _actor(actorSeed);
        vm.prank(a);
        arena.depositEntryFee(id);
    }

    function joinBot(uint256 matchSeed, uint256 botSeed) external {
        bytes32 id = _match(matchSeed);
        address relayer = _relayerFor(id);
        address bot = address(uint160(uint256(keccak256(abi.encode("bot", botSeed)))));

        usdc.mint(relayer, 10e6);
        vm.prank(relayer);
        usdc.approve(address(arena), type(uint256).max);
        vm.prank(relayer);
        arena.depositEntryFeeFor(id, bot);
    }

    function kill(uint256 matchSeed, uint256 killerSeed, uint256 victimSeed) external {
        bytes32 id = _match(matchSeed);
        address[] memory players = arena.getPlayers(id);
        if (players.length < 2) return;

        address killer = players[killerSeed % players.length];
        address victim = players[victimSeed % players.length];

        vm.prank(_relayerFor(id));
        arena.processKillReward(id, killer, victim);
    }

    function selfOrEnvDeath(uint256 matchSeed, uint256 victimSeed, bool selfInflicted) external {
        bytes32 id = _match(matchSeed);
        address[] memory players = arena.getPlayers(id);
        if (players.length == 0) return;

        address victim = players[victimSeed % players.length];
        vm.prank(_relayerFor(id));
        arena.processEnvironmentOrSelfDeath(id, victim, selfInflicted);
    }

    function killBatch(uint256 matchSeed, uint256 seed, uint256 count) external {
        bytes32 id = _match(matchSeed);
        address[] memory players = arena.getPlayers(id);
        if (players.length < 2) return;

        count = bound(count, 1, 4);
        address[] memory killers = new address[](count);
        address[] memory victims = new address[](count);

        for (uint256 i = 0; i < count; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            victims[i] = players[seed % players.length];
            killers[i] = (seed >> 8) % 4 == 0 ? address(0) : players[(seed >> 16) % players.length];
        }

        vm.prank(_relayerFor(id));
        arena.processKillBatch(id, killers, victims);
    }

    function finalize(uint256 matchSeed, uint256 winnerSeed) external {
        bytes32 id = _match(matchSeed);
        address[] memory players = arena.getPlayers(id);
        if (players.length == 0) return;

        address winner = players[winnerSeed % players.length];
        vm.prank(_relayerFor(id));
        arena.finalizeMatch(id, winner, keccak256(abi.encode("root", id)));
    }

    function emergencyWithdraw(uint256 matchSeed, uint256 actorSeed) external {
        bytes32 id = _match(matchSeed);
        address[] memory players = arena.getPlayers(id);
        if (players.length == 0) return;

        address p = players[actorSeed % players.length];
        vm.prank(p);
        arena.emergencyWithdraw(id);
    }

    function reclaimJackpot(uint256 matchSeed) external {
        vm.prank(owner);
        arena.reclaimAbandonedJackpot(_match(matchSeed));
    }

    /// @dev `bound` is resolved into a local before `vm.prank`. Passing it inline
    ///      as an argument lets its internal cheatcode calls consume the prank,
    ///      so the real call arrives from the handler instead of the owner and
    ///      reverts every time, silently disabling this action.
    function withdrawTreasury(uint256 amount) external {
        uint256 available = arena.treasuryUnclaimed();
        if (available == 0) return;
        uint256 amt = bound(amount, 1, available);
        vm.prank(owner);
        arena.withdrawTreasury(owner, amt);
    }

    function setHouseFee(uint256 bps) external {
        uint256 newBps = bound(bps, 0, arena.MAX_HOUSE_FEE_BPS());
        vm.prank(owner);
        arena.setHouseFeeBps(newBps);
    }

    /// @dev Lets the fuzzer cross the MATCH_TIMEOUT boundary so the escape
    ///      hatches are actually reachable instead of always reverting.
    function warp(uint256 seconds_) external {
        vm.warp(block.timestamp + bound(seconds_, 1, 2 hours));
    }
}

contract GridZoneArenaInvariantTest is StdInvariant, Test {
    GridZoneArena internal arena;
    MockUSDC internal usdc;
    ArenaHandler internal handler;

    address internal owner = makeAddr("owner");

    function setUp() public {
        usdc = new MockUSDC();
        arena = new GridZoneArena(IERC20(address(usdc)), owner);
        handler = new ArenaHandler(arena, usdc, owner);

        targetContract(address(handler));

        // Only the handler may act, so every call is a plausible game action.
        bytes4[] memory selectors = new bytes4[](11);
        selectors[0] = ArenaHandler.join.selector;
        selectors[1] = ArenaHandler.joinBot.selector;
        selectors[2] = ArenaHandler.kill.selector;
        selectors[3] = ArenaHandler.selfOrEnvDeath.selector;
        selectors[4] = ArenaHandler.killBatch.selector;
        selectors[5] = ArenaHandler.finalize.selector;
        selectors[6] = ArenaHandler.emergencyWithdraw.selector;
        selectors[7] = ArenaHandler.reclaimJackpot.selector;
        selectors[8] = ArenaHandler.withdrawTreasury.selector;
        selectors[9] = ArenaHandler.setHouseFee.selector;
        selectors[10] = ArenaHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @notice The core solvency property from PRD §4.1.
    /// @dev Every unit of USDC in the vault is accounted for by exactly one
    ///      claim: an outstanding player bounty, a match jackpot, or unclaimed
    ///      house fees. If this ever drifts, the arena is either insolvent or
    ///      quietly stranding player funds.
    function invariant_vaultIsExactlyBackedByLiabilities() public view {
        assertEq(
            usdc.balanceOf(address(arena)),
            arena.totalLiabilities(),
            "balanceOf(arena) == sum(bounty) + sum(jackpot) + treasuryUnclaimed"
        );
    }

    /// @notice No match may ever owe more than was paid into it.
    /// @dev Catches any bug that mints claims out of thin air, which the global
    ///      balance check alone could mask by netting across matches.
    function invariant_matchNeverOwesMoreThanItTookIn() public view {
        uint256 count = arena.matchCount();
        for (uint256 i = 0; i < count; ++i) {
            bytes32 id = arena.matchIds(i);
            GridZoneArena.MatchView memory m = arena.getMatch(id);
            assertLe(
                arena.totalBountyOf(id) + m.jackpotPool,
                m.totalDeposited,
                "per-match claims cannot exceed per-match deposits"
            );
        }
    }

    /// @notice A finalized match must hold no residual claim at all.
    /// @dev Finalization closes `emergencyWithdraw`, so any leftover bounty here
    ///      would be permanently unrecoverable.
    function invariant_finalizedMatchesAreFullySettled() public view {
        uint256 count = arena.matchCount();
        for (uint256 i = 0; i < count; ++i) {
            bytes32 id = arena.matchIds(i);
            GridZoneArena.MatchView memory m = arena.getMatch(id);
            if (m.finalized) {
                assertEq(m.jackpotPool, 0, "finalized match has no jackpot left");
                assertEq(arena.totalBountyOf(id), 0, "finalized match strands no bounty");
            }
        }
    }

    /// @notice The vault must never be able to under-pay its obligations.
    function invariant_vaultIsNeverInsolvent() public view {
        assertGe(usdc.balanceOf(address(arena)), arena.totalLiabilities(), "vault must cover all claims");
    }
}
