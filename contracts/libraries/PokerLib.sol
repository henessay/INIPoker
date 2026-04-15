// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title PokerLib — On-chain card encoding and game types
/// @notice Replaces deck/deck.go Card/Suit/Deck types with gas-efficient packed encoding
/// @dev Each card = 1 byte: upper 2 bits = suit (0-3), lower 4 bits = value (1-13)
///      Full 52-card deck fits in 2 EVM storage slots (52 bytes < 64 bytes)
library PokerLib {

    // ─── Errors ──────────────────────────────────────────────────────────
    error InvalidCard(uint8 encoded);
    error InvalidSuit(uint8 suit);
    error InvalidValue(uint8 value);
    error DeckExhausted();

    // ─── Card Encoding ───────────────────────────────────────────────────
    // Mirrors deck.Suit enum: Spades=0, Hearts=1, Diamonds=2, Clubs=3
    uint8 constant SPADES   = 0;
    uint8 constant HEARTS   = 1;
    uint8 constant DIAMONDS = 2;
    uint8 constant CLUBS    = 3;

    // Value range: 1 (Ace) through 13 (King)
    // Matches deck.Card.Value exactly
    uint8 constant ACE   = 1;
    uint8 constant JACK  = 11;
    uint8 constant QUEEN = 12;
    uint8 constant KING  = 13;

    /// @notice Encode a card into a single byte
    /// @dev Resolves DECK-003: [52]Card array → packed uint8 encoding
    function encodeCard(uint8 suit, uint8 value) internal pure returns (uint8) {
        if (suit > 3) revert InvalidSuit(suit);
        if (value == 0 || value > 13) revert InvalidValue(value);
        return (suit << 4) | value;
    }

    /// @notice Decode a card byte into suit and value
    function decodeCard(uint8 encoded) internal pure returns (uint8 suit, uint8 value) {
        suit = encoded >> 4;
        value = encoded & 0x0F;
        if (suit > 3 || value == 0 || value > 13) revert InvalidCard(encoded);
    }

    // ─── Game Status (mirrors p2p.GameStatus) ────────────────────────────
    enum GameStatus {
        Waiting,    // 0 — table open, accepting players
        Dealing,    // 1 — deck committed, cards being dealt
        PreFlop,    // 2 — hole cards dealt, first betting round
        Flop,       // 3 — 3 community cards revealed
        Turn,       // 4 — 4th community card revealed
        River,      // 5 — 5th community card revealed
        Showdown,   // 6 — (NEW) hand evaluation & pot distribution
        Settled     // 7 — (NEW) pot paid, ready for next hand
    }

    // ─── Player Action (mirrors p2p.PlayerAction) ────────────────────────
    enum Action {
        None,       // 0 — no action yet
        Fold,       // 1 — matches PlayerActionFold
        Check,      // 2 — matches PlayerActionCheck
        Bet,        // 3 — matches PlayerActionBet
        Call,       // 4 — (NEW) match current bet
        Raise,      // 5 — (NEW) increase current bet
        AllIn       // 6 — (NEW) bet entire stack
    }

    // ─── Player State ────────────────────────────────────────────────────
    struct Player {
        address addr;
        uint256 chips;          // chip balance at table
        uint256 currentBet;     // bet in current round
        Action  lastAction;
        bool    isActive;       // still in the hand (not folded)
        bool    isSeated;       // seated at table
        uint8   seatIndex;      // 0-9 seat position
    }

    // ─── Table State (replaces proto.TableState) ─────────────────────────
    /// @dev Resolves PROTO-003: adds tableId for concurrent games
    struct Table {
        // Identity
        uint256     tableId;
        uint8       maxPlayers;         // 2-10
        uint256     minBuyIn;
        uint256     maxBuyIn;

        // Game state (replaces p2p.GameState fields)
        GameStatus  status;
        uint8       dealerIndex;        // replaces HasDealer bool
        uint8       currentPlayerIndex;
        uint8       playerCount;

        // Economics
        uint256     pot;                // total pot (actual tokens held)
        uint256     currentBet;         // current bet to match
        uint256     smallBlind;
        uint256     bigBlind;

        // Deck commitment (replaces proto.EncDeck)
        bytes32     deckSeed;           // VRF output for shuffle
        bytes32     deckCommitment;     // hash of full encrypted deck

        // Timing (resolves P2P-006: no timeout enforcement)
        uint256     lastActionBlock;    // block number of last action
        uint256     actionTimeout;      // blocks before auto-fold

        // Round tracking
        uint8       currentRound;       // how many rounds of betting
        uint8       communityCount;     // 0, 3 (flop), 4 (turn), 5 (river)
    }

    // ─── Hand Rank (for showdown evaluation) ─────────────────────────────
    enum HandRank {
        HighCard,
        OnePair,
        TwoPair,
        ThreeOfAKind,
        Straight,
        Flush,
        FullHouse,
        FourOfAKind,
        StraightFlush,
        RoyalFlush
    }

    /// @notice Pack 5 community cards into a single bytes32
    function packCommunityCards(uint8[5] memory cards) internal pure returns (bytes32) {
        bytes32 packed;
        for (uint i = 0; i < 5; i++) {
            packed |= bytes32(uint256(cards[i])) << (248 - i * 8);
        }
        return packed;
    }

    /// @notice Unpack community cards from bytes32
    function unpackCommunityCard(bytes32 packed, uint8 index) internal pure returns (uint8) {
        return uint8(uint256(packed >> (248 - uint256(index) * 8)));
    }
}
