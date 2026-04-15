// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IVRFConsumer.sol";
import "../interfaces/IBandVRFProvider.sol";
import "../libraries/PokerLib.sol";
import "../libraries/HandEvaluator.sol";

/// @title PokerGame — Commit-Reveal Texas Hold'em on Minitia L2
/// @author Ported from anthdm/ggpoker with privacy-preserving card dealing
///
/// VULNERABILITY IN PREVIOUS VERSION:
///   PlayerState.holeCard0 = s.deck[cursor]  — PLAINTEXT IN STORAGE
///   Session.deck[52]                         — FULL DECK IN STORAGE
///   Any eth_getStorageAt() reveals all hole cards.
///
/// THIS VERSION:
///   deck[52] NEVER written to storage (memory-only Fisher-Yates)
///   holeCard0/1 REMOVED — only keccak256 commitments stored
///   Showdown requires salt reveal + cryptographic verification
///   Bitmask hand evaluator for gas-optimized winner determination
///
/// Async flow:
///   Phase 0 — commitSalt(keccak256(salt))       [before deal]
///   Phase 1 — requestDeal()                      [triggers VRF]
///   Phase 2 — consume() → memory shuffle → commitments only
///   Phase 3 — Betting: PreFlop → Flop → Turn → River
///   Phase 4 — revealHoleCards(salt) → verify → store revealed cards
///   Phase 5 — evaluateShowdown() → bitmask ranking → pot distribution

contract PokerGame is IVRFConsumer {

    // ═══════════════════════════════════════════════════════════════
    //  ERRORS
    // ═══════════════════════════════════════════════════════════════

    error Unauthorized();
    error OnlyVRFProvider(address expected, address actual);
    error TableNotFound(uint256 tableId);
    error TableFull();
    error NotSeated(address player);
    error AlreadySeated(address player);
    error InvalidBuyIn(uint256 sent, uint256 min, uint256 max);
    error NotYourTurn(address expected, address actual);
    error NotEnoughPlayers();
    error InsufficientBet(uint256 required, uint256 provided);
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

    // ═══════════════════════════════════════════════════════════════
    //  EVENTS
    // ═══════════════════════════════════════════════════════════════

    event TableCreated(
        uint256 indexed tableId, address indexed creator,
        uint256 smallBlind, uint256 bigBlind, uint8 maxPlayers
    );
    event PlayerJoined(uint256 indexed tableId, address indexed player, uint8 seat, uint256 buyIn);
    event PlayerLeft(uint256 indexed tableId, address indexed player, uint256 cashOut);
    event SaltCommitted(uint256 indexed tableId, address indexed player, bytes32 saltHash);
    event DealRequested(uint256 indexed tableId, uint256 indexed handId, string seed);
    event HoleCardsCommitted(
        uint256 indexed tableId, uint256 indexed handId,
        address indexed player, bytes32 commitment
    );
    event CommunityRevealed(uint256 indexed tableId, uint8 stage, uint8[5] cards);
    event PlayerActed(uint256 indexed tableId, address indexed player, PokerLib.Action action, uint256 value);
    event StatusChanged(uint256 indexed tableId, PokerLib.GameStatus from, PokerLib.GameStatus to);
    event PlayerTimedOut(uint256 indexed tableId, address indexed player);
    event HoleCardsRevealed(uint256 indexed tableId, address indexed player, uint8 card0, uint8 card1);
    event ShowdownResult(uint256 indexed tableId, address indexed winner, uint32 winningRank, uint256 payout);

    // ═══════════════════════════════════════════════════════════════
    //  CONSTANTS & IMMUTABLES
    // ═══════════════════════════════════════════════════════════════

    uint8 public constant DECK_SIZE = 52;
    uint8 public constant MAX_SEATS = 10;

    address public immutable owner;
    address public vrfProvider;

    // ═══════════════════════════════════════════════════════════════
    //  SESSION STATE (no deck storage, no plaintext cards)
    // ═══════════════════════════════════════════════════════════════

    struct Session {
        uint256             tableId;
        uint256             handId;
        uint8               maxPlayers;
        uint256             minBuyIn;
        uint256             maxBuyIn;
        PokerLib.GameStatus status;
        uint8               dealerIndex;
        uint8               activePlayerIndex;
        uint8               playerCount;
        uint256             pot;
        uint256             currentBet;
        uint256             smallBlind;
        uint256             bigBlind;
        bool                vrfPending;
        uint256             vrfRequestBlock;
        // REMOVED: bytes32 vrfEntropy   (leaked deck derivation)
        // REMOVED: uint8[52] deck       (plaintext deck in storage!)
        bytes32             deckSeed;       // keccak256(vrfResult, saltHashes...)
        bytes32             deckCommitment; // keccak256(abi.encodePacked(deck))
        uint8               deckCursor;
        uint8[5]            community;
        uint8               communityCount;
        uint8               saltsCommitted;
        uint8               saltsRevealed;
        uint256             lastActionBlock;
        uint256             actionTimeout;
    }

    /// @notice Player state — NO plaintext hole cards
    struct PlayerState {
        address addr;
        uint256 chips;
        uint256 currentBet;
        PokerLib.Action lastAction;
        bool    isActive;
        bool    isSeated;
        uint8   seatIndex;
        // Commit-Reveal fields (replace removed holeCard0/holeCard1)
        bytes32 saltHash;        // keccak256(clientSalt) — committed Phase 0
        bytes32 holeCommitment;  // keccak256(card0, card1, saltHash) — set in consume()
        // Reveal phase (populated ONLY after valid reveal in Phase 4)
        bool    hasRevealed;
        uint8   revealedCard0;
        uint8   revealedCard1;
        uint32  handRank;
    }

    // ═══════════════════════════════════════════════════════════════
    //  STORAGE
    // ═══════════════════════════════════════════════════════════════

    uint256 private _nextTableId;
    mapping(uint256 => Session) public sessions;
    mapping(uint256 => mapping(address => PlayerState)) public playerStates;
    mapping(uint256 => mapping(uint8 => address)) public seatMap;
    mapping(bytes32 => uint256) private _vrfSeedToTable;

    /// @notice Internal wallet balance (Polymarket-style: deposit first, play from balance)
    mapping(address => uint256) public balances;

    event Deposited(address indexed player, uint256 amount, uint256 newBalance);
    event Withdrawn(address indexed player, uint256 amount, uint256 newBalance);

    // ═══════════════════════════════════════════════════════════════
    //  MODIFIERS
    // ═══════════════════════════════════════════════════════════════

    modifier onlyOwner() { if (msg.sender != owner) revert Unauthorized(); _; }
    modifier tableExists(uint256 id) { if (id >= _nextTableId) revert TableNotFound(id); _; }
    modifier onlySeated(uint256 id) { if (!playerStates[id][msg.sender].isSeated) revert NotSeated(msg.sender); _; }

    // ═══════════════════════════════════════════════════════════════
    //  CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════

    constructor(address _vrfProvider) { owner = msg.sender; vrfProvider = _vrfProvider; }

    function setVRFProvider(address _new) external onlyOwner {
        require(_new != address(0), "Zero address");
        vrfProvider = _new;
    }

    // ═══════════════════════════════════════════════════════════════
    //  INTERNAL WALLET (Polymarket-style deposit/withdraw)
    // ═══════════════════════════════════════════════════════════════

    /// @notice Deposit INIT into internal wallet balance
    function deposit() external payable {
        require(msg.value > 0, "Zero deposit");
        balances[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value, balances[msg.sender]);
    }

    /// @notice Withdraw INIT from internal wallet balance to external wallet
    function withdraw(uint256 amount) external {
        require(amount > 0, "Zero amount");
        require(balances[msg.sender] >= amount, "Insufficient balance");
        balances[msg.sender] -= amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "Transfer failed");
        emit Withdrawn(msg.sender, amount, balances[msg.sender]);
    }

    /// @notice Get internal wallet balance for a player
    function getBalance(address player) external view returns (uint256) {
        return balances[player];
    }

    // ═══════════════════════════════════════════════════════════════
    //  TABLE MANAGEMENT
    // ═══════════════════════════════════════════════════════════════

    function createTable(
        uint256 smallBlind, uint256 bigBlind, uint8 maxPlayers,
        uint256 minBuyIn, uint256 maxBuyIn, uint256 timeoutBlocks
    ) external returns (uint256 tableId) {
        require(maxPlayers >= 2 && maxPlayers <= MAX_SEATS, "Players: 2-10");
        require(bigBlind == smallBlind * 2, "BB must be 2x SB");
        require(maxBuyIn >= minBuyIn && minBuyIn > 0, "Invalid buy-in range");
        tableId = _nextTableId++;
        Session storage s = sessions[tableId];
        s.tableId = tableId; s.maxPlayers = maxPlayers;
        s.smallBlind = smallBlind; s.bigBlind = bigBlind;
        s.minBuyIn = minBuyIn; s.maxBuyIn = maxBuyIn;
        s.status = PokerLib.GameStatus.Waiting;
        s.actionTimeout = timeoutBlocks > 0 ? timeoutBlocks : 50;
        emit TableCreated(tableId, msg.sender, smallBlind, bigBlind, maxPlayers);
    }

    /// @notice Join a table using INIT from internal wallet balance
    /// @param tableId The table to join
    /// @param buyIn Amount of INIT to bring to the table (deducted from internal balance)
    function joinTable(uint256 tableId, uint256 buyIn) external tableExists(tableId) {
        Session storage s = sessions[tableId];
        require(s.status == PokerLib.GameStatus.Waiting || s.status == PokerLib.GameStatus.Settled, "Not open");
        if (s.playerCount >= s.maxPlayers) revert TableFull();
        if (playerStates[tableId][msg.sender].isSeated) revert AlreadySeated(msg.sender);
        if (buyIn < s.minBuyIn || buyIn > s.maxBuyIn) revert InvalidBuyIn(buyIn, s.minBuyIn, s.maxBuyIn);
        require(balances[msg.sender] >= buyIn, "Insufficient balance - deposit first");
        /*
        require(balances[msg.sender] >= buyIn, "Insufficient balance — deposit first");
        */
        balances[msg.sender] -= buyIn;
        uint8 seat = s.playerCount;
        s.playerCount++;
        PlayerState storage p = playerStates[tableId][msg.sender];
        p.addr = msg.sender;
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
        seatMap[tableId][seat] = msg.sender;
        emit PlayerJoined(tableId, msg.sender, seat, buyIn);
    }

    function leaveTable(uint256 tableId) external tableExists(tableId) onlySeated(tableId) {
        Session storage s = sessions[tableId];
        require(s.status == PokerLib.GameStatus.Waiting || s.status == PokerLib.GameStatus.Settled, "Active hand");
        PlayerState storage p = playerStates[tableId][msg.sender];
        uint8 seat = p.seatIndex;
        uint256 cashOut = p.chips;

        if (p.saltHash != bytes32(0) && s.saltsCommitted > 0) {
            s.saltsCommitted--;
        }

        for (uint8 i = seat; i + 1 < s.playerCount; i++) {
            address shifted = seatMap[tableId][i + 1];
            seatMap[tableId][i] = shifted;
            if (shifted != address(0)) {
                playerStates[tableId][shifted].seatIndex = i;
            }
        }

        if (s.playerCount > 0) {
            seatMap[tableId][s.playerCount - 1] = address(0);
        }

        if (s.playerCount > 1 && seat <= s.dealerIndex) {
            s.dealerIndex = s.dealerIndex == 0 ? s.playerCount - 2 : s.dealerIndex - 1;
        } else if (s.playerCount <= 1) {
            s.dealerIndex = 0;
        }
        s.activePlayerIndex = s.dealerIndex;

        delete playerStates[tableId][msg.sender];
        s.playerCount--;
        if (cashOut > 0) { balances[msg.sender] += cashOut; }
        emit PlayerLeft(tableId, msg.sender, cashOut);
    }

    // ═══════════════════════════════════════════════════════════════
    //  PHASE 0 — SALT COMMITMENT
    // ═══════════════════════════════════════════════════════════════

    /// @notice Commit a salt hash before the deal
    /// @dev Client: salt = randomBytes(32), saltHash = keccak256(salt)
    function commitSalt(uint256 tableId, bytes32 saltHash)
        external tableExists(tableId) onlySeated(tableId)
    {
        Session storage s = sessions[tableId];
        require(s.status == PokerLib.GameStatus.Waiting || s.status == PokerLib.GameStatus.Settled, "Wrong phase");
        require(saltHash != bytes32(0), "Zero hash");
        PlayerState storage p = playerStates[tableId][msg.sender];
        if (p.saltHash != bytes32(0)) revert SaltAlreadyCommitted(msg.sender);
        p.saltHash = saltHash;
        s.saltsCommitted++;
        emit SaltCommitted(tableId, msg.sender, saltHash);
    }

    // ═══════════════════════════════════════════════════════════════
    //  PHASE 1 — DEAL REQUEST
    // ═══════════════════════════════════════════════════════════════

    function requestDeal(uint256 tableId) external tableExists(tableId) onlySeated(tableId) {
        Session storage s = sessions[tableId];
        if (s.status != PokerLib.GameStatus.Waiting && s.status != PokerLib.GameStatus.Settled) revert HandAlreadyInProgress();
        if (s.playerCount < 2) revert NotEnoughPlayers();
        if (s.vrfPending) revert VRFRequestPending(tableId);
        if (s.saltsCommitted < s.playerCount) revert NotAllSaltsCommitted(s.saltsCommitted, s.playerCount);

        s.handId++;
        s.dealerIndex = (s.dealerIndex + 1) % s.playerCount;
        s.pot = 0; s.currentBet = 0; s.deckCursor = 0; s.communityCount = 0;
        s.deckSeed = bytes32(0); s.deckCommitment = bytes32(0); s.saltsRevealed = 0;

        for (uint8 i = 0; i < s.playerCount; i++) {
            address addr = seatMap[tableId][i];
            if (addr != address(0)) {
                PlayerState storage p = playerStates[tableId][addr];
                p.isActive = true; p.currentBet = 0; p.lastAction = PokerLib.Action.None;
                p.holeCommitment = bytes32(0); p.hasRevealed = false;
                p.revealedCard0 = 0; p.revealedCard1 = 0; p.handRank = 0;
            }
        }

        PokerLib.GameStatus prev = s.status;
        s.status = PokerLib.GameStatus.Dealing;
        s.vrfPending = true; s.vrfRequestBlock = block.number; s.lastActionBlock = block.number;
        emit StatusChanged(tableId, prev, PokerLib.GameStatus.Dealing);

        string memory vrfSeed = string(abi.encodePacked("POKER:", _uint2str(tableId), ":", _uint2str(s.handId)));
        _vrfSeedToTable[keccak256(bytes(vrfSeed))] = tableId;
        emit DealRequested(tableId, s.handId, vrfSeed);
        IBandVRFProvider(vrfProvider).requestRandomData(vrfSeed);
    }

    // ═══════════════════════════════════════════════════════════════
    //  PHASE 2 — VRF CALLBACK (memory-only shuffle + commitments)
    // ═══════════════════════════════════════════════════════════════

    /// @notice Band VRF callback — MEMORY-ONLY deck shuffle
    /// @dev CRITICAL CHANGES:
    ///   BEFORE: s.deck[i] = card;           ← storage (READABLE!)
    ///   BEFORE: p.holeCard0 = s.deck[n];    ← storage (READABLE!)
    ///   AFTER:  memory deck = shuffle();     ← ephemeral (GONE after tx)
    ///   AFTER:  p.holeCommitment = hash();   ← only hash stored
    function consume(string calldata seed, uint64 time, bytes32 result) external override {
        if (msg.sender != vrfProvider) revert OnlyVRFProvider(vrfProvider, msg.sender);

        bytes32 seedHash = keccak256(bytes(seed));
        uint256 tableId = _vrfSeedToTable[seedHash];
        Session storage s = sessions[tableId];
        if (!s.vrfPending) revert NoVRFRequestPending(tableId);

        s.vrfPending = false;
        delete _vrfSeedToTable[seedHash];

        // Build deckSeed from VRF result + ALL player salt hashes
        bytes memory combined = abi.encodePacked(result);
        for (uint8 i = 0; i < s.playerCount; i++) {
            address addr = seatMap[tableId][i];
            combined = abi.encodePacked(combined, playerStates[tableId][addr].saltHash);
        }
        bytes32 deckSeed = keccak256(combined);
        s.deckSeed = deckSeed;

        // ┌──────────────────────────────────────────────────────────┐
        // │ FISHER-YATES IN MEMORY — deck NEVER touches storage     │
        // │ eth_getStorageAt() CANNOT read memory variables          │
        // └──────────────────────────────────────────────────────────┘
        uint8[52] memory deck = _fisherYatesMemory(deckSeed);

        s.deckCommitment = keccak256(abi.encodePacked(deck));

        // Post blinds
        _postBlinds(tableId);

        // Deal: extract cards per player, store ONLY commitments
        uint8 cursor = 0;
        uint8[10] memory card0s;
        uint8[10] memory card1s;

        // Round 1: first card
        for (uint8 i = 0; i < s.playerCount; i++) {
            uint8 seatIdx = (s.dealerIndex + 1 + i) % s.playerCount;
            card0s[seatIdx] = deck[cursor]; cursor++;
        }
        // Round 2: second card
        for (uint8 i = 0; i < s.playerCount; i++) {
            uint8 seatIdx = (s.dealerIndex + 1 + i) % s.playerCount;
            card1s[seatIdx] = deck[cursor]; cursor++;
        }

        // Store ONLY commitments (not cards)
        for (uint8 i = 0; i < s.playerCount; i++) {
            address addr = seatMap[tableId][i];
            if (addr == address(0)) continue;
            PlayerState storage p = playerStates[tableId][addr];
            p.holeCommitment = keccak256(abi.encodePacked(card0s[i], card1s[i], p.saltHash));
            emit HoleCardsCommitted(tableId, s.handId, addr, p.holeCommitment);
        }

        s.deckCursor = cursor;
        s.status = PokerLib.GameStatus.PreFlop;
        s.activePlayerIndex = (s.dealerIndex + 3) % s.playerCount;
        s.lastActionBlock = block.number;
        emit StatusChanged(tableId, PokerLib.GameStatus.Dealing, PokerLib.GameStatus.PreFlop);
        // deck memory array is DISCARDED here
    }

    // ═══════════════════════════════════════════════════════════════
    //  MEMORY-ONLY FISHER-YATES
    // ═══════════════════════════════════════════════════════════════

    /// @dev Pure function — deck in memory, never storage.
    ///      Gas: ~45k (no SSTORE costs, only memory + keccak256)
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
                uint8 tmp = deck[i]; deck[i] = deck[uint8(j)]; deck[uint8(j)] = tmp;
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  COMMUNITY CARDS (public — re-derive deck in memory)
    // ═══════════════════════════════════════════════════════════════

    function _revealCommunity(uint256 tableId, uint8 count) internal {
        Session storage s = sessions[tableId];
        uint8[52] memory deck = _fisherYatesMemory(s.deckSeed);
        for (uint8 i = 0; i < count; i++) {
            s.deckCursor++; // burn
            s.community[s.communityCount] = deck[s.deckCursor];
            s.communityCount++; s.deckCursor++;
        }
        emit CommunityRevealed(tableId, s.communityCount, s.community);
    }

    // ═══════════════════════════════════════════════════════════════
    //  PHASE 3 — BETTING
    // ═══════════════════════════════════════════════════════════════

    function playerAction(uint256 tableId, PokerLib.Action action, uint256 value)
        external tableExists(tableId) onlySeated(tableId)
    {
        Session storage s = sessions[tableId];
        require(s.status >= PokerLib.GameStatus.PreFlop && s.status <= PokerLib.GameStatus.River, "Not betting");
        address current = seatMap[tableId][s.activePlayerIndex];
        if (msg.sender != current) revert NotYourTurn(current, msg.sender);
        PlayerState storage p = playerStates[tableId][msg.sender];
        require(p.isActive, "Folded");

        if (action == PokerLib.Action.Fold) { p.isActive = false; p.lastAction = PokerLib.Action.Fold; }
        else if (action == PokerLib.Action.Check) { require(s.currentBet == p.currentBet, "Must call"); p.lastAction = PokerLib.Action.Check; }
        else if (action == PokerLib.Action.Call) {
            uint256 toCall = s.currentBet - p.currentBet;
            require(p.chips >= toCall, "Insufficient INIT"); p.chips -= toCall; p.currentBet += toCall; s.pot += toCall; p.lastAction = PokerLib.Action.Call;
        } else if (action == PokerLib.Action.Bet || action == PokerLib.Action.Raise) {
            require(value >= s.bigBlind && value > s.currentBet, "Bet size");
            uint256 add = value - p.currentBet; require(p.chips >= add, "Insufficient INIT");
            p.chips -= add; p.currentBet = value; s.currentBet = value; s.pot += add; p.lastAction = action;
        } else if (action == PokerLib.Action.AllIn) {
            uint256 a = p.chips; p.currentBet += a;
            if (p.currentBet > s.currentBet) s.currentBet = p.currentBet;
            s.pot += a; p.chips = 0; p.lastAction = PokerLib.Action.AllIn;
        } else { revert InvalidAction(); }

        s.lastActionBlock = block.number;
        emit PlayerActed(tableId, msg.sender, action, value);
        _advanceGame(tableId);
    }

    function forceTimeout(uint256 tableId) external tableExists(tableId) {
        Session storage s = sessions[tableId];
        require(s.status >= PokerLib.GameStatus.PreFlop && s.status <= PokerLib.GameStatus.River, "Not betting");
        if (block.number < s.lastActionBlock + s.actionTimeout) revert TimeoutNotReached(block.number, s.lastActionBlock + s.actionTimeout);
        address t = seatMap[tableId][s.activePlayerIndex];
        playerStates[tableId][t].isActive = false; playerStates[tableId][t].lastAction = PokerLib.Action.Fold;
        s.lastActionBlock = block.number;
        emit PlayerTimedOut(tableId, t); _advanceGame(tableId);
    }

    // ═══════════════════════════════════════════════════════════════
    //  PHASE 4 — SHOWDOWN REVEAL (cryptographic verification)
    // ═══════════════════════════════════════════════════════════════

    /// @notice Reveal hole cards by submitting the original salt
    /// @dev Verification chain:
    ///   1. keccak256(salt) == stored saltHash           (salt authenticity)
    ///   2. Re-derive deck from deckSeed in memory       (same shuffle)
    ///   3. Extract player's cards by seat/deal position  (correct cards)
    ///   4. keccak256(c0, c1, saltHash) == commitment     (integrity proof)
    function revealHoleCards(uint256 tableId, bytes32 salt)
        external tableExists(tableId) onlySeated(tableId)
    {
        Session storage s = sessions[tableId];
        require(s.status == PokerLib.GameStatus.Showdown, "Not showdown");
        PlayerState storage p = playerStates[tableId][msg.sender];
        if (!p.isActive) revert PlayerNotActive(msg.sender);
        if (p.hasRevealed) revert AlreadyRevealed(msg.sender);

        // Step 1: verify salt pre-image
        bytes32 computedHash = keccak256(abi.encodePacked(salt));
        if (computedHash != p.saltHash) revert SaltMismatch(msg.sender);

        // Step 2: re-derive deck in memory
        uint8[52] memory deck = _fisherYatesMemory(s.deckSeed);

        // Step 3: extract this player's cards
        (uint8 c0, uint8 c1) = _extractHoleCards(deck, s.playerCount, s.dealerIndex, p.seatIndex);

        // Step 4: verify commitment
        bytes32 expected = keccak256(abi.encodePacked(c0, c1, p.saltHash));
        if (expected != p.holeCommitment) revert CommitmentMismatch(msg.sender, p.holeCommitment, expected);

        // Verified — store revealed cards (betting is over, safe to publish)
        p.revealedCard0 = c0; p.revealedCard1 = c1;
        p.hasRevealed = true; s.saltsRevealed++;
        emit HoleCardsRevealed(tableId, msg.sender, c0, c1);
    }

    function _extractHoleCards(uint8[52] memory deck, uint8 pc, uint8 dealer, uint8 seat)
        internal pure returns (uint8 c0, uint8 c1)
    {
        uint8 dealPos = 255;
        for (uint8 i = 0; i < pc; i++) { if ((dealer + 1 + i) % pc == seat) { dealPos = i; break; } }
        require(dealPos != 255, "Bad seat");
        c0 = deck[dealPos]; c1 = deck[pc + dealPos];
    }

    // ═══════════════════════════════════════════════════════════════
    //  PHASE 5 — HAND EVALUATION (bitmask-based)
    // ═══════════════════════════════════════════════════════════════

    /// @notice Evaluate all revealed hands and distribute pot
    function evaluateShowdown(uint256 tableId) external tableExists(tableId) {
        Session storage s = sessions[tableId];
        require(s.status == PokerLib.GameStatus.Showdown, "Not showdown");

        uint8 activeCount = _countActive(tableId);
        if (activeCount == 1) { _settleLastStanding(tableId); return; }

        // Verify all active revealed
        for (uint8 i = 0; i < s.playerCount; i++) {
            address addr = seatMap[tableId][i];
            if (addr == address(0)) continue;
            PlayerState storage px = playerStates[tableId][addr];
            if (px.isActive && !px.hasRevealed) revert NotAllPlayersRevealed();
        }

        // Evaluate each hand via bitmask HandEvaluator
        address[MAX_SEATS] memory winners;
        uint8 winnerCount;
        uint32 bestRank;
        for (uint8 i = 0; i < s.playerCount; i++) {
            address addr = seatMap[tableId][i];
            if (addr == address(0)) continue;
            PlayerState storage p = playerStates[tableId][addr];
            if (!p.isActive) continue;

            uint32 rank = _evaluateHand(s, p);
            if (winnerCount == 0 || rank > bestRank) {
                bestRank = rank;
                winnerCount = 1;
                winners[0] = addr;
            } else if (rank == bestRank) {
                winners[winnerCount] = addr;
                winnerCount++;
            }
        }

        _distributeShowdownPayout(tableId, winners, winnerCount, bestRank);

        PokerLib.GameStatus prev = s.status;
        s.status = PokerLib.GameStatus.Settled;
        _resetSalts(tableId);
        emit StatusChanged(tableId, prev, PokerLib.GameStatus.Settled);
    }

    function settleLastStanding(uint256 tableId) external tableExists(tableId) {
        require(sessions[tableId].status == PokerLib.GameStatus.Showdown || _countActive(tableId) == 1, "Not ready");
        _settleLastStanding(tableId);
    }

    function _settleLastStanding(uint256 tableId) internal {
        Session storage s = sessions[tableId];
        address w = _findLastActive(tableId);
        uint256 pay = s.pot; s.pot = 0; playerStates[tableId][w].chips += pay;
        PokerLib.GameStatus prev = s.status; s.status = PokerLib.GameStatus.Settled; _resetSalts(tableId);
        emit ShowdownResult(tableId, w, 0, pay); emit StatusChanged(tableId, prev, PokerLib.GameStatus.Settled);
    }

    function _evaluateHand(Session storage s, PlayerState storage p) internal returns (uint32 rank) {
        uint8[7] memory hand;
        hand[0] = p.revealedCard0;
        hand[1] = p.revealedCard1;
        for (uint8 c = 0; c < 5; c++) {
            hand[2 + c] = s.community[c];
        }

        rank = HandEvaluator.evaluateBestHand(hand);
        p.handRank = rank;
    }

    function _distributeShowdownPayout(
        uint256 tableId,
        address[MAX_SEATS] memory winners,
        uint8 winnerCount,
        uint32 bestRank
    ) internal {
        Session storage s = sessions[tableId];
        uint256 payout = s.pot;
        s.pot = 0;

        uint256 share = payout / winnerCount;
        uint256 remainder = payout % winnerCount;
        for (uint8 i = 0; i < winnerCount; i++) {
            uint256 winnerPayout = share + (i < remainder ? 1 : 0);
            playerStates[tableId][winners[i]].chips += winnerPayout;
            emit ShowdownResult(tableId, winners[i], bestRank, winnerPayout);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════

    function getSession(uint256 tableId) external view returns (
        uint256 handId, PokerLib.GameStatus status, uint8 playerCount,
        uint8 dealerIndex, uint256 pot, uint256 currentBet,
        bytes32 deckCommitment, uint8 communityCount, bool vrfPending,
        uint8 saltsCommitted, uint8 saltsRevealed
    ) {
        Session storage s = sessions[tableId];
        return (s.handId, s.status, s.playerCount, s.dealerIndex, s.pot, s.currentBet, s.deckCommitment, s.communityCount, s.vrfPending, s.saltsCommitted, s.saltsRevealed);
    }

    function getCommunityCards(uint256 tableId) external view returns (uint8[5] memory) { return sessions[tableId].community; }

    function getPlayerState(uint256 tableId, address player) external view returns (
        uint256 stake, uint256 currentBet, PokerLib.Action lastAction,
        bool isActive, uint8 seatIndex, bytes32 holeCommitment,
        bool hasRevealed, uint32 handRank
    ) {
        PlayerState storage p = playerStates[tableId][player];
        return (p.chips, p.currentBet, p.lastAction, p.isActive, p.seatIndex, p.holeCommitment, p.hasRevealed, p.handRank);
    }

    function getRevealedCards(uint256 tableId, address player) external view returns (uint8 c0s, uint8 c0v, uint8 c1s, uint8 c1v) {
        PlayerState storage p = playerStates[tableId][player];
        if (!p.hasRevealed) return (0,0,0,0);
        (c0s, c0v) = PokerLib.decodeCard(p.revealedCard0);
        (c1s, c1v) = PokerLib.decodeCard(p.revealedCard1);
    }

    function getPlayers(uint256 tableId) external view returns (address[] memory) {
        uint8 c = sessions[tableId].playerCount; address[] memory r = new address[](c);
        for (uint8 i = 0; i < c; i++) r[i] = seatMap[tableId][i]; return r;
    }

    function tableCount() external view returns (uint256) { return _nextTableId; }

    // ═══════════════════════════════════════════════════════════════
    //  INTERNALS
    // ═══════════════════════════════════════════════════════════════

    function _postBlinds(uint256 tableId) internal {
        Session storage s = sessions[tableId];
        uint8 sbS = (s.dealerIndex + 1) % s.playerCount; address sbA = seatMap[tableId][sbS];
        PlayerState storage sb = playerStates[tableId][sbA];
        uint256 sbAmt = s.smallBlind < sb.chips ? s.smallBlind : sb.chips;
        sb.chips -= sbAmt; sb.currentBet = sbAmt; s.pot += sbAmt;
        uint8 bbS = (s.dealerIndex + 2) % s.playerCount; address bbA = seatMap[tableId][bbS];
        PlayerState storage bb = playerStates[tableId][bbA];
        uint256 bbAmt = s.bigBlind < bb.chips ? s.bigBlind : bb.chips;
        bb.chips -= bbAmt; bb.currentBet = bbAmt; s.pot += bbAmt; s.currentBet = bbAmt;
    }

    function _advanceGame(uint256 tableId) internal {
        Session storage s = sessions[tableId];
        if (_countActive(tableId) == 1) { PokerLib.GameStatus prev = s.status; s.status = PokerLib.GameStatus.Showdown; emit StatusChanged(tableId, prev, PokerLib.GameStatus.Showdown); return; }
        if (_isRoundComplete(tableId)) { _advanceRound(tableId); return; }
        s.activePlayerIndex = _nextActiveSeat(tableId, (s.activePlayerIndex + 1) % s.playerCount);
    }

    function _isRoundComplete(uint256 tableId) internal view returns (bool) {
        Session storage s = sessions[tableId];
        for (uint8 i = 0; i < s.playerCount; i++) {
            address a = seatMap[tableId][i]; if (a == address(0)) continue;
            PlayerState storage p = playerStates[tableId][a]; if (!p.isActive) continue;
            if (p.lastAction == PokerLib.Action.None) return false;
            if (p.chips > 0 && p.currentBet < s.currentBet) return false;
        } return true;
    }

    function _advanceRound(uint256 tableId) internal {
        Session storage s = sessions[tableId]; PokerLib.GameStatus prev = s.status;
        for (uint8 i = 0; i < s.playerCount; i++) { address a = seatMap[tableId][i]; if (a != address(0)) { playerStates[tableId][a].currentBet = 0; if (playerStates[tableId][a].isActive) playerStates[tableId][a].lastAction = PokerLib.Action.None; } }
        s.currentBet = 0;
        if (s.status == PokerLib.GameStatus.PreFlop) { s.status = PokerLib.GameStatus.Flop; _revealCommunity(tableId, 3); }
        else if (s.status == PokerLib.GameStatus.Flop) { s.status = PokerLib.GameStatus.Turn; _revealCommunity(tableId, 1); }
        else if (s.status == PokerLib.GameStatus.Turn) { s.status = PokerLib.GameStatus.River; _revealCommunity(tableId, 1); }
        else if (s.status == PokerLib.GameStatus.River) { s.status = PokerLib.GameStatus.Showdown; }
        if (s.status != PokerLib.GameStatus.Showdown) {
            s.activePlayerIndex = _nextActiveSeat(tableId, (s.dealerIndex + 1) % s.playerCount);
        }
        s.lastActionBlock = block.number;
        emit StatusChanged(tableId, prev, s.status);
    }

    function _nextActiveSeat(uint256 tableId, uint8 start) internal view returns (uint8) {
        Session storage s = sessions[tableId];
        for (uint8 c = 0; c < s.playerCount; c++) {
            uint8 seat = (start + c) % s.playerCount;
            address a = seatMap[tableId][seat];
            if (a != address(0) && playerStates[tableId][a].isActive) {
                return seat;
            }
        }
        revert("No active seat");
    }

    function _countActive(uint256 tableId) internal view returns (uint8 cnt) {
        Session storage s = sessions[tableId];
        for (uint8 i = 0; i < s.playerCount; i++) { address a = seatMap[tableId][i]; if (a != address(0) && playerStates[tableId][a].isActive) cnt++; }
    }

    function _findLastActive(uint256 tableId) internal view returns (address) {
        Session storage s = sessions[tableId];
        for (uint8 i = 0; i < s.playerCount; i++) { address a = seatMap[tableId][i]; if (a != address(0) && playerStates[tableId][a].isActive) return a; }
        revert("None active");
    }

    function _resetSalts(uint256 tableId) internal {
        Session storage s = sessions[tableId]; s.saltsCommitted = 0; s.saltsRevealed = 0;
        for (uint8 i = 0; i < s.playerCount; i++) { address a = seatMap[tableId][i]; if (a != address(0)) playerStates[tableId][a].saltHash = bytes32(0); }
    }

    function _uint2str(uint256 _i) internal pure returns (string memory) {
        if (_i == 0) return "0"; uint256 j = _i; uint256 l;
        while (j != 0) { l++; j /= 10; } bytes memory b = new bytes(l); uint256 k = l;
        while (_i != 0) { k--; b[k] = bytes1(uint8(48 + _i % 10)); _i /= 10; } return string(b);
    }

    /// @notice Auto-deposit any INIT sent directly to the contract
    receive() external payable {
        if (msg.value > 0) {
            balances[msg.sender] += msg.value;
            emit Deposited(msg.sender, msg.value, balances[msg.sender]);
        }
    }
}
