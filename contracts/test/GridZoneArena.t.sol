// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {GridZoneArena} from "../src/GridZoneArena.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract GridZoneArenaTest is Test {
    GridZoneArena internal arena;
    MockUSDC internal usdc;

    address internal owner = makeAddr("owner");
    address internal relayerA = makeAddr("relayerA");
    address internal relayerB = makeAddr("relayerB");
    address internal outsider = makeAddr("outsider");

    bytes32 internal constant MATCH_A = keccak256("match-a");
    bytes32 internal constant MATCH_B = keccak256("match-b");
    bytes32 internal constant LOG_ROOT = keccak256("log-root");

    uint256 internal constant ENTRY = 1e6;
    uint256 internal constant BOUNTY = 0.8e6;
    uint256 internal constant KILL_REWARD = 0.64e6;
    uint256 internal constant KILL_TO_JACKPOT = 0.16e6;
    uint256 internal constant JOIN_TO_JACKPOT = 0.2e6;

    function setUp() public {
        usdc = new MockUSDC();
        arena = new GridZoneArena(IERC20(address(usdc)), owner);

        vm.prank(owner);
        arena.openMatch(MATCH_A, relayerA);
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    function _player(uint256 i) internal returns (address p) {
        p = makeAddr(string.concat("player", vm.toString(i)));
        usdc.mint(p, 100e6);
        vm.prank(p);
        usdc.approve(address(arena), type(uint256).max);
    }

    function _join(bytes32 matchId, address p) internal {
        vm.prank(p);
        arena.depositEntryFee(matchId);
    }

    /// @dev Fills a lobby with `n` players and returns them.
    function _fill(bytes32 matchId, uint256 n) internal returns (address[] memory players) {
        players = new address[](n);
        for (uint256 i = 0; i < n; ++i) {
            players[i] = _player(i);
            _join(matchId, players[i]);
        }
    }

    /// @dev The solvency property from PRD §4.1, asserted directly.
    function _assertSolvent() internal view {
        assertEq(
            usdc.balanceOf(address(arena)),
            arena.totalLiabilities(),
            "vault balance must equal bounties + jackpots + treasury"
        );
    }

    // ------------------------------------------------------------------
    // Deposit
    // ------------------------------------------------------------------

    function test_deposit_splitsEightyTwenty() public {
        address p = _player(1);
        _join(MATCH_A, p);

        assertEq(arena.bountyOf(MATCH_A, p), BOUNTY, "bounty is 80% of entry");

        GridZoneArena.MatchView memory m = arena.getMatch(MATCH_A);
        assertEq(m.jackpotPool, JOIN_TO_JACKPOT, "remaining 20% seeds the jackpot");
        assertEq(m.totalDeposited, ENTRY);
        assertEq(m.playerCount, 1);
        assertEq(usdc.balanceOf(address(arena)), ENTRY);
        _assertSolvent();
    }

    function test_deposit_revertsOnDoubleJoin() public {
        address p = _player(1);
        _join(MATCH_A, p);

        vm.expectRevert(abi.encodeWithSelector(GridZoneArena.AlreadyJoined.selector, MATCH_A, p));
        vm.prank(p);
        arena.depositEntryFee(MATCH_A);
    }

    function test_deposit_revertsWhenLobbyFull() public {
        _fill(MATCH_A, 16);

        address extra = _player(999);
        vm.expectRevert(abi.encodeWithSelector(GridZoneArena.LobbyFull.selector, MATCH_A));
        vm.prank(extra);
        arena.depositEntryFee(MATCH_A);
    }

    function test_deposit_revertsOnUnknownMatch() public {
        address p = _player(1);
        vm.expectRevert(abi.encodeWithSelector(GridZoneArena.MatchNotActive.selector, MATCH_B));
        vm.prank(p);
        arena.depositEntryFee(MATCH_B);
    }

    /// @dev PRD §9.3: bots must hold real bounty or the demo breaks the invariant.
    function test_depositFor_seatsBotFundedByRelayer() public {
        address bot = makeAddr("bot");
        usdc.mint(relayerA, 10e6);
        vm.prank(relayerA);
        usdc.approve(address(arena), type(uint256).max);

        vm.prank(relayerA);
        arena.depositEntryFeeFor(MATCH_A, bot);

        assertEq(arena.bountyOf(MATCH_A, bot), BOUNTY);
        assertTrue(arena.isPlayer(MATCH_A, bot));
        assertEq(usdc.balanceOf(relayerA), 10e6 - ENTRY, "relayer funded the bot seat");
        _assertSolvent();
    }

    function test_depositFor_revertsForNonRelayer() public {
        address bot = makeAddr("bot");
        vm.expectRevert(abi.encodeWithSelector(GridZoneArena.NotAssignedRelayer.selector, MATCH_A, outsider));
        vm.prank(outsider);
        arena.depositEntryFeeFor(MATCH_A, bot);
    }

    // ------------------------------------------------------------------
    // PvP kill
    // ------------------------------------------------------------------

    function test_kill_paysKillerInstantlyAndFeedsJackpot() public {
        address[] memory p = _fill(MATCH_A, 2);
        uint256 killerBalanceBefore = usdc.balanceOf(p[0]);

        vm.prank(relayerA);
        arena.processKillReward(MATCH_A, p[0], p[1]);

        assertEq(usdc.balanceOf(p[0]) - killerBalanceBefore, KILL_REWARD, "80% lands in the killer's wallet");
        assertEq(arena.bountyOf(MATCH_A, p[1]), 0, "victim bounty is zeroed");
        assertEq(arena.bountyOf(MATCH_A, p[0]), BOUNTY, "killer's own head bounty is untouched");

        GridZoneArena.MatchView memory m = arena.getMatch(MATCH_A);
        assertEq(m.jackpotPool, 2 * JOIN_TO_JACKPOT + KILL_TO_JACKPOT);
        _assertSolvent();
    }

    /// @dev PRD §3.3: self-kill has no beneficiary, so it must not be routable
    ///      through the PvP path even if the relayer submits it that way.
    function test_kill_revertsWhenKillerIsVictim() public {
        address[] memory p = _fill(MATCH_A, 2);

        vm.expectRevert(abi.encodeWithSelector(GridZoneArena.SelfKillNotAllowedHere.selector, p[0]));
        vm.prank(relayerA);
        arena.processKillReward(MATCH_A, p[0], p[0]);
    }

    function test_kill_revertsOnZeroKiller() public {
        address[] memory p = _fill(MATCH_A, 2);

        vm.expectRevert(GridZoneArena.ZeroAddress.selector);
        vm.prank(relayerA);
        arena.processKillReward(MATCH_A, address(0), p[1]);
    }

    function test_kill_revertsForWrongRelayer() public {
        address[] memory p = _fill(MATCH_A, 2);

        vm.expectRevert(abi.encodeWithSelector(GridZoneArena.NotAssignedRelayer.selector, MATCH_A, relayerB));
        vm.prank(relayerB);
        arena.processKillReward(MATCH_A, p[0], p[1]);
    }

    function test_kill_revertsOnAlreadyDeadVictim() public {
        address[] memory p = _fill(MATCH_A, 3);

        vm.prank(relayerA);
        arena.processKillReward(MATCH_A, p[0], p[1]);

        vm.expectRevert(abi.encodeWithSelector(GridZoneArena.NoBountyRemaining.selector, MATCH_A, p[1]));
        vm.prank(relayerA);
        arena.processKillReward(MATCH_A, p[2], p[1]);
    }

    function test_kill_revertsOnNonPlayer() public {
        address[] memory p = _fill(MATCH_A, 2);

        vm.expectRevert(abi.encodeWithSelector(GridZoneArena.NotAPlayer.selector, MATCH_A, outsider));
        vm.prank(relayerA);
        arena.processKillReward(MATCH_A, outsider, p[1]);
    }

    // ------------------------------------------------------------------
    // Self-kill and environment death
    // ------------------------------------------------------------------

    function test_selfKill_sendsWholeBountyToJackpot() public {
        address[] memory p = _fill(MATCH_A, 2);

        vm.prank(relayerA);
        arena.processEnvironmentOrSelfDeath(MATCH_A, p[0], true);

        assertEq(arena.bountyOf(MATCH_A, p[0]), 0);
        GridZoneArena.MatchView memory m = arena.getMatch(MATCH_A);
        assertEq(m.jackpotPool, 2 * JOIN_TO_JACKPOT + BOUNTY, "100% of bounty, no killer cut");
        _assertSolvent();
    }

    function test_environmentDeath_sendsWholeBountyToJackpot() public {
        address[] memory p = _fill(MATCH_A, 2);

        vm.prank(relayerA);
        arena.processEnvironmentOrSelfDeath(MATCH_A, p[1], false);

        GridZoneArena.MatchView memory m = arena.getMatch(MATCH_A);
        assertEq(m.jackpotPool, 2 * JOIN_TO_JACKPOT + BOUNTY);
        _assertSolvent();
    }

    function test_environmentDeath_movesNoTokens() public {
        address[] memory p = _fill(MATCH_A, 2);
        uint256 vaultBefore = usdc.balanceOf(address(arena));

        vm.prank(relayerA);
        arena.processEnvironmentOrSelfDeath(MATCH_A, p[0], false);

        assertEq(usdc.balanceOf(address(arena)), vaultBefore, "value only moves between buckets");
    }

    // ------------------------------------------------------------------
    // Batch settlement
    // ------------------------------------------------------------------

    function test_batch_mixesPvpAndNoBeneficiaryDeaths() public {
        address[] memory p = _fill(MATCH_A, 4);

        address[] memory killers = new address[](3);
        address[] memory victims = new address[](3);
        // p0 kills p1; p2 blows itself up; p3 caught by the red zone.
        killers[0] = p[0];
        victims[0] = p[1];
        killers[1] = p[2];
        victims[1] = p[2];
        killers[2] = address(0);
        victims[2] = p[3];

        uint256 killerBefore = usdc.balanceOf(p[0]);

        vm.prank(relayerA);
        arena.processKillBatch(MATCH_A, killers, victims);

        assertEq(usdc.balanceOf(p[0]) - killerBefore, KILL_REWARD);
        assertEq(arena.bountyOf(MATCH_A, p[1]), 0);
        assertEq(arena.bountyOf(MATCH_A, p[2]), 0);
        assertEq(arena.bountyOf(MATCH_A, p[3]), 0);

        GridZoneArena.MatchView memory m = arena.getMatch(MATCH_A);
        // 4 joins + 20% of p1 + 100% of p2 + 100% of p3
        assertEq(m.jackpotPool, 4 * JOIN_TO_JACKPOT + KILL_TO_JACKPOT + BOUNTY + BOUNTY);
        _assertSolvent();
    }

    function test_batch_revertsOnLengthMismatch() public {
        _fill(MATCH_A, 2);
        address[] memory killers = new address[](2);
        address[] memory victims = new address[](1);

        vm.expectRevert(bytes("length mismatch"));
        vm.prank(relayerA);
        arena.processKillBatch(MATCH_A, killers, victims);
    }

    // ------------------------------------------------------------------
    // Finalization — the headline PRD §4.1 scenario
    // ------------------------------------------------------------------

    /// @notice Reproduces the exact worked example in PRD §4.1 and checks every
    ///         figure quoted there: $9.60 distributed, $5.60 final jackpot,
    ///         $0.80 winner remainder, nothing left in the vault.
    function test_fullMatch_matchesPrdValueConservation() public {
        address[] memory p = _fill(MATCH_A, 16);
        address winner = p[0];

        assertEq(usdc.balanceOf(address(arena)), 16e6, "$16.00 in");

        uint256 winnerBalanceBefore = usdc.balanceOf(winner);

        // The winner eliminates all 15 opponents.
        for (uint256 i = 1; i < 16; ++i) {
            vm.prank(relayerA);
            arena.processKillReward(MATCH_A, winner, p[i]);
            _assertSolvent();
        }

        assertEq(usdc.balanceOf(winner) - winnerBalanceBefore, 9.6e6, "$9.60 distributed via PvP");

        GridZoneArena.MatchView memory m = arena.getMatch(MATCH_A);
        assertEq(m.jackpotPool, 5.6e6, "$3.20 from joins + $2.40 from kills");
        assertEq(arena.bountyOf(MATCH_A, winner), 0.8e6, "winner's own bounty still undistributed");
        assertEq(usdc.balanceOf(address(arena)), 6.4e6);

        vm.prank(relayerA);
        arena.finalizeMatch(MATCH_A, winner, LOG_ROOT);

        // Jackpot plus the winner's own bounty: the v1 dust bug is gone.
        assertEq(usdc.balanceOf(winner) - winnerBalanceBefore, 16e6, "sole killer takes the whole pot");
        assertEq(usdc.balanceOf(address(arena)), 0, "vault fully drained");
        assertEq(arena.totalLiabilities(), 0);
        assertEq(arena.matchLogRoot(MATCH_A), LOG_ROOT, "audit root committed");

        m = arena.getMatch(MATCH_A);
        assertTrue(m.finalized);
        assertFalse(m.active);
    }

    function test_finalize_sweepsBountyOfStillLivingPlayers() public {
        address[] memory p = _fill(MATCH_A, 4);

        // Relayer finalizes early: p1..p3 are still alive and hold bounty.
        vm.prank(relayerA);
        arena.finalizeMatch(MATCH_A, p[0], LOG_ROOT);

        // Nothing may be stranded, because finalization closes emergencyWithdraw.
        assertEq(usdc.balanceOf(address(arena)), 0, "no value left behind");
        assertEq(arena.totalLiabilities(), 0);
        assertEq(usdc.balanceOf(p[0]), 100e6 - ENTRY + 4 * ENTRY);
    }

    function test_finalize_revertsTwice() public {
        address[] memory p = _fill(MATCH_A, 2);

        vm.prank(relayerA);
        arena.finalizeMatch(MATCH_A, p[0], LOG_ROOT);

        vm.expectRevert(abi.encodeWithSelector(GridZoneArena.MatchAlreadyFinalized.selector, MATCH_A));
        vm.prank(relayerA);
        arena.finalizeMatch(MATCH_A, p[0], LOG_ROOT);
    }

    function test_finalize_revertsForNonPlayerWinner() public {
        _fill(MATCH_A, 2);

        vm.expectRevert(abi.encodeWithSelector(GridZoneArena.NotAPlayer.selector, MATCH_A, outsider));
        vm.prank(relayerA);
        arena.finalizeMatch(MATCH_A, outsider, LOG_ROOT);
    }

    function test_settlement_revertsAfterFinalize() public {
        address[] memory p = _fill(MATCH_A, 3);

        vm.prank(relayerA);
        arena.finalizeMatch(MATCH_A, p[0], LOG_ROOT);

        vm.expectRevert(abi.encodeWithSelector(GridZoneArena.MatchAlreadyFinalized.selector, MATCH_A));
        vm.prank(relayerA);
        arena.processKillReward(MATCH_A, p[0], p[1]);
    }

    // ------------------------------------------------------------------
    // Escape hatches
    // ------------------------------------------------------------------

    function test_emergencyWithdraw_afterTimeout() public {
        address[] memory p = _fill(MATCH_A, 2);
        uint256 before = usdc.balanceOf(p[0]);

        vm.warp(block.timestamp + 1 hours + 1);

        vm.prank(p[0]);
        arena.emergencyWithdraw(MATCH_A);

        assertEq(usdc.balanceOf(p[0]) - before, BOUNTY, "player recovers their own bounty");
        assertEq(arena.bountyOf(MATCH_A, p[0]), 0);
        _assertSolvent();
    }

    function test_emergencyWithdraw_revertsBeforeTimeout() public {
        address[] memory p = _fill(MATCH_A, 2);

        vm.expectRevert(
            abi.encodeWithSelector(
                GridZoneArena.TimeoutNotReached.selector, MATCH_A, arena.getMatch(MATCH_A).startTime + 1 hours
            )
        );
        vm.prank(p[0]);
        arena.emergencyWithdraw(MATCH_A);
    }

    function test_emergencyWithdraw_cannotTakeAnotherPlayersBounty() public {
        _fill(MATCH_A, 2);
        vm.warp(block.timestamp + 1 hours + 1);

        vm.expectRevert(abi.encodeWithSelector(GridZoneArena.NotAPlayer.selector, MATCH_A, outsider));
        vm.prank(outsider);
        arena.emergencyWithdraw(MATCH_A);
    }

    function test_emergencyWithdraw_revertsAfterFinalize() public {
        address[] memory p = _fill(MATCH_A, 2);
        vm.prank(relayerA);
        arena.finalizeMatch(MATCH_A, p[0], LOG_ROOT);

        vm.warp(block.timestamp + 1 hours + 1);
        vm.expectRevert(abi.encodeWithSelector(GridZoneArena.MatchAlreadyFinalized.selector, MATCH_A));
        vm.prank(p[1]);
        arena.emergencyWithdraw(MATCH_A);
    }

    function test_reclaimAbandonedJackpot_thenPlayersStillRecoverBounty() public {
        address[] memory p = _fill(MATCH_A, 3);
        vm.warp(block.timestamp + 1 hours + 1);

        vm.prank(owner);
        arena.reclaimAbandonedJackpot(MATCH_A);

        assertEq(arena.treasuryUnclaimed(), 3 * JOIN_TO_JACKPOT);
        _assertSolvent();

        // Bounties remain recoverable by their owners.
        vm.prank(p[0]);
        arena.emergencyWithdraw(MATCH_A);
        assertEq(arena.bountyOf(MATCH_A, p[0]), 0);
        _assertSolvent();
    }

    // ------------------------------------------------------------------
    // Parallelism precondition: matches must not share state
    // ------------------------------------------------------------------

    /// @dev The storage-isolation claim behind PRD §5.2. If any of these
    ///      assertions could fail, the parallel-execution pitch would be false.
    function test_matchesAreFullyIsolated() public {
        vm.prank(owner);
        arena.openMatch(MATCH_B, relayerB);

        address[] memory a = _fill(MATCH_A, 2);

        address b0 = makeAddr("b0");
        address b1 = makeAddr("b1");
        for (uint256 i = 0; i < 2; ++i) {
            address x = i == 0 ? b0 : b1;
            usdc.mint(x, 10e6);
            vm.prank(x);
            usdc.approve(address(arena), type(uint256).max);
            vm.prank(x);
            arena.depositEntryFee(MATCH_B);
        }

        vm.prank(relayerA);
        arena.processKillReward(MATCH_A, a[0], a[1]);

        // Match B is untouched by activity in match A.
        GridZoneArena.MatchView memory mb = arena.getMatch(MATCH_B);
        assertEq(mb.jackpotPool, 2 * JOIN_TO_JACKPOT, "B's jackpot unaffected by A's kill");
        assertEq(arena.bountyOf(MATCH_B, b0), BOUNTY);
        assertEq(arena.bountyOf(MATCH_B, b1), BOUNTY);

        // A relayer is scoped to its own match.
        vm.expectRevert(abi.encodeWithSelector(GridZoneArena.NotAssignedRelayer.selector, MATCH_B, relayerA));
        vm.prank(relayerA);
        arena.processKillReward(MATCH_B, b0, b1);

        _assertSolvent();
    }

    // ------------------------------------------------------------------
    // Admin
    // ------------------------------------------------------------------

    function test_houseFee_defaultsToZeroSoPrdMathHolds() public view {
        assertEq(arena.houseFeeBps(), 0);
    }

    function test_houseFee_divertsFromJackpotNotBounty() public {
        vm.prank(owner);
        arena.setHouseFeeBps(500); // 5%

        address p = _player(1);
        _join(MATCH_A, p);

        assertEq(arena.bountyOf(MATCH_A, p), BOUNTY, "bounty is never reduced by the house cut");
        assertEq(arena.getMatch(MATCH_A).jackpotPool, 0.15e6, "20% - 5% = 15% to jackpot");
        assertEq(arena.treasuryUnclaimed(), 0.05e6);
        _assertSolvent();
    }

    function test_houseFee_cappedAtTwentyPercent() public {
        vm.expectRevert(abi.encodeWithSelector(GridZoneArena.HouseFeeTooHigh.selector, 2001, 2000));
        vm.prank(owner);
        arena.setHouseFeeBps(2001);
    }

    function test_openMatch_onlyOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, outsider));
        vm.prank(outsider);
        arena.openMatch(MATCH_B, relayerB);
    }

    function test_openMatch_revertsOnDuplicate() public {
        vm.expectRevert(abi.encodeWithSelector(GridZoneArena.MatchAlreadyExists.selector, MATCH_A));
        vm.prank(owner);
        arena.openMatch(MATCH_A, relayerB);
    }

    function test_withdrawTreasury() public {
        vm.prank(owner);
        arena.setHouseFeeBps(2000);

        address p = _player(1);
        _join(MATCH_A, p);
        assertEq(arena.treasuryUnclaimed(), 0.2e6);

        vm.prank(owner);
        arena.withdrawTreasury(owner, 0.2e6);
        assertEq(usdc.balanceOf(owner), 0.2e6);
        assertEq(arena.treasuryUnclaimed(), 0);
        _assertSolvent();
    }

    function test_withdrawTreasury_revertsOnOverdraw() public {
        vm.expectRevert(GridZoneArena.NothingToWithdraw.selector);
        vm.prank(owner);
        arena.withdrawTreasury(owner, 1);
    }

    // ------------------------------------------------------------------
    // Fuzz
    // ------------------------------------------------------------------

    /// @dev Any lobby size and any kill ordering must preserve solvency.
    function testFuzz_randomKillOrderStaysSolvent(uint256 playerCount, uint256 seed) public {
        playerCount = bound(playerCount, 2, 16);
        address[] memory p = _fill(MATCH_A, playerCount);

        bool[] memory dead = new bool[](playerCount);
        uint256 aliveCount = playerCount;

        while (aliveCount > 1) {
            seed = uint256(keccak256(abi.encode(seed)));
            uint256 victimIdx = seed % playerCount;
            if (dead[victimIdx]) continue;

            uint256 killerIdx = (seed >> 128) % playerCount;
            uint256 mode = (seed >> 8) % 3;

            if (mode == 0 || killerIdx == victimIdx || dead[killerIdx]) {
                // No beneficiary: self-kill or red zone.
                vm.prank(relayerA);
                arena.processEnvironmentOrSelfDeath(MATCH_A, p[victimIdx], mode == 0);
            } else {
                vm.prank(relayerA);
                arena.processKillReward(MATCH_A, p[killerIdx], p[victimIdx]);
            }

            dead[victimIdx] = true;
            aliveCount--;
            _assertSolvent();
        }

        // Whoever is left standing wins.
        uint256 winnerIdx;
        for (uint256 i = 0; i < playerCount; ++i) {
            if (!dead[i]) {
                winnerIdx = i;
                break;
            }
        }

        vm.prank(relayerA);
        arena.finalizeMatch(MATCH_A, p[winnerIdx], LOG_ROOT);

        assertEq(usdc.balanceOf(address(arena)), 0, "every match settles to an empty vault");
        assertEq(arena.totalLiabilities(), 0);
    }

    /// @dev `killer == victim` must always revert on the PvP path (PRD §6).
    function testFuzz_selfKillAlwaysRevertsOnPvpPath(uint256 idx) public {
        address[] memory p = _fill(MATCH_A, 4);
        idx = bound(idx, 0, 3);

        vm.expectRevert(abi.encodeWithSelector(GridZoneArena.SelfKillNotAllowedHere.selector, p[idx]));
        vm.prank(relayerA);
        arena.processKillReward(MATCH_A, p[idx], p[idx]);
    }

    /// @dev No amount of house fee may ever reduce a player's head bounty.
    function testFuzz_bountyNeverReducedByHouseFee(uint256 bps) public {
        bps = bound(bps, 0, arena.MAX_HOUSE_FEE_BPS());
        vm.prank(owner);
        arena.setHouseFeeBps(bps);

        address p = _player(1);
        _join(MATCH_A, p);

        assertEq(arena.bountyOf(MATCH_A, p), BOUNTY);
        _assertSolvent();
    }
}
