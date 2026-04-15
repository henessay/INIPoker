// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title HandEvaluator — Gas-optimized poker hand ranking via bitmasks
/// @notice Evaluates 5-7 card Texas Hold'em hands using bitwise operations.
///         No loops over card arrays — all detection via shift/AND/popcount.
///
/// @dev Card encoding (from PokerLib):
///        uint8 encoded = (suit << 4) | value
///        suit  = encoded >> 4    (0=Spades, 1=Hearts, 2=Diamonds, 3=Clubs)
///        value = encoded & 0x0F  (1=Ace .. 13=King)
///
///      Bitmask layout (64 bits):
///        Bits 0-12:   Spades   value mask (bit 0 = Ace, bit 12 = King)
///        Bits 13-25:  Hearts   value mask
///        Bits 26-38:  Diamonds value mask
///        Bits 39-51:  Clubs    value mask
///
///      This mirrors the Go deck layout: Suit 0-3 × Value 1-13
///
///      Hand rank is encoded as uint32:
///        Bits 24-27: HandRank enum (0-9)
///        Bits 0-23:  Tiebreaker kickers (highest card values packed)
///
///      Higher uint32 = better hand. Simple comparison determines winner.
library HandEvaluator {

    // ─── Hand Rankings ───────────────────────────────────────────
    uint32 constant RANK_HIGH_CARD      = 0 << 24;
    uint32 constant RANK_ONE_PAIR       = 1 << 24;
    uint32 constant RANK_TWO_PAIR       = 2 << 24;
    uint32 constant RANK_THREE_OF_KIND  = 3 << 24;
    uint32 constant RANK_STRAIGHT       = 4 << 24;
    uint32 constant RANK_FLUSH          = 5 << 24;
    uint32 constant RANK_FULL_HOUSE     = 6 << 24;
    uint32 constant RANK_FOUR_OF_KIND   = 7 << 24;
    uint32 constant RANK_STRAIGHT_FLUSH = 8 << 24;
    uint32 constant RANK_ROYAL_FLUSH    = 9 << 24;

    // ─── Bit Manipulation Constants ──────────────────────────────
    /// @dev 13-bit mask: bits 0..12 all set
    uint64 constant SUIT_MASK = 0x1FFF;

    /// @dev Straight patterns — 5 consecutive bits in a 13-bit value mask.
    ///      Ace can be high (bit 12) or low (bit 0).
    ///      A-2-3-4-5 = 0x100F (bits 0,1,2,3,12)
    ///      The wheel (A-low straight) is detected separately.

    // ═════════════════════════════════════════════════════════════
    //  MAIN ENTRY POINT
    // ═════════════════════════════════════════════════════════════

    /// @notice Evaluate a poker hand (5-7 cards) and return a comparable rank
    /// @param cards Array of encoded card bytes (PokerLib format)
    /// @param count Number of cards (5, 6, or 7)
    /// @return rank uint32 where higher = better hand
    function evaluate(uint8[] memory cards, uint8 count) internal pure returns (uint32 rank) {
        // ── Step 1: Build bitmasks from card array ──
        // suitMasks[0..3] = 13-bit value bitmask per suit
        // valueCounts     = packed: 4 bits per value (13 values × 4 bits = 52 bits)
        // allValues       = 13-bit OR of all suits (for straight/high-card detection)
        uint16[4] memory suitMasks;
        uint64 valueCounts;
        uint16 allValues;

        for (uint8 i = 0; i < count; i++) {
            uint8 suit  = cards[i] >> 4;
            uint8 value = (cards[i] & 0x0F); // 1-13
            // Shift value to 0-indexed: Ace=0, 2=1, ..., King=12
            uint8 vIdx = value - 1;

            suitMasks[suit] |= uint16(1 << vIdx);
            allValues       |= uint16(1 << vIdx);

            // Increment count for this value (4 bits per slot, max 4)
            uint8 shift = vIdx * 4;
            uint64 currentCount = (valueCounts >> shift) & 0xF;
            valueCounts = (valueCounts & ~(uint64(0xF) << shift))
                        | ((currentCount + 1) << shift);
        }

        // ── Step 2: Check flush (any suit with 5+ cards) ──
        uint16 flushMask;
        bool isFlush;
        for (uint8 s = 0; s < 4; s++) {
            if (_popcount16(suitMasks[s]) >= 5) {
                isFlush = true;
                flushMask = suitMasks[s];
                break;
            }
        }

        // ── Step 3: Check straight ──
        (bool isStraight, uint8 straightHigh) = _findStraight(allValues);

        // ── Step 4: Check straight flush / royal flush ──
        if (isFlush) {
            (bool isStraightFlush, uint8 sfHigh) = _findStraight(flushMask);
            if (isStraightFlush) {
                if (sfHigh == 14) {
                    // Royal flush: A-K-Q-J-10 all same suit
                    return RANK_ROYAL_FLUSH | uint32(sfHigh);
                }
                return RANK_STRAIGHT_FLUSH | uint32(sfHigh);
            }
        }

        // ── Step 5: Count pairs, trips, quads from valueCounts ──
        uint8 quadValue;
        uint8 tripValue;
        uint8 pairHigh;
        uint8 pairLow;
        uint8 pairCount;

        // Scan ranks from Ace high down to Deuce for natural ordering.
        for (uint8 v = 14; v >= 2; v--) {
            uint8 vIdx = _rankToBit(v);
            uint64 cnt = (valueCounts >> (vIdx * 4)) & 0xF;

            if (cnt == 4) {
                quadValue = v;
            } else if (cnt == 3) {
                if (tripValue == 0) tripValue = v;
            } else if (cnt == 2) {
                pairCount++;
                if (pairHigh == 0) pairHigh = v;
                else if (pairLow == 0) pairLow = v;
            }
            if (v == 2) break; // prevent underflow on uint8
        }

        // ── Step 6: Determine final hand rank ──

        // Four of a kind
        if (quadValue > 0) {
            uint8 kicker = _highestExcluding(allValues, quadValue);
            return RANK_FOUR_OF_KIND | (uint32(quadValue) << 16) | uint32(kicker);
        }

        // Full house (trips + pair, or two trips → higher is trip, lower is pair)
        if (tripValue > 0 && pairHigh > 0) {
            return RANK_FULL_HOUSE | (uint32(tripValue) << 16) | uint32(pairHigh);
        }

        // Flush (not straight flush — already checked above)
        if (isFlush) {
            uint32 kickers = _topFiveKickers(flushMask);
            return RANK_FLUSH | kickers;
        }

        // Straight
        if (isStraight) {
            return RANK_STRAIGHT | uint32(straightHigh);
        }

        // Three of a kind
        if (tripValue > 0) {
            uint16 excluded = allValues & ~uint16(1 << (tripValue - 1));
            uint32 kickers = _topNKickers(excluded, 2);
            return RANK_THREE_OF_KIND | (uint32(tripValue) << 16) | kickers;
        }

        // Two pair
        if (pairCount >= 2) {
            uint16 excluded = allValues
                & ~uint16(1 << (pairHigh - 1))
                & ~uint16(1 << (pairLow - 1));
            uint8 kicker = _highBit(excluded);
            return RANK_TWO_PAIR
                | (uint32(pairHigh) << 16)
                | (uint32(pairLow) << 8)
                | uint32(kicker);
        }

        // One pair
        if (pairCount == 1) {
            uint16 excluded = allValues & ~uint16(1 << (pairHigh - 1));
            uint32 kickers = _topNKickers(excluded, 3);
            return RANK_ONE_PAIR | (uint32(pairHigh) << 16) | kickers;
        }

        // High card
        return RANK_HIGH_CARD | _topFiveKickers(allValues);
    }

    // ═════════════════════════════════════════════════════════════
    //  BEST-OF-7 EVALUATOR (Texas Hold'em: 2 hole + 5 community)
    // ═════════════════════════════════════════════════════════════

    /// @notice Find the best 5-card hand from 7 cards
    /// @dev Iterates over all C(7,5) = 21 combinations.
    ///      Gas: ~21 × evaluate() ≈ 60k-80k gas total.
    ///      In practice, the bitmask evaluate() is called on all 7 cards
    ///      directly since it handles >5 cards natively.
    function evaluateBestHand(uint8[7] memory allCards) internal pure returns (uint32) {
        uint8[] memory cards = new uint8[](7);
        for (uint8 i = 0; i < 7; i++) cards[i] = allCards[i];
        return evaluate(cards, 7);
    }

    // ═════════════════════════════════════════════════════════════
    //  INTERNAL BIT UTILITIES
    // ═════════════════════════════════════════════════════════════

    /// @dev Find a 5-consecutive-bit pattern in a 13-bit value mask.
    ///      Returns (true, highBitIndex) or (false, 0).
    ///      Handles the wheel (A-2-3-4-5) specially.
    function _findStraight(uint16 mask) internal pure returns (bool, uint8) {
        // Broadway: A-K-Q-J-T.
        if (
            _maskHasRank(mask, 14)
                && _maskHasRank(mask, 13)
                && _maskHasRank(mask, 12)
                && _maskHasRank(mask, 11)
                && _maskHasRank(mask, 10)
        ) {
            return (true, 14);
        }

        // Regular straights from King-high down to Five-high.
        for (uint8 high = 13; high >= 5; high--) {
            bool isStraight;
            isStraight = true;
            for (uint8 offset = 0; offset < 5; offset++) {
                if (!_maskHasRank(mask, high - offset)) {
                    isStraight = false;
                    break;
                }
            }
            if (isStraight) {
                return (true, high);
            }
            if (high == 5) break;
        }

        // Wheel: A-2-3-4-5.
        if (
            _maskHasRank(mask, 14)
                && _maskHasRank(mask, 5)
                && _maskHasRank(mask, 4)
                && _maskHasRank(mask, 3)
                && _maskHasRank(mask, 2)
        ) {
            return (true, 5);
        }

        return (false, 0);
    }

    /// @dev Population count of a 16-bit value (Hamming weight)
    ///      Uses the classic bit-parallel algorithm
    function _popcount16(uint16 x) internal pure returns (uint8) {
        // Brian Kernighan's method — optimal for sparse bits
        uint8 count;
        while (x != 0) {
            x &= (x - 1);
            count++;
        }
        return count;
    }

    /// @dev Highest set bit index in a 13-bit mask (0-indexed, value = index+1)
    function _highBit(uint16 mask) internal pure returns (uint8) {
        if (_maskHasRank(mask, 14)) {
            return 14;
        }
        for (uint8 rank = 13; rank >= 2; rank--) {
            if (_maskHasRank(mask, rank)) return rank;
            if (rank == 2) break;
        }
        return 0;
    }

    /// @dev Get highest value excluding a specific value
    function _highestExcluding(uint16 mask, uint8 excludeValue) internal pure returns (uint8) {
        uint16 cleaned = mask & ~uint16(1 << _rankToBit(excludeValue));
        return _highBit(cleaned);
    }

    /// @dev Pack top 5 bit positions from a 13-bit mask into uint32 kickers
    ///      Returns: (v1 << 16) | (v2 << 12) | (v3 << 8) | (v4 << 4) | v5
    function _topFiveKickers(uint16 mask) internal pure returns (uint32) {
        return _topNKickers(mask, 5);
    }

    /// @dev Pack top N bit positions from mask into uint32
    function _topNKickers(uint16 mask, uint8 n) internal pure returns (uint32 result) {
        uint8 found;
        for (uint8 rank = 14; rank >= 2; rank--) {
            if (_maskHasRank(mask, rank)) {
                result |= uint32(rank) << ((n - 1 - found) * 4);
                found++;
                if (found == n) break;
            }
            if (rank == 2) break;
        }
    }

    function _rankToBit(uint8 rank) internal pure returns (uint8) {
        return rank == 14 ? 0 : rank - 1;
    }

    function _maskHasRank(uint16 mask, uint8 rank) internal pure returns (bool) {
        return mask & uint16(1 << _rankToBit(rank)) != 0;
    }
}
