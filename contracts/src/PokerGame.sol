// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IVRFConsumer.sol";
import "../interfaces/IBandVRFProvider.sol";
import "../libraries/PokerLib.sol";
import "../libraries/HandEvaluator.sol";

contract PokerGame is IVRFConsumer {
    error Unauthorized();
    error OnlyVRFProvider(address expected, address actual);
    error TableNotFound(uint256 tableId);
    error TableFull();
    error NotSeated(address player);
    error AlreadySeated(address player);
    error InvalidBuyIn(uint256 sent, uint256 min, uint256 max);
    error NotYourTurn(address expected, address actual);
    error NotEnoughPlayers();
    error InvalidAction();
    error HandAlreadyInProgress();
    error VRFRequestPending(uint256 tableId);
    error NoVRFRequestPending(uint256 tableId);
    error TimeoutNotReached(uint256 current, uint256 deadline);
    error SaltAlreadyCommitted(address player);
    error NotAllSaltsCommitted(uint8 committed, uint8 required);
    error AlreadyRevealed(address player);
    error SaltMismatch(address player);
    error CommitmentMismatch(address player, bytes32 expected, bytes32 computed);
    error NotAllPlayersRevealed();
    error PlayerNotActive(address player);

    event TableCreated(
        uint256 indexed tableId,
        address indexed creator,
        uint256 smallBlind,
        uint256 bigBlind,
        uint8 maxPlayers
    );
    event PlayerJoined(uint256 indexed tableId, address indexed player, uint8 seat, uint256 buyIn);
    event PlayerLeft(uint256 indexed tableId, address indexed player, uint256 cashOut);
    event SaltCommitted(uint256 indexed tableId, address indexed player, bytes32 saltHash);
    event DealRequested(uint256 indexed tableId, uint256 indexed handId, string seed);
    event HoleCardsCommitted(
        uint256 indexed tableId,
        uint256 indexed handId,
        address indexed player,
        bytes32 commitment
    );
    event CommunityRevealed(uint256 indexed tableId, uint8 stage, uint8[5] cards);
    event PlayerActed(uint256 indexed tableId, address indexed player, PokerLib.Action action, uint256 value);
    event StatusChanged(uint256 indexed tableId, PokerLib.GameStatus from, PokerLib.GameStatus to);
    event PlayerTimedOut(uint256 indexed tableId, address indexed player);
    event HoleCardsRevealed(uint256 indexed tableId, address indexed player, uint8 card0, uint8 card1);
    event ShowdownResult(uint256 indexed tableId, address indexed winner, uint32 winningRank, uint256 payout);
    event SessionAuthorized(address indexed player, address indexed session, uint64 expiresAt);
    event SessionRevoked(address indexed player, address indexed session);
    event Deposited(address indexed player, uint256 amount, uint256 newBalance);
    event Withdrawn(address indexed player, uint256 amount, uint256 newBalance);

    uint8 public constant DECK_SIZE = 52;
    uint8 public constant MAX_SEATS = 10;

    address public immutable owner;
    address public vrfProvider;

    struct Session {
        uint256 tableId;
        uint256 handId;
        uint8 maxPlayers;
        uint256 minBuyIn;
        uint256 maxBuyIn;
        PokerLib.GameStatus status;
        uint8 dealerIndex;
        uint8 activePlayerIndex;
        uint8 playerCount;
        uint256 pot;
        uint256 currentBet;
        uint256 smallBlind;
        uint256 bigBlind;
        bool vrfPending;
        uint256 vrfRequestBlock;
        bytes32 deckSeed;
        bytes32 deckCommitment;
        uint8 deckCursor;
        uint8[5] community;
        uint8 communityCount;
        uint8 saltsCommitted;
        uint8 saltsRevealed;
        uint256 lastActionBlock;
        uint256 actionTimeout;
    }

    struct PlayerState {
        address addr;
        uint256 chips;
        uint256 currentBet;
        PokerLib.Action lastAction;
        bool isActive;
        bool isSeated;
        uint8 seatIndex;
        bytes32 saltHash;
        bytes32 holeCommitment;
        bool hasRevealed;
        uint8 revealedCard0;
        uint8 revealedCard1;
        uint32 handRank;
    }

    uint256 private _nextTableId;
    mapping(uint256 => Session) public sessions;
    mapping(uint256 => mapping(address => PlayerState)) public playerStates;
    mapping(uint256 => mapping(uint8 => address)) public seatMap;
    mapping(bytes32 => uint256) private _vrfSeedToTable;
    mapping(address => uint256) public balances;
    mapping(address => mapping(address => uint64)) public sessionExpiry;

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier tableExists(uint256 tableId) {
        if (tableId >= _nextTableId) revert TableNotFound(tableId);
        _;
    }

    modifier onlySeated(uint256 tableId) {
        if (!playerStates[tableId][msg.sender].isSeated) revert NotSeated(msg.sender);
        _;
    }

    modifier onlyOperator(address player) {
        if (!_isAuthorizedOperator(player, msg.sender)) revert Unauthorized();
        _;
    }

    modifier onlySeatedAs(uint256 tableId, address player) {
        if (!playerStates[tableId][player].isSeated) revert NotSeated(player);
        _;
    }

    constructor(address _vrfProvider) {
        owner = msg.sender;
        vrfProvider = _vrfProvider;
    }

    function setVRFProvider(address _new) external onlyOwner {
        require(_new != address(0), "Zero address");
        vrfProvider = _new;
    }

    function authorizeSession(address session, uint64 expiresAt) external {
        require(session != address(0), "Zero session");
        require(expiresAt > block.timestamp, "Bad expiry");
        sessionExpiry[msg.sender][session] = expiresAt;
        emit SessionAuthorized(msg.sender, session, expiresAt);
    }

    function revokeSession(address session) external {
        delete sessionExpiry[msg.sender][session];
        emit SessionRevoked(msg.sender, session);
    }

    function isSessionAuthorized(address player, address session) external view returns (bool) {
        return _isAuthorizedOperator(player, session);
    }

    function deposit() external payable {
        require(msg.value > 0, "Zero deposit");
        balances[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value, balances[msg.sender]);
    }

    function withdraw(uint256 amount) external {
        require(amount > 0, "Zero amount");
        require(balances[msg.sender] >= amount, "Insufficient balance");
        balances[msg.sender] -= amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "Transfer failed");
        emit Withdrawn(msg.sender, amount, balances[msg.sender]);
    }

    function getBalance(address player) external view returns (uint256) {
        return balances[player];
    }

    function createTable(
        uint256 smallBlind,
        uint256 bigBlind,
        uint8 maxPlayers,
        uint256 minBuyIn,
        uint256 maxBuyIn,
        uint256 timeoutBlocks
    ) external returns (uint256 tableId) {
        require(maxPlayers >= 2 && maxPlayers <= MAX_SEATS, "Players: 2-10");
        require(bigBlind == smallBlind * 2, "BB must be 2x SB");
        require(maxBuyIn >= minBuyIn && minBuyIn > 0, "Invalid buy-in range");

        tableId = _nextTableId++;
        Session storage s = sessions[tableId];
        s.tableId = tableId;
        s.maxPlayers = maxPlayers;
        s.minBuyIn = minBuyIn;
        s.maxBuyIn = maxBuyIn;
        s.status = PokerLib.GameStatus.Waiting;
        s.smallBlind = smallBlind;
        s.bigBlind = bigBlind;
        s.actionTimeout = timeoutBlocks > 0 ? timeoutBlocks : 50;

        emit TableCreated(tableId, msg.sender, smallBlind, bigBlind, maxPlayers);
    }

    function joinTable(uint256 tableId, uint256 buyIn) external tableExists(tableId) {
        _joinTable(tableId, msg.sender, buyIn);
    }

    function joinTableFor(uint256 tableId, address player, uint256 buyIn)
        external
        tableExists(tableId)
        onlyOperator(player)
    {
        _joinTable(tableId, player, buyIn);
    }

    function leaveTable(uint256 tableId) external tableExists(tableId) onlySeated(tableId) {
        _leaveTable(tableId, msg.sender);
    }

    function leaveTableFor(uint256 tableId, address player)
        external
        tableExists(tableId)
        onlyOperator(player)
        onlySeatedAs(tableId, player)
    {
        _leaveTable(tableId, player);
    }

    function commitSalt(uint256 tableId, bytes32 saltHash)
        external
        tableExists(tableId)
        onlySeated(tableId)
    {
        _commitSalt(tableId, msg.sender, saltHash);
    }

    function commitSaltFor(uint256 tableId, address player, bytes32 saltHash)
        external
        tableExists(tableId)
        onlyOperator(player)
        onlySeatedAs(tableId, player)
    {
        _commitSalt(tableId, player, saltHash);
    }

    function requestDeal(uint256 tableId) external tableExists(tableId) onlySeated(tableId) {
        _requestDeal(tableId, msg.sender);
    }

    function requestDealFor(uint256 tableId, address player)
        external
        tableExists(tableId)
        onlyOperator(player)
        onlySeatedAs(tableId, player)
    {
        _requestDeal(tableId, player);
    }

    function consume(string calldata seed, uint64, bytes32 result) external override {
        if (msg.sender != vrfProvider) revert OnlyVRFProvider(vrfProvider, msg.sender);

        bytes32 seedHash = keccak256(bytes(seed));
        uint256 tableId = _vrfSeedToTable[seedHash];
        Session storage s = sessions[tableId];
        if (!s.vrfPending) revert NoVRFRequestPending(tableId);

        s.vrfPending = false;
        delete _vrfSeedToTable[seedHash];

        bytes memory combined = abi.encodePacked(result);
        for (uint8 i = 0; i < s.playerCount; i++) {
            address player = seatMap[tableId][i];
            combined = abi.encodePacked(combined, playerStates[tableId][player].saltHash);
        }

        bytes32 deckSeed = keccak256(combined);
        s.deckSeed = deckSeed;

        uint8[52] memory deck = _fisherYatesMemory(deckSeed);
        s.deckCommitment = keccak256(abi.encodePacked(deck));

        _postBlinds(tableId);

        uint8 cursor = 0;
        uint8[10] memory card0s;
        uint8[10] memory card1s;

        for (uint8 i = 0; i < s.playerCount; i++) {
            uint8 seatIdx = (s.dealerIndex + 1 + i) % s.playerCount;
            card0s[seatIdx] = deck[cursor];
            cursor++;
        }

        for (uint8 i = 0; i < s.playerCount; i++) {
            uint8 seatIdx = (s.dealerIndex + 1 + i) % s.playerCount;
            card1s[seatIdx] = deck[cursor];
            cursor++;
        }

        for (uint8 i = 0; i < s.playerCount; i++) {
            address player = seatMap[tableId][i];
            PlayerState storage p = playerStates[tableId][player];
            p.holeCommitment = keccak256(abi.encodePacked(card0s[i], card1s[i], p.saltHash));
            emit HoleCardsCommitted(tableId, s.handId, player, p.holeCommitment);
        }

        s.deckCursor = cursor;
        s.status = PokerLib.GameStatus.PreFlop;
        s.activePlayerIndex = _nextActingSeat(tableId, (s.dealerIndex + 2) % s.playerCount);
        s.lastActionBlock = block.number;

        emit StatusChanged(tableId, PokerLib.GameStatus.Dealing, PokerLib.GameStatus.PreFlop);
    }

    function playerAction(uint256 tableId, PokerLib.Action action, uint256 value)
        external
        tableExists(tableId)
        onlySeated(tableId)
    {
        _playerAction(tableId, msg.sender, action, value);
    }

    function playerActionFor(uint256 tableId, address player, PokerLib.Action action, uint256 value)
        external
        tableExists(tableId)
        onlyOperator(player)
        onlySeatedAs(tableId, player)
    {
        _playerAction(tableId, player, action, value);
    }

    function forceTimeout(uint256 tableId) external tableExists(tableId) {
        Session storage s = sessions[tableId];
        require(s.status >= PokerLib.GameStatus.PreFlop && s.status <= PokerLib.GameStatus.River, "Not betting");
        if (block.number < s.lastActionBlock + s.actionTimeout) {
            revert TimeoutNotReached(block.number, s.lastActionBlock + s.actionTimeout);
        }

        address timedOut = seatMap[tableId][s.activePlayerIndex];
        PlayerState storage p = playerStates[tableId][timedOut];
        p.isActive = false;
        p.lastAction = PokerLib.Action.Fold;
        s.lastActionBlock = block.number;

        emit PlayerTimedOut(tableId, timedOut);
        _advanceGame(tableId);
    }

    /// @notice Break a stuck showdown. If actionTimeout blocks have passed
    ///         since lastActionBlock and there are still active players who
    ///         haven't revealed, mark them folded. If one active remains the
    ///         table settles via last-standing. If none remain the pot is
    ///         split among those who had committed (degenerate — should not
    ///         happen in normal play). Anyone can call this.
    function forceShowdownTimeout(uint256 tableId) external tableExists(tableId) {
        Session storage s = sessions[tableId];
        require(s.status == PokerLib.GameStatus.Showdown, "Not showdown");
        if (block.number < s.lastActionBlock + s.actionTimeout) {
            revert TimeoutNotReached(block.number, s.lastActionBlock + s.actionTimeout);
        }

        // Fold anyone still active who hasn't revealed their hand.
        for (uint8 i = 0; i < s.playerCount; i++) {
            address player = seatMap[tableId][i];
            PlayerState storage p = playerStates[tableId][player];
            if (p.isActive && !p.hasRevealed) {
                p.isActive = false;
                p.lastAction = PokerLib.Action.Fold;
                emit PlayerTimedOut(tableId, player);
            }
        }

        s.lastActionBlock = block.number;

        uint8 activeCount = _countActive(tableId);
        if (activeCount == 1) {
            _settleLastStanding(tableId);
        } else if (activeCount == 0) {
            // Degenerate: nobody revealed. Return pot to room balances
            // proportionally to what each player put in (recorded as
            // currentBet for the current street — best-effort refund).
            uint256 pot = s.pot;
            s.pot = 0;
            uint256 totalStake = 0;
            for (uint8 i = 0; i < s.playerCount; i++) {
                totalStake += playerStates[tableId][seatMap[tableId][i]].currentBet;
            }
            if (totalStake > 0) {
                for (uint8 i = 0; i < s.playerCount; i++) {
                    address pl = seatMap[tableId][i];
                    PlayerState storage pp = playerStates[tableId][pl];
                    if (pp.currentBet > 0) {
                        uint256 refund = (pot * pp.currentBet) / totalStake;
                        pp.chips += refund;
                    }
                }
            }
            PokerLib.GameStatus prev = s.status;
            s.status = PokerLib.GameStatus.Settled;
            _resetSalts(tableId);
            _pruneBustedPlayers(tableId);
            emit StatusChanged(tableId, prev, PokerLib.GameStatus.Settled);
        }
        // else: 2+ still active and revealed — caller can now evaluateShowdown
    }

    function revealHoleCards(uint256 tableId, bytes32 salt)
        external
        tableExists(tableId)
        onlySeated(tableId)
    {
        _revealHoleCards(tableId, msg.sender, salt);
    }

    function revealHoleCardsFor(uint256 tableId, address player, bytes32 salt)
        external
        tableExists(tableId)
        onlyOperator(player)
        onlySeatedAs(tableId, player)
    {
        _revealHoleCards(tableId, player, salt);
    }

    function evaluateShowdown(uint256 tableId) external tableExists(tableId) {
        Session storage s = sessions[tableId];
        require(s.status == PokerLib.GameStatus.Showdown, "Not showdown");

        uint8 activeCount = _countActive(tableId);
        if (activeCount == 1) {
            _settleLastStanding(tableId);
            return;
        }

        for (uint8 i = 0; i < s.playerCount; i++) {
            address player = seatMap[tableId][i];
            PlayerState storage p = playerStates[tableId][player];
            if (p.isActive && !p.hasRevealed) revert NotAllPlayersRevealed();
        }

        address[10] memory winners;
        uint8 winnerCount;
        uint32 bestRank;

        for (uint8 i = 0; i < s.playerCount; i++) {
            address player = seatMap[tableId][i];
            PlayerState storage p = playerStates[tableId][player];
            if (!p.isActive) continue;

            uint8[7] memory hand;
            hand[0] = p.revealedCard0;
            hand[1] = p.revealedCard1;
            for (uint8 j = 0; j < 5; j++) {
                hand[2 + j] = s.community[j];
            }

            uint32 rank = HandEvaluator.evaluateBestHand(hand);
            p.handRank = rank;

            if (winnerCount == 0 || rank > bestRank) {
                bestRank = rank;
                winners[0] = player;
                winnerCount = 1;
            } else if (rank == bestRank) {
                winners[winnerCount] = player;
                winnerCount++;
            }
        }

        uint256 payout = s.pot;
        s.pot = 0;
        PokerLib.GameStatus prev = s.status;
        s.status = PokerLib.GameStatus.Settled;
        _resetSalts(tableId);

        uint256 share = payout / winnerCount;
        uint256 remainder = payout % winnerCount;
        for (uint8 i = 0; i < winnerCount; i++) {
            uint256 winnerPayout = share;
            if (i == 0) winnerPayout += remainder;
            playerStates[tableId][winners[i]].chips += winnerPayout;
            emit ShowdownResult(tableId, winners[i], bestRank, winnerPayout);
        }

        _pruneBustedPlayers(tableId);

        emit StatusChanged(tableId, prev, PokerLib.GameStatus.Settled);
    }

    function settleLastStanding(uint256 tableId) external tableExists(tableId) {
        require(
            sessions[tableId].status == PokerLib.GameStatus.Showdown || _countActive(tableId) == 1,
            "Not ready"
        );
        _settleLastStanding(tableId);
    }

    function getSession(uint256 tableId)
        external
        view
        returns (
            uint256 handId,
            PokerLib.GameStatus status,
            uint8 playerCount,
            uint8 dealerIndex,
            uint256 pot,
            uint256 currentBet,
            bytes32 deckCommitment,
            uint8 communityCount,
            bool vrfPending,
            uint8 saltsCommitted,
            uint8 saltsRevealed
        )
    {
        Session storage s = sessions[tableId];
        return (
            s.handId,
            s.status,
            s.playerCount,
            s.dealerIndex,
            s.pot,
            s.currentBet,
            s.deckCommitment,
            s.communityCount,
            s.vrfPending,
            s.saltsCommitted,
            s.saltsRevealed
        );
    }

    function getCommunityCards(uint256 tableId) external view returns (uint8[5] memory) {
        return sessions[tableId].community;
    }

    function getPlayerState(uint256 tableId, address player)
        external
        view
        returns (
            uint256 stake,
            uint256 currentBet,
            PokerLib.Action lastAction,
            bool isActive,
            uint8 seatIndex,
            bytes32 holeCommitment,
            bool hasRevealed,
            uint32 handRank
        )
    {
        PlayerState storage p = playerStates[tableId][player];
        return (p.chips, p.currentBet, p.lastAction, p.isActive, p.seatIndex, p.holeCommitment, p.hasRevealed, p.handRank);
    }

    function getRevealedCards(uint256 tableId, address player)
        external
        view
        returns (uint8 c0s, uint8 c0v, uint8 c1s, uint8 c1v)
    {
        PlayerState storage p = playerStates[tableId][player];
        if (!p.hasRevealed) return (0, 0, 0, 0);
        (c0s, c0v) = PokerLib.decodeCard(p.revealedCard0);
        (c1s, c1v) = PokerLib.decodeCard(p.revealedCard1);
    }

    function getPlayers(uint256 tableId) external view returns (address[] memory) {
        uint8 count = sessions[tableId].playerCount;
        address[] memory players = new address[](count);
        for (uint8 i = 0; i < count; i++) {
            players[i] = seatMap[tableId][i];
        }
        return players;
    }

    function tableCount() external view returns (uint256) {
        return _nextTableId;
    }

    function _joinTable(uint256 tableId, address player, uint256 buyIn) internal {
        Session storage s = sessions[tableId];
        _pruneBustedPlayers(tableId);

        require(s.status == PokerLib.GameStatus.Waiting || s.status == PokerLib.GameStatus.Settled, "Not open");
        if (s.playerCount >= s.maxPlayers) revert TableFull();
        if (playerStates[tableId][player].isSeated) revert AlreadySeated(player);
        if (buyIn < s.minBuyIn || buyIn > s.maxBuyIn) revert InvalidBuyIn(buyIn, s.minBuyIn, s.maxBuyIn);
        require(balances[player] >= buyIn, "Insufficient balance - deposit first");

        balances[player] -= buyIn;
        uint8 seat = _findOpenSeat(tableId);
        s.playerCount++;

        PlayerState storage p = playerStates[tableId][player];
        p.addr = player;
        p.chips = buyIn;
        p.currentBet = 0;
        p.lastAction = PokerLib.Action.None;
        p.isActive = true;
        p.isSeated = true;
        p.seatIndex = seat;
        p.saltHash = bytes32(0);
        p.holeCommitment = bytes32(0);
        p.hasRevealed = false;
        p.revealedCard0 = 0;
        p.revealedCard1 = 0;
        p.handRank = 0;

        seatMap[tableId][seat] = player;
        emit PlayerJoined(tableId, player, seat, buyIn);
    }

    function _leaveTable(uint256 tableId, address player) internal {
        Session storage s = sessions[tableId];
        PlayerState storage p = playerStates[tableId][player];
        // Busted players (stack=0) can leave at any time — they don't
        // participate in the ongoing hand anyway. Everyone else must wait
        // for Waiting/Settled.
        if (p.chips > 0) {
            require(
                s.status == PokerLib.GameStatus.Waiting || s.status == PokerLib.GameStatus.Settled,
                "Active hand"
            );
        } else {
            // Busted seat in an active hand: mark them folded so
            // _advanceGame/_runoutToShowdown don't try to include them.
            if (p.isActive) {
                p.isActive = false;
                p.lastAction = PokerLib.Action.Fold;
            }
        }

        uint256 cashOut = p.chips;
        uint8 seat = p.seatIndex;
        delete playerStates[tableId][player];
        _removeSeat(tableId, seat);

        if (cashOut > 0) {
            balances[player] += cashOut;
        }

        // If the last seat just freed, wipe per-hand board state so the empty
        // table starts fresh (no stale community cards, pot, or deck seed).
        if (s.playerCount == 0) {
            s.status = PokerLib.GameStatus.Waiting;
            s.dealerIndex = 0;
            s.activePlayerIndex = 0;
            s.pot = 0;
            s.currentBet = 0;
            s.deckCursor = 0;
            s.communityCount = 0;
            s.deckSeed = bytes32(0);
            s.deckCommitment = bytes32(0);
            s.saltsCommitted = 0;
            s.saltsRevealed = 0;
            s.vrfPending = false;
            s.vrfRequestBlock = 0;
            s.lastActionBlock = 0;
            for (uint8 i = 0; i < 5; i++) { s.community[i] = 0; }
        }

        emit PlayerLeft(tableId, player, cashOut);
    }

    function _commitSalt(uint256 tableId, address player, bytes32 saltHash) internal {
        Session storage s = sessions[tableId];
        require(s.status == PokerLib.GameStatus.Waiting || s.status == PokerLib.GameStatus.Settled, "Wrong phase");
        require(saltHash != bytes32(0), "Zero hash");

        PlayerState storage p = playerStates[tableId][player];
        if (p.saltHash != bytes32(0)) revert SaltAlreadyCommitted(player);

        p.saltHash = saltHash;
        s.saltsCommitted++;

        emit SaltCommitted(tableId, player, saltHash);
    }

    function _requestDeal(uint256 tableId, address player) internal {
        Session storage s = sessions[tableId];
        _pruneBustedPlayers(tableId);

        if (!playerStates[tableId][player].isSeated) revert NotSeated(player);
        if (s.status != PokerLib.GameStatus.Waiting && s.status != PokerLib.GameStatus.Settled) {
            revert HandAlreadyInProgress();
        }
        if (s.playerCount < 2) revert NotEnoughPlayers();
        if (s.vrfPending) revert VRFRequestPending(tableId);
        if (s.saltsCommitted < s.playerCount) revert NotAllSaltsCommitted(s.saltsCommitted, s.playerCount);

        s.handId++;
        s.dealerIndex = (s.dealerIndex + 1) % s.playerCount;
        s.pot = 0;
        s.currentBet = 0;
        s.deckCursor = 0;
        s.communityCount = 0;
        s.deckSeed = bytes32(0);
        s.deckCommitment = bytes32(0);
        s.saltsRevealed = 0;

        for (uint8 i = 0; i < s.playerCount; i++) {
            address seatedPlayer = seatMap[tableId][i];
            PlayerState storage p = playerStates[tableId][seatedPlayer];
            p.isActive = true;
            p.currentBet = 0;
            p.lastAction = PokerLib.Action.None;
            p.holeCommitment = bytes32(0);
            p.hasRevealed = false;
            p.revealedCard0 = 0;
            p.revealedCard1 = 0;
            p.handRank = 0;
        }

        PokerLib.GameStatus prev = s.status;
        s.status = PokerLib.GameStatus.Dealing;
        s.vrfPending = true;
        s.vrfRequestBlock = block.number;
        s.lastActionBlock = block.number;

        emit StatusChanged(tableId, prev, PokerLib.GameStatus.Dealing);

        string memory vrfSeed = string(abi.encodePacked("POKER:", _uint2str(tableId), ":", _uint2str(s.handId)));
        _vrfSeedToTable[keccak256(bytes(vrfSeed))] = tableId;
        emit DealRequested(tableId, s.handId, vrfSeed);
        IBandVRFProvider(vrfProvider).requestRandomData(vrfSeed);
    }

    function _playerAction(uint256 tableId, address player, PokerLib.Action action, uint256 value) internal {
        Session storage s = sessions[tableId];
        require(s.status >= PokerLib.GameStatus.PreFlop && s.status <= PokerLib.GameStatus.River, "Not betting");

        address current = seatMap[tableId][s.activePlayerIndex];
        if (player != current) revert NotYourTurn(current, player);

        PlayerState storage p = playerStates[tableId][player];
        require(p.isActive, "Folded");

        if (action == PokerLib.Action.Fold) {
            p.isActive = false;
            p.lastAction = PokerLib.Action.Fold;
        } else if (action == PokerLib.Action.Check) {
            require(s.currentBet == p.currentBet, "Must call");
            p.lastAction = PokerLib.Action.Check;
        } else if (action == PokerLib.Action.Call) {
            uint256 toCall = s.currentBet - p.currentBet;
            require(p.chips >= toCall, "Insufficient INIT");
            p.chips -= toCall;
            p.currentBet += toCall;
            s.pot += toCall;
            p.lastAction = PokerLib.Action.Call;
        } else if (action == PokerLib.Action.Bet || action == PokerLib.Action.Raise) {
            require(value >= s.bigBlind && value > s.currentBet, "Bet size");
            uint256 add = value - p.currentBet;
            require(p.chips >= add, "Insufficient INIT");
            p.chips -= add;
            p.currentBet = value;
            s.currentBet = value;
            s.pot += add;
            p.lastAction = action;
        } else if (action == PokerLib.Action.AllIn) {
            uint256 amount = p.chips;
            p.currentBet += amount;
            if (p.currentBet > s.currentBet) s.currentBet = p.currentBet;
            s.pot += amount;
            p.chips = 0;
            p.lastAction = PokerLib.Action.AllIn;
        } else {
            revert InvalidAction();
        }

        s.lastActionBlock = block.number;
        emit PlayerActed(tableId, player, action, value);
        _advanceGame(tableId);
    }

    function _revealHoleCards(uint256 tableId, address player, bytes32 salt) internal {
        Session storage s = sessions[tableId];
        require(s.status == PokerLib.GameStatus.Showdown, "Not showdown");

        PlayerState storage p = playerStates[tableId][player];
        if (!p.isActive) revert PlayerNotActive(player);
        if (p.hasRevealed) revert AlreadyRevealed(player);

        bytes32 computedHash = keccak256(abi.encodePacked(salt));
        if (computedHash != p.saltHash) revert SaltMismatch(player);

        uint8[52] memory deck = _fisherYatesMemory(s.deckSeed);
        (uint8 c0, uint8 c1) = _extractHoleCards(deck, s.playerCount, s.dealerIndex, p.seatIndex);

        bytes32 expected = keccak256(abi.encodePacked(c0, c1, p.saltHash));
        if (expected != p.holeCommitment) revert CommitmentMismatch(player, p.holeCommitment, expected);

        p.revealedCard0 = c0;
        p.revealedCard1 = c1;
        p.hasRevealed = true;
        s.saltsRevealed++;

        emit HoleCardsRevealed(tableId, player, c0, c1);
    }

    function _extractHoleCards(uint8[52] memory deck, uint8 playerCount, uint8 dealer, uint8 seat)
        internal
        pure
        returns (uint8 c0, uint8 c1)
    {
        uint8 dealPos = type(uint8).max;
        for (uint8 i = 0; i < playerCount; i++) {
            if ((dealer + 1 + i) % playerCount == seat) {
                dealPos = i;
                break;
            }
        }
        require(dealPos != type(uint8).max, "Bad seat");
        c0 = deck[dealPos];
        c1 = deck[playerCount + dealPos];
    }

    function _postBlinds(uint256 tableId) internal {
        Session storage s = sessions[tableId];

        uint8 sbSeat = (s.dealerIndex + 1) % s.playerCount;
        address sbAddr = seatMap[tableId][sbSeat];
        PlayerState storage sb = playerStates[tableId][sbAddr];
        uint256 sbAmount = s.smallBlind < sb.chips ? s.smallBlind : sb.chips;
        sb.chips -= sbAmount;
        sb.currentBet = sbAmount;
        s.pot += sbAmount;

        uint8 bbSeat = (s.dealerIndex + 2) % s.playerCount;
        address bbAddr = seatMap[tableId][bbSeat];
        PlayerState storage bb = playerStates[tableId][bbAddr];
        uint256 bbAmount = s.bigBlind < bb.chips ? s.bigBlind : bb.chips;
        bb.chips -= bbAmount;
        bb.currentBet = bbAmount;
        s.pot += bbAmount;
        s.currentBet = bbAmount;
    }

    function _revealCommunity(uint256 tableId, uint8 count) internal {
        Session storage s = sessions[tableId];
        uint8[52] memory deck = _fisherYatesMemory(s.deckSeed);

        for (uint8 i = 0; i < count; i++) {
            s.deckCursor++;
            s.community[s.communityCount] = deck[s.deckCursor];
            s.communityCount++;
            s.deckCursor++;
        }

        emit CommunityRevealed(tableId, s.communityCount, s.community);
    }

    function _advanceGame(uint256 tableId) internal {
        Session storage s = sessions[tableId];
        if (_countActive(tableId) == 1) {
            PokerLib.GameStatus prev = s.status;
            s.status = PokerLib.GameStatus.Showdown;
            emit StatusChanged(tableId, prev, PokerLib.GameStatus.Showdown);
            return;
        }

        if (_isRoundComplete(tableId)) {
            if (_countActiveWithChips(tableId) <= 1) {
                _runoutToShowdown(tableId);
                return;
            }
            _advanceRound(tableId);
            return;
        }

        s.activePlayerIndex = _nextActingSeat(tableId, s.activePlayerIndex);
    }

    function _isRoundComplete(uint256 tableId) internal view returns (bool) {
        Session storage s = sessions[tableId];
        for (uint8 i = 0; i < s.playerCount; i++) {
            address player = seatMap[tableId][i];
            PlayerState storage p = playerStates[tableId][player];
            if (!p.isActive) continue;
            if (p.chips == 0) continue;
            if (p.lastAction == PokerLib.Action.None) return false;
            if (p.currentBet < s.currentBet) return false;
        }
        return true;
    }

    function _advanceRound(uint256 tableId) internal {
        Session storage s = sessions[tableId];
        PokerLib.GameStatus prev = s.status;

        for (uint8 i = 0; i < s.playerCount; i++) {
            address player = seatMap[tableId][i];
            PlayerState storage p = playerStates[tableId][player];
            p.currentBet = 0;
            if (p.isActive) {
                p.lastAction = PokerLib.Action.None;
            }
        }

        s.currentBet = 0;
        if (s.status == PokerLib.GameStatus.PreFlop) {
            s.status = PokerLib.GameStatus.Flop;
            _revealCommunity(tableId, 3);
            if (_countActiveWithChips(tableId) > 1) {
                s.activePlayerIndex = _nextActingSeat(tableId, s.dealerIndex);
            }
        } else if (s.status == PokerLib.GameStatus.Flop) {
            s.status = PokerLib.GameStatus.Turn;
            _revealCommunity(tableId, 1);
            if (_countActiveWithChips(tableId) > 1) {
                s.activePlayerIndex = _nextActingSeat(tableId, s.dealerIndex);
            }
        } else if (s.status == PokerLib.GameStatus.Turn) {
            s.status = PokerLib.GameStatus.River;
            _revealCommunity(tableId, 1);
            if (_countActiveWithChips(tableId) > 1) {
                s.activePlayerIndex = _nextActingSeat(tableId, s.dealerIndex);
            }
        } else if (s.status == PokerLib.GameStatus.River) {
            s.status = PokerLib.GameStatus.Showdown;
        }

        s.lastActionBlock = block.number;
        emit StatusChanged(tableId, prev, s.status);
    }

    function _countActive(uint256 tableId) internal view returns (uint8 count) {
        Session storage s = sessions[tableId];
        for (uint8 i = 0; i < s.playerCount; i++) {
            if (playerStates[tableId][seatMap[tableId][i]].isActive) count++;
        }
    }

    function _countActiveWithChips(uint256 tableId) internal view returns (uint8 count) {
        Session storage s = sessions[tableId];
        for (uint8 i = 0; i < s.playerCount; i++) {
            PlayerState storage p = playerStates[tableId][seatMap[tableId][i]];
            if (p.isActive && p.chips > 0) count++;
        }
    }

    function _findLastActive(uint256 tableId) internal view returns (address) {
        Session storage s = sessions[tableId];
        for (uint8 i = 0; i < s.playerCount; i++) {
            address player = seatMap[tableId][i];
            if (playerStates[tableId][player].isActive) return player;
        }
        revert("None active");
    }

    function _settleLastStanding(uint256 tableId) internal {
        Session storage s = sessions[tableId];
        address winner = _findLastActive(tableId);
        uint256 payout = s.pot;
        s.pot = 0;
        playerStates[tableId][winner].chips += payout;
        PokerLib.GameStatus prev = s.status;
        s.status = PokerLib.GameStatus.Settled;
        _resetSalts(tableId);
        _pruneBustedPlayers(tableId);

        emit ShowdownResult(tableId, winner, 0, payout);
        emit StatusChanged(tableId, prev, PokerLib.GameStatus.Settled);
    }

    function _runoutToShowdown(uint256 tableId) internal {
        Session storage s = sessions[tableId];
        while (s.status >= PokerLib.GameStatus.PreFlop && s.status <= PokerLib.GameStatus.River) {
            _advanceRound(tableId);
            if (s.status == PokerLib.GameStatus.Showdown) {
                break;
            }
        }
    }

    function _resetSalts(uint256 tableId) internal {
        Session storage s = sessions[tableId];
        s.saltsCommitted = 0;
        s.saltsRevealed = 0;
        for (uint8 i = 0; i < s.playerCount; i++) {
            playerStates[tableId][seatMap[tableId][i]].saltHash = bytes32(0);
        }
    }

    function _findOpenSeat(uint256 tableId) internal view returns (uint8) {
        Session storage s = sessions[tableId];
        for (uint8 i = 0; i < s.maxPlayers; i++) {
            if (seatMap[tableId][i] == address(0)) return i;
        }
        revert TableFull();
    }

    function _removeSeat(uint256 tableId, uint8 seat) internal {
        Session storage s = sessions[tableId];
        uint8 oldCount = s.playerCount;

        for (uint8 i = seat; i + 1 < oldCount; i++) {
            address shifted = seatMap[tableId][i + 1];
            seatMap[tableId][i] = shifted;
            playerStates[tableId][shifted].seatIndex = i;
        }

        delete seatMap[tableId][oldCount - 1];
        s.playerCount = oldCount - 1;

        if (s.playerCount == 0) {
            s.dealerIndex = 0;
            s.activePlayerIndex = 0;
            return;
        }

        if (s.dealerIndex > seat) {
            s.dealerIndex--;
        } else if (s.dealerIndex >= s.playerCount) {
            s.dealerIndex = 0;
        }

        if (s.activePlayerIndex > seat) {
            s.activePlayerIndex--;
        } else if (s.activePlayerIndex >= s.playerCount) {
            s.activePlayerIndex = 0;
        }
    }

    function _pruneBustedPlayers(uint256 tableId) internal {
        Session storage s = sessions[tableId];
        uint8 i = 0;
        while (i < s.playerCount) {
            address player = seatMap[tableId][i];
            if (playerStates[tableId][player].chips == 0) {
                delete playerStates[tableId][player];
                _removeSeat(tableId, i);
                emit PlayerLeft(tableId, player, 0);
                continue;
            }
            i++;
        }
    }

    function _nextActiveSeat(uint256 tableId, uint8 fromSeat) internal view returns (uint8) {
        Session storage s = sessions[tableId];
        uint8 seat = (fromSeat + 1) % s.playerCount;
        for (uint8 i = 0; i < s.playerCount; i++) {
            address player = seatMap[tableId][seat];
            if (playerStates[tableId][player].isActive) return seat;
            seat = (seat + 1) % s.playerCount;
        }
        return fromSeat;
    }

    function _nextActingSeat(uint256 tableId, uint8 fromSeat) internal view returns (uint8) {
        Session storage s = sessions[tableId];
        uint8 seat = (fromSeat + 1) % s.playerCount;
        for (uint8 i = 0; i < s.playerCount; i++) {
            address player = seatMap[tableId][seat];
            PlayerState storage p = playerStates[tableId][player];
            if (p.isActive && p.chips > 0) return seat;
            seat = (seat + 1) % s.playerCount;
        }
        return fromSeat;
    }

    function _isAuthorizedOperator(address player, address operator) internal view returns (bool) {
        return operator == player || sessionExpiry[player][operator] >= block.timestamp;
    }

    function _fisherYatesMemory(bytes32 deckSeed) internal pure returns (uint8[52] memory deck) {
        uint8 idx = 0;
        for (uint8 suit = 0; suit < 4; suit++) {
            for (uint8 value = 1; value <= 13; value++) {
                deck[idx] = (suit << 4) | value;
                idx++;
            }
        }

        bytes32 h = deckSeed;
        for (uint8 i = 1; i < 52; i++) {
            h = keccak256(abi.encodePacked(h, i));
            uint256 j = uint256(h) % (uint256(i) + 1);
            if (i != uint8(j)) {
                uint8 temp = deck[i];
                deck[i] = deck[uint8(j)];
                deck[uint8(j)] = temp;
            }
        }
    }

    function _uint2str(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 length;
        while (temp != 0) {
            length++;
            temp /= 10;
        }
        bytes memory buffer = new bytes(length);
        uint256 k = length;
        while (value != 0) {
            k--;
            buffer[k] = bytes1(uint8(48 + value % 10));
            value /= 10;
        }
        return string(buffer);
    }

    receive() external payable {
        if (msg.value > 0) {
            balances[msg.sender] += msg.value;
            emit Deposited(msg.sender, msg.value, balances[msg.sender]);
        }
    }
}
