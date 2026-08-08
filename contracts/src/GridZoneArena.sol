// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title GridZoneArena
/// @notice Settlement vault for GridZone, a Bomberman-style battle royale where
///         every elimination moves real stablecoin value on Monad.
///
/// @dev DESIGN NOTE 1 - storage is per-match, never global (PRD §5.2).
///      Every mutable value that a kill transaction touches lives inside
///      `matches[matchId]`. This is a hard requirement, not a style choice: a
///      single global `jackpotPool` would make every kill tx from every match
///      write the same storage slot, so Monad's optimistic parallel execution
///      would detect a conflict and re-run them serially. That would make the
///      demo prove the opposite of the product claim.
///
/// @dev DESIGN NOTE 2 - kill rewards leave the vault immediately.
///      PRD §5.2's table sketches `bounty[victim] -> bounty[killer]`, but the
///      value-conservation figures in §4.1 ($9.60 distributed, $5.60 final
///      jackpot, $0.80 winner remainder) only hold if the killer's 80% cut is
///      transferred out on the spot. Keeping it in-vault would inflate a
///      surviving killer's bounty, so the next victim's bounty would no longer
///      be the flat $0.80 those figures assume. Paying out instantly also is
///      the actual product pitch ("real value hits your wallet per kill") and
///      is what makes the sub-second settlement metric observable.
///
/// @dev DESIGN NOTE 3 - the relayer is a trusted oracle, deliberately (PRD §5.4).
///      `onlyMatchRelayer` means the server can move bounty without on-chain
///      proof that a kill happened. The mitigation in scope is auditability,
///      not trustlessness: `finalizeMatch` commits a Merkle root of the match
///      log so any observer can reconstruct and check the result after the fact.
contract GridZoneArena is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Economic constants (PRD §4)
    // ---------------------------------------------------------------------

    /// @notice Basis-point denominator.
    uint256 public constant BPS = 10_000;

    /// @notice Entry fee per player: $1.00 USDC (6 decimals).
    uint256 public constant ENTRY_FEE = 1e6;

    /// @notice Share of the entry fee that becomes the player's head bounty: 80%.
    uint256 public constant BOUNTY_BPS = 8_000;

    /// @notice Share of a victim's bounty paid to their killer: 80%.
    uint256 public constant KILL_REWARD_BPS = 8_000;

    /// @notice Lobby size for the MVP (PRD §9.1: 16 players on a 20x20 grid).
    uint256 public constant MAX_PLAYERS = 16;

    /// @notice Escape-hatch delay before players can pull their own bounty back.
    uint256 public constant MATCH_TIMEOUT = 1 hours;

    /// @notice Upper bound on the house cut, so it can never eat into bounty.
    uint256 public constant MAX_HOUSE_FEE_BPS = 2_000;

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    struct Match {
        bool active;
        bool finalized;
        uint64 startTime;
        uint256 jackpotPool;
        uint256 totalDeposited;
        address[] players;
        mapping(address => uint256) bounty;
        mapping(address => bool) isPlayer;
    }

    /// @notice Settlement token (USDC / MockUSDC on testnet).
    IERC20 public immutable usdc;

    /// @dev Per-match state, keyed by matchId. Private because Solidity cannot
    ///      auto-generate getters for structs containing mappings.
    mapping(bytes32 => Match) private _matches;

    /// @notice Relayer key authorised to settle a given match (PRD §5.3 sharding).
    mapping(bytes32 => address) public matchRelayer;

    /// @notice Merkle root of the off-chain match log, committed at finalization.
    mapping(bytes32 => bytes32) public matchLogRoot;

    /// @notice Every matchId ever opened, for off-chain indexing and tests.
    bytes32[] public matchIds;

    /// @notice House fee taken from each entry fee, in bps of the entry fee.
    /// @dev Defaults to 0 so the PRD §4.1 arithmetic holds exactly: the whole
    ///      non-bounty 20% seeds the match jackpot.
    uint256 public houseFeeBps;

    /// @notice Accrued house fees not yet withdrawn by the owner.
    uint256 public treasuryUnclaimed;

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error MatchAlreadyExists(bytes32 matchId);
    error MatchNotActive(bytes32 matchId);
    error MatchAlreadyFinalized(bytes32 matchId);
    error NotAssignedRelayer(bytes32 matchId, address caller);
    error LobbyFull(bytes32 matchId);
    error AlreadyJoined(bytes32 matchId, address player);
    error NotAPlayer(bytes32 matchId, address account);
    error SelfKillNotAllowedHere(address account);
    error ZeroAddress();
    error NoBountyRemaining(bytes32 matchId, address account);
    error TimeoutNotReached(bytes32 matchId, uint256 availableAt);
    error HouseFeeTooHigh(uint256 requested, uint256 max);
    error NothingToWithdraw();

    // ---------------------------------------------------------------------
    // Events (the on-chain audit trail behind PRD §5.4)
    // ---------------------------------------------------------------------

    event MatchOpened(bytes32 indexed matchId, address indexed relayer, uint64 startTime);
    event PlayerJoined(bytes32 indexed matchId, address indexed player, uint256 bounty, uint256 jackpotPool);
    event KillSettled(
        bytes32 indexed matchId,
        address indexed killer,
        address indexed victim,
        uint256 killerReward,
        uint256 jackpotContribution
    );
    event DeathSettled(bytes32 indexed matchId, address indexed victim, uint256 jackpotContribution, bool selfInflicted);
    event MatchFinalized(bytes32 indexed matchId, address indexed winner, uint256 payout, bytes32 logRoot);
    event EmergencyWithdrawal(bytes32 indexed matchId, address indexed player, uint256 amount);
    event AbandonedJackpotReclaimed(bytes32 indexed matchId, uint256 amount);
    event HouseFeeUpdated(uint256 oldBps, uint256 newBps);
    event TreasuryWithdrawn(address indexed to, uint256 amount);

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------

    modifier onlyMatchRelayer(bytes32 matchId) {
        if (msg.sender != matchRelayer[matchId]) {
            revert NotAssignedRelayer(matchId, msg.sender);
        }
        _;
    }

    /// @dev Guards every settlement entry point: the match must be open and unsettled.
    ///      `finalized` is checked first on purpose. Finalization also clears
    ///      `active`, so testing `active` first would report a settled match as
    ///      merely "not active" and send the relayer chasing the wrong fault.
    modifier onlyLiveMatch(bytes32 matchId) {
        Match storage m = _matches[matchId];
        if (m.finalized) revert MatchAlreadyFinalized(matchId);
        if (!m.active) revert MatchNotActive(matchId);
        _;
    }

    constructor(IERC20 usdc_, address owner_) Ownable(owner_) {
        if (address(usdc_) == address(0)) revert ZeroAddress();
        usdc = usdc_;
    }

    // ---------------------------------------------------------------------
    // Match lifecycle
    // ---------------------------------------------------------------------

    /// @notice Register a new match and bind it to one relayer key from the pool.
    /// @dev Sharding one key per match is what makes parallelism real: nonces on
    ///      a single EOA are strictly sequential, so one relayer could never have
    ///      two kill txs in flight regardless of chain throughput (PRD §5.3).
    function openMatch(bytes32 matchId, address relayer) external onlyOwner {
        if (relayer == address(0)) revert ZeroAddress();
        Match storage m = _matches[matchId];
        if (m.active || m.finalized) revert MatchAlreadyExists(matchId);

        m.active = true;
        m.startTime = uint64(block.timestamp);
        matchRelayer[matchId] = relayer;
        matchIds.push(matchId);

        emit MatchOpened(matchId, relayer, m.startTime);
    }

    /// @notice Pay the $1 entry fee and receive an on-chain head bounty.
    /// @dev This plus a one-time `approve` are the only signatures a player ever
    ///      makes. Nothing during gameplay requires the wallet (PRD §5.1).
    function depositEntryFee(bytes32 matchId) external nonReentrant onlyLiveMatch(matchId) {
        _join(matchId, msg.sender, msg.sender);
    }

    /// @notice Seat a demo bot, funded by the caller rather than the bot itself.
    /// @dev Bots must hold a real bounty or the conservation invariant in §4.1
    ///      breaks during a bot-filled demo lobby (PRD §9.3).
    function depositEntryFeeFor(bytes32 matchId, address player)
        external
        nonReentrant
        onlyLiveMatch(matchId)
        onlyMatchRelayer(matchId)
    {
        if (player == address(0)) revert ZeroAddress();
        _join(matchId, player, msg.sender);
    }

    function _join(bytes32 matchId, address player, address payer) private {
        Match storage m = _matches[matchId];
        if (m.isPlayer[player]) revert AlreadyJoined(matchId, player);
        if (m.players.length >= MAX_PLAYERS) revert LobbyFull(matchId);

        // Split before any external call so accounting is settled up front.
        uint256 bountyAmount = (ENTRY_FEE * BOUNTY_BPS) / BPS;
        uint256 houseAmount = (ENTRY_FEE * houseFeeBps) / BPS;
        uint256 jackpotAmount = ENTRY_FEE - bountyAmount - houseAmount;

        m.isPlayer[player] = true;
        m.players.push(player);
        m.bounty[player] = bountyAmount;
        m.jackpotPool += jackpotAmount;
        m.totalDeposited += ENTRY_FEE;
        treasuryUnclaimed += houseAmount;

        usdc.safeTransferFrom(payer, address(this), ENTRY_FEE);

        emit PlayerJoined(matchId, player, bountyAmount, m.jackpotPool);
    }

    // ---------------------------------------------------------------------
    // Settlement
    // ---------------------------------------------------------------------

    /// @notice Settle a PvP elimination: 80% of the victim's bounty is paid
    ///         straight to the killer's wallet, 20% seeds this match's jackpot.
    /// @dev Rejects `killer == victim`. A Bomberman player blowing themselves up
    ///      is a distinct outcome with no beneficiary and is routed to
    ///      `processEnvironmentOrSelfDeath` instead (PRD §3.3).
    function processKillReward(bytes32 matchId, address killer, address victim)
        external
        nonReentrant
        onlyLiveMatch(matchId)
        onlyMatchRelayer(matchId)
    {
        if (killer == address(0)) revert ZeroAddress();
        if (killer == victim) revert SelfKillNotAllowedHere(killer);

        Match storage m = _matches[matchId];
        if (!m.isPlayer[killer]) revert NotAPlayer(matchId, killer);
        if (!m.isPlayer[victim]) revert NotAPlayer(matchId, victim);

        uint256 victimBounty = m.bounty[victim];
        if (victimBounty == 0) revert NoBountyRemaining(matchId, victim);

        uint256 killerReward = (victimBounty * KILL_REWARD_BPS) / BPS;
        // Remainder rather than a second multiplication: guarantees no wei of
        // bounty is ever stranded by integer division.
        uint256 jackpotContribution = victimBounty - killerReward;

        m.bounty[victim] = 0;
        m.jackpotPool += jackpotContribution;

        usdc.safeTransfer(killer, killerReward);

        emit KillSettled(matchId, killer, victim, killerReward, jackpotContribution);
    }

    /// @notice Settle a death with no beneficiary: self-inflicted blast or a
    ///         red-zone ring collapse. The full bounty rolls into the jackpot.
    function processEnvironmentOrSelfDeath(bytes32 matchId, address victim, bool selfInflicted)
        external
        onlyLiveMatch(matchId)
        onlyMatchRelayer(matchId)
    {
        Match storage m = _matches[matchId];
        if (!m.isPlayer[victim]) revert NotAPlayer(matchId, victim);

        uint256 victimBounty = m.bounty[victim];
        if (victimBounty == 0) revert NoBountyRemaining(matchId, victim);

        m.bounty[victim] = 0;
        m.jackpotPool += victimBounty;

        emit DeathSettled(matchId, victim, victimBounty, selfInflicted);
    }

    /// @notice Batch several eliminations from one server tick into one tx.
    /// @dev Fallback for late-game bursts inside a single match, where one
    ///      relayer's sequential nonce would otherwise be the bottleneck
    ///      (PRD §5.3). Killer == victim entries are treated as self-kills.
    function processKillBatch(bytes32 matchId, address[] calldata killers, address[] calldata victims)
        external
        nonReentrant
        onlyLiveMatch(matchId)
        onlyMatchRelayer(matchId)
    {
        uint256 len = victims.length;
        require(killers.length == len, "length mismatch");

        for (uint256 i = 0; i < len; ++i) {
            _settleOne(matchId, killers[i], victims[i]);
        }
    }

    /// @dev Single-elimination settlement shared by the batch path. Extracted
    ///      into its own frame to keep the batch loop off the EVM stack limit.
    function _settleOne(bytes32 matchId, address killer, address victim) private {
        Match storage m = _matches[matchId];

        if (!m.isPlayer[victim]) revert NotAPlayer(matchId, victim);
        uint256 victimBounty = m.bounty[victim];
        if (victimBounty == 0) revert NoBountyRemaining(matchId, victim);

        if (killer == address(0) || killer == victim) {
            // No beneficiary: the whole bounty rolls into the jackpot.
            m.bounty[victim] = 0;
            m.jackpotPool += victimBounty;
            emit DeathSettled(matchId, victim, victimBounty, killer == victim);
            return;
        }

        if (!m.isPlayer[killer]) revert NotAPlayer(matchId, killer);

        uint256 killerReward = (victimBounty * KILL_REWARD_BPS) / BPS;
        uint256 jackpotContribution = victimBounty - killerReward;

        m.bounty[victim] = 0;
        m.jackpotPool += jackpotContribution;

        usdc.safeTransfer(killer, killerReward);
        emit KillSettled(matchId, killer, victim, killerReward, jackpotContribution);
    }

    /// @notice Close the match and pay the survivor.
    /// @dev Pays `jackpotPool + every bounty still outstanding`. In a normal
    ///      last-man-standing finish only the winner has bounty left, so this is
    ///      exactly the `jackpotPool + bounty[winner]` of PRD §4.1 and fixes the
    ///      v1 dust bug where the winner's own $0.80 stayed locked (changelog #4).
    ///      Sweeping the rest matters because finalization also closes the
    ///      `emergencyWithdraw` path: if a relayer ever finalized while other
    ///      players still held bounty, that value would otherwise be
    ///      unrecoverable by anyone.
    function finalizeMatch(bytes32 matchId, address winner, bytes32 logRoot)
        external
        nonReentrant
        onlyLiveMatch(matchId)
        onlyMatchRelayer(matchId)
    {
        Match storage m = _matches[matchId];
        if (!m.isPlayer[winner]) revert NotAPlayer(matchId, winner);

        uint256 payout = m.jackpotPool;
        m.jackpotPool = 0;

        uint256 len = m.players.length;
        for (uint256 i = 0; i < len; ++i) {
            address p = m.players[i];
            uint256 remaining = m.bounty[p];
            if (remaining != 0) {
                m.bounty[p] = 0;
                payout += remaining;
            }
        }

        m.active = false;
        m.finalized = true;
        matchLogRoot[matchId] = logRoot;

        if (payout > 0) {
            usdc.safeTransfer(winner, payout);
        }

        emit MatchFinalized(matchId, winner, payout, logRoot);
    }

    // ---------------------------------------------------------------------
    // Escape hatches (PRD §5.2, changelog #6)
    // ---------------------------------------------------------------------

    /// @notice Reclaim your own bounty if the match never finalized.
    /// @dev Without this, a crashed game server would strand player funds
    ///      permanently. Callable only by the player, only after the timeout,
    ///      and only while the match is unfinalized.
    function emergencyWithdraw(bytes32 matchId) external nonReentrant {
        Match storage m = _matches[matchId];
        if (m.finalized) revert MatchAlreadyFinalized(matchId);
        if (!m.isPlayer[msg.sender]) revert NotAPlayer(matchId, msg.sender);

        uint256 availableAt = m.startTime + MATCH_TIMEOUT;
        if (block.timestamp <= availableAt) revert TimeoutNotReached(matchId, availableAt);

        uint256 amount = m.bounty[msg.sender];
        if (amount == 0) revert NoBountyRemaining(matchId, msg.sender);

        m.bounty[msg.sender] = 0;
        usdc.safeTransfer(msg.sender, amount);

        emit EmergencyWithdrawal(matchId, msg.sender, amount);
    }

    /// @notice Move an abandoned match's jackpot to the treasury after timeout.
    /// @dev `emergencyWithdraw` only rescues individual bounties, which would
    ///      leave the jackpot of a crashed match locked forever. This keeps the
    ///      solvency invariant satisfiable without stranding value.
    function reclaimAbandonedJackpot(bytes32 matchId) external onlyOwner {
        Match storage m = _matches[matchId];
        if (m.finalized) revert MatchAlreadyFinalized(matchId);

        uint256 availableAt = m.startTime + MATCH_TIMEOUT;
        if (block.timestamp <= availableAt) revert TimeoutNotReached(matchId, availableAt);

        uint256 amount = m.jackpotPool;
        if (amount == 0) revert NothingToWithdraw();

        m.jackpotPool = 0;
        m.active = false;
        treasuryUnclaimed += amount;

        emit AbandonedJackpotReclaimed(matchId, amount);
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    function setHouseFeeBps(uint256 newBps) external onlyOwner {
        if (newBps > MAX_HOUSE_FEE_BPS) revert HouseFeeTooHigh(newBps, MAX_HOUSE_FEE_BPS);
        emit HouseFeeUpdated(houseFeeBps, newBps);
        houseFeeBps = newBps;
    }

    /// @notice Reassign a match's relayer key, e.g. if a pool key gets stuck.
    function setMatchRelayer(bytes32 matchId, address relayer) external onlyOwner {
        if (relayer == address(0)) revert ZeroAddress();
        matchRelayer[matchId] = relayer;
    }

    function withdrawTreasury(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0 || amount > treasuryUnclaimed) revert NothingToWithdraw();
        treasuryUnclaimed -= amount;
        usdc.safeTransfer(to, amount);
        emit TreasuryWithdrawn(to, amount);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @dev Returned as a memory struct rather than a long tuple: seven
    ///      separate return slots plus a storage pointer overflows the stack
    ///      on the legacy codegen pipeline.
    struct MatchView {
        bool active;
        bool finalized;
        uint64 startTime;
        uint256 jackpotPool;
        uint256 totalDeposited;
        uint256 playerCount;
        address relayer;
    }

    function getMatch(bytes32 matchId) external view returns (MatchView memory view_) {
        Match storage m = _matches[matchId];
        view_ = MatchView({
            active: m.active,
            finalized: m.finalized,
            startTime: m.startTime,
            jackpotPool: m.jackpotPool,
            totalDeposited: m.totalDeposited,
            playerCount: m.players.length,
            relayer: matchRelayer[matchId]
        });
    }

    function bountyOf(bytes32 matchId, address player) external view returns (uint256) {
        return _matches[matchId].bounty[player];
    }

    function isPlayer(bytes32 matchId, address account) external view returns (bool) {
        return _matches[matchId].isPlayer[account];
    }

    function getPlayers(bytes32 matchId) external view returns (address[] memory) {
        return _matches[matchId].players;
    }

    function matchCount() external view returns (uint256) {
        return matchIds.length;
    }

    /// @notice Total bounty still owed inside one match.
    function totalBountyOf(bytes32 matchId) public view returns (uint256 total) {
        Match storage m = _matches[matchId];
        uint256 len = m.players.length;
        for (uint256 i = 0; i < len; ++i) {
            total += m.bounty[m.players[i]];
        }
    }

    /// @notice Liabilities the vault must be able to cover, summed over all matches.
    /// @dev This is the right-hand side of the PRD §4.1 solvency invariant:
    ///      `usdc.balanceOf(this) == Σbounty + Σjackpot + treasuryUnclaimed`.
    ///      O(matches × players); a view for tests and monitoring, not for use
    ///      inside a settlement transaction.
    function totalLiabilities() external view returns (uint256 total) {
        uint256 len = matchIds.length;
        for (uint256 i = 0; i < len; ++i) {
            bytes32 id = matchIds[i];
            total += totalBountyOf(id) + _matches[id].jackpotPool;
        }
        total += treasuryUnclaimed;
    }
}
