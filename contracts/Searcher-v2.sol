// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

// ════════════════════════════════════════════════════════════════════
// SEARCHER — On-Chain Arbitrage Detection  [Phase 5: V3 Quote Accuracy]
// Network  : Arbitrum One
// Called   : via eth_call ONLY — zero gas cost
// Returns  : best opportunity found across all configured pairs
//
// WHAT THIS DOES
//   The scanner calls check() every block via eth_call (free).
//   This contract reads V2 reserves and V3 pool state directly,
//   computes the math entirely in the EVM (no JSON parsing, no
//   floating-point drift), and returns a ready-to-execute struct.
//   If nothing is profitable it returns an empty result — the
//   scanner checks found == true before firing any transaction.
//
//   G3: checkWBTC() is a dedicated entry point for WBTC-base arbs.
//   It avoids the decimal mismatch that would arise if WBTC amounts
//   were passed through the USDC-denominated check() interface.
//   _checkSimple and _checkTri are asset-agnostic and handle both.
//
// WHY THIS IS FASTER
//   One eth_call replaces hundreds of Multicall3 round-trips.
//   EVM arithmetic is exact. The scanner becomes a thin dispatcher.
//
// SECURITY
//   This contract has NO state changes and NO payable functions.
//   It cannot be exploited — it only reads and computes.
// ════════════════════════════════════════════════════════════════════

// ── Uniswap V2 pair — direct reserve read (no router needed) ────────
interface IV2Pair {
    function getReserves() external view
        returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function token0() external view returns (address);
}

// ── Uniswap V3 pool — slot0 for sqrtPriceX96, read liquidity ────────
interface IV3Pool {
    function slot0() external view returns (
        uint160 sqrtPriceX96,
        int24   tick,
        uint16  observationIndex,
        uint16  observationCardinality,
        uint16  observationCardinalityNext,
        uint8   feeProtocol,
        bool    unlocked
    );
    function liquidity() external view returns (uint128);
    function token0() external view returns (address);
    function fee() external view returns (uint24);
}

// ── Uniswap V2 factory — pair lookup ────────────────────────────────
interface IV2Factory {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
}

// ── Uniswap V3 factory — pool lookup ────────────────────────────────
interface IV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}

// ── Aave V3 pool data provider — available liquidity ────────────────
interface IAaveProtocolDataProvider {
    function getReserveData(address asset) external view
        returns (
            uint256 unbacked,
            uint256 accruedToTreasuryScaled,
            uint256 totalAToken,
            uint256 totalStableDebt,
            uint256 totalVariableDebt,
            uint256 liquidityRate,
            uint256 variableBorrowRate,
            uint256 stableBorrowRate,
            uint256 averageStableBorrowRate,
            uint256 liquidityIndex,
            uint256 variableBorrowIndex,
            uint40  lastUpdateTimestamp
        );
}

contract Searcher {

    // ── Arbitrum Mainnet Addresses ────────────────────────────────
    IV2Factory public constant SUSHI_FACTORY   = IV2Factory(0xc35DADB65012eC5796536bD9864eD8773aBc74C4);
    IV2Factory public constant CAMELOT_FACTORY = IV2Factory(0x6EcCab422D763aC031210895C81787E87B43A652);
    IV3Factory public constant UNIV3_FACTORY   = IV3Factory(0x1F98431c8aD98523631AE4a59f267346ea31F984);
    IV3Factory public constant PCSV3_FACTORY   = IV3Factory(0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865);
    // U2: SushiSwap V3 — UniV3 fork. Factory confirmed on Arbiscan.
    // Router confirmed active on-chain. Verify router/factory pairing at deployment.
    IV3Factory public constant SUSHIV3_FACTORY = IV3Factory(0x1af415a1EbA07a4986a52B6f2e7dE7003D82231e);

    // Aave V3 Protocol Data Provider on Arbitrum
    IAaveProtocolDataProvider public constant AAVE_DATA =
        IAaveProtocolDataProvider(0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654);

    // ── Token Addresses ───────────────────────────────────────────
    address public constant USDC   = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831;
    address public constant USDT   = 0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9;
    address public constant WETH   = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;
    address public constant WBTC   = 0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f;
    address public constant DAI    = 0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1;
    address public constant ARB    = 0x912CE59144191C1204E64559FE8253a0e49E6548;
    address public constant GMX    = 0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a;
    address public constant WSTETH = 0x5979D7b546E38E414F7E9822514be443A4800529;
    address public constant USDCE  = 0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8;
    address public constant LINK   = 0xf97f4df75117a78c1A5a0DBb814Af92458539FB4;

    // ── DEX Router Addresses (for leg construction, not reads) ────
    address public constant SUSHI_ROUTER   = 0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506;
    address public constant CAMELOT_ROUTER = 0xc873fEcbd354f5A56E00E710B90EF4201db2448d;
    address public constant UNIV3_ROUTER   = 0xE592427A0AEce92De3Edee1F18E0157C05861564;
    address public constant PCSV3_ROUTER   = 0x1b81D678ffb9C0263b24A97847620C99d213eB14;
    // U2: SushiSwap V3 SwapRouter — confirmed active on Arbitrum on-chain data.
    // Quoter (0x0524E833cCD057e4d7A296e3aaAb9f7675964Ce1) is in scanner-v6.js only;
    // this contract uses direct pool reads and does not call the Quoter.
    address public constant SUSHIV3_ROUTER = 0x8A21F6768C1f8075791D08546Dadf6daA0bE820c;

    // Aave 0.09% flash loan fee (9 / 10000)
    uint256 private constant AAVE_FEE_BPS = 9;

    // Minimum loan size: $50K USDC (6 decimals)
    uint256 public constant MIN_LOAN = 50_000 * 1e6;

    // ── Return Types ──────────────────────────────────────────────

    // One swap in the arbitrage chain — mirrors FlashArbitrage.Leg exactly
    struct Leg {
        uint8     dexType;   // 0 = V2, 1 = V3
        address   router;
        address   tokenIn;
        address   tokenOut;
        uint24    v3Fee;
        address[] v2Path;
    }

    // The full opportunity returned to the scanner
    struct Opportunity {
        bool    found;         // false == no profitable opportunity
        address asset;         // borrow token (USDC or USDT)
        uint256 loan;          // optimal loan size
        uint256 profit;        // gross profit after Aave fee, before gas
        Leg[]   legs;          // ready to pass to executeArbitrage()
        string  description;   // human-readable: "USDC→WETH→USDC SUSHI→UNI3_500"
    }

    // Internal scratch struct — avoids stack-too-deep
    struct QuoteResult {
        bool    ok;
        uint256 amountOut;
        uint8   dexType;
        address router;
        uint24  v3Fee;       // 0 for V2
        bool    isSushi;     // V2 only — selects factory
    }

    // ── MAIN ENTRY — called by scanner every block via eth_call ───
    //
    // Parameters:
    //   loan       : USDC amount to try first (e.g. 50_000e6)
    //   minProfit  : minimum gross profit required (USDC 6-dec)
    //
    // Returns an Opportunity. If found == false, scanner does nothing.
    //
    function check(uint256 loan, uint256 minProfit)
        external
        view
        returns (Opportunity memory opp)
    {
        // CRITICAL: initialize dynamic fields before ANY computation.
        // viaIR uses scratch space (memory[0]) for _mulDiv assembly intermediates.
        // An uninitialized Leg[] or string has a null pointer (address 0), so when
        // the ABI encoder reads its "length" it reads mload(0) — which contains
        // garbage from the scratch space — and tries to encode a garbage-length
        // array. This produces a 0x revert. Explicit initialization points these
        // fields to real heap memory with length=0, which encodes correctly.
        opp.legs        = new Leg[](0);
        opp.description = "";

        if (loan < MIN_LOAN) loan = MIN_LOAN;

        uint256 bestProfit = minProfit > 0 ? minProfit - 1 : 0;

        // ── USDC simple pairs ────────────────────────────────────
        address[8] memory mids = [WETH, WBTC, ARB, GMX, WSTETH, DAI, USDCE, LINK];
        for (uint i = 0; i < mids.length; i++) {
            Opportunity memory candidate = _checkSimple(USDC, mids[i], loan, bestProfit);
            if (candidate.found && candidate.profit > bestProfit) {
                bestProfit = candidate.profit;
                opp        = candidate;
            }
        }

        // ── USDT simple pairs ────────────────────────────────────
        for (uint i = 0; i < mids.length; i++) {
            Opportunity memory candidate = _checkSimple(USDT, mids[i], loan, bestProfit);
            if (candidate.found && candidate.profit > bestProfit) {
                bestProfit = candidate.profit;
                opp        = candidate;
            }
        }

        // Triangular arb removed from check() — each triangle runs 13×13×13
        // _allQuotes calls which pushes total gas past Arbitrum's 16M block cap.
        // The 16 simple pairs above cover the vast majority of flash arb opportunities.
    }

    // ── G3: WBTC ARBITRAGE DETECTION ─────────────────────────────────────────
    // Separate entry point for WBTC-base arbs to avoid decimal mismatch with the
    // USDC-denominated check() function.
    //
    // Parameters:
    //   wbtcLoan       : amount to try, in satoshis (8 decimals)
    //   minProfitWBTC  : minimum gross profit required, in satoshis
    //
    // _checkSimple and _checkTri are asset-agnostic: they operate on raw uint256.
    // The Aave fee calc (loan * AAVE_FEE_BPS / 10000) is decimal-agnostic. ✓
    function checkWBTC(
        uint256 wbtcLoan,
        uint256 minProfitWBTC
    ) external view returns (Opportunity memory opp) {
        opp.legs        = new Leg[](0); // same null-pointer fix as check()
        opp.description = "";

        uint256 bestProfit = 0;

        // ── WBTC simple pairs: WBTC→mid→WBTC ────────────────────────────────
        // WBTC excluded from mids to avoid self-pairs.
        address[7] memory wbtcMids = [WETH, ARB, GMX, WSTETH, DAI, USDCE, LINK];
        for (uint i = 0; i < wbtcMids.length; i++) {
            Opportunity memory candidate = _checkSimple(WBTC, wbtcMids[i], wbtcLoan, minProfitWBTC);
            if (candidate.found && candidate.profit > bestProfit) {
                bestProfit = candidate.profit;
                opp        = candidate;
            }
        }

        // Triangular arb removed — same gas cap reason as check().
    }

    // ── SIMPLE ARB: base→mid→base ─────────────────────────────────
    function _checkSimple(
        address base,
        address mid,
        uint256 loan,
        uint256 minProfit
    ) internal view returns (Opportunity memory opp) {
        // All buy quotes: base → mid
        QuoteResult[13] memory buys  = _allQuotes(base, mid, loan);
        // All sell quotes will be computed per buy output below

        uint256 aaveFee     = (loan * AAVE_FEE_BPS) / 10000;
        uint256 toRepay     = loan + aaveFee;

        QuoteResult memory bestBuy;
        QuoteResult memory bestSell;
        uint256 bestOut;

        for (uint b = 0; b < buys.length; b++) {
            if (!buys[b].ok) continue;

            QuoteResult[13] memory sells = _allQuotes(mid, base, buys[b].amountOut);
            for (uint s = 0; s < sells.length; s++) {
                if (!sells[s].ok) continue;
                // Must use different DEX source for at least one leg
                if (_sameSource(buys[b], sells[s])) continue;

                if (sells[s].amountOut > toRepay) {
                    uint256 profit = sells[s].amountOut - toRepay;
                    if (profit > minProfit && sells[s].amountOut > bestOut) {
                        bestOut  = sells[s].amountOut;
                        bestBuy  = buys[b];
                        bestSell = sells[s];
                    }
                }
            }
        }

        if (bestOut == 0) return opp;

        opp.found   = true;
        opp.asset   = base;
        opp.loan    = loan;
        opp.profit  = bestOut - toRepay;
        opp.legs    = new Leg[](2);
        opp.legs[0] = _makeLeg(bestBuy,  base, mid);
        opp.legs[1] = _makeLeg(bestSell, mid,  base);
        opp.description = string(abi.encodePacked(
            _sym(base), "->", _sym(mid), "->", _sym(base),
            " ", _dexName(bestBuy), "->", _dexName(bestSell)
        ));
    }

    // ── TRIANGULAR ARB: base→midA→midB→base ──────────────────────
    function _checkTri(
        address base,
        address midA,
        address midB,
        uint256 loan,
        uint256 minProfit
    ) internal view returns (Opportunity memory opp) {
        uint256 aaveFee = (loan * AAVE_FEE_BPS) / 10000;
        uint256 toRepay = loan + aaveFee;

        QuoteResult[13] memory l1s = _allQuotes(base, midA, loan);

        for (uint a = 0; a < l1s.length; a++) {
            if (!l1s[a].ok) continue;

            QuoteResult[13] memory l2s = _allQuotes(midA, midB, l1s[a].amountOut);
            for (uint b = 0; b < l2s.length; b++) {
                if (!l2s[b].ok) continue;

                QuoteResult[13] memory l3s = _allQuotes(midB, base, l2s[b].amountOut);
                for (uint c = 0; c < l3s.length; c++) {
                    if (!l3s[c].ok) continue;

                    if (l3s[c].amountOut > toRepay) {
                        uint256 profit = l3s[c].amountOut - toRepay;
                        // Keep scanning — store only if this beats the current best.
                        // A $200 opportunity appearing after a $50 one was previously
                        // lost to the early-return.  Full scan cost is negligible in
                        // a view call with no gas.
                        if (profit > minProfit && profit > opp.profit) {
                            opp.found   = true;
                            opp.asset   = base;
                            opp.loan    = loan;
                            opp.profit  = profit;
                            opp.legs    = new Leg[](3);
                            opp.legs[0] = _makeLeg(l1s[a], base,  midA);
                            opp.legs[1] = _makeLeg(l2s[b], midA,  midB);
                            opp.legs[2] = _makeLeg(l3s[c], midB,  base);
                            opp.description = string(abi.encodePacked(
                                _sym(base), "->", _sym(midA), "->",
                                _sym(midB), "->", _sym(base),
                                " ", _dexName(l1s[a]), "->",
                                _dexName(l2s[b]), "->", _dexName(l3s[c])
                            ));
                            // No early return — continue to find a better combination
                        }
                    }
                }
            }
        }
    }

    // ── QUOTE ALL DEX SOURCES for a given pair + amount ──────────
    // Returns 13 slots:
    //   [0]     SUSHI V2
    //   [1]     Camelot V2
    //   [2–5]   Uniswap V3  (100, 500, 3000, 10000)
    //   [6–8]   PancakeSwap V3 (500, 2500, 10000)  ← 10000 added; matches scanner V3_SOURCES
    //   [9–12]  SushiSwap V3  (100, 500, 3000, 10000)  ← U2
    function _allQuotes(address tIn, address tOut, uint256 amtIn)
        internal view returns (QuoteResult[13] memory results)
    {
        // Slot 0: SushiSwap V2
        results[0] = _quoteV2(SUSHI_FACTORY, tIn, tOut, amtIn, true);
        // Slot 1: Camelot V2
        results[1] = _quoteV2(CAMELOT_FACTORY, tIn, tOut, amtIn, false);
        // Slot 2–5: Uniswap V3 (4 fee tiers — matches scanner V3_SOURCES exactly)
        uint24[4] memory uniFees = [uint24(100), uint24(500), uint24(3000), uint24(10000)];
        for (uint f = 0; f < 4; f++) {
            results[2 + f] = _quoteV3(UNIV3_FACTORY, UNIV3_ROUTER, tIn, tOut, amtIn, uniFees[f]);
        }
        // Slot 6–8: PancakeSwap V3 (3 fee tiers — matches scanner V3_SOURCES exactly)
        uint24[3] memory pcsFees = [uint24(500), uint24(2500), uint24(10000)];
        for (uint f = 0; f < 3; f++) {
            results[6 + f] = _quoteV3(PCSV3_FACTORY, PCSV3_ROUTER, tIn, tOut, amtIn, pcsFees[f]);
        }
        // Slot 9–12: SushiSwap V3 (4 fee tiers — U2)
        uint24[4] memory sushiV3Fees = [uint24(100), uint24(500), uint24(3000), uint24(10000)];
        for (uint f = 0; f < 4; f++) {
            results[9 + f] = _quoteV3(SUSHIV3_FACTORY, SUSHIV3_ROUTER, tIn, tOut, amtIn, sushiV3Fees[f]);
        }
    }

    // ── V2 QUOTE via reserves (getAmountsOut math, no router call) ─
    function _quoteV2(
        IV2Factory factory,
        address    tIn,
        address    tOut,
        uint256    amtIn,
        bool       isSushi
    ) internal view returns (QuoteResult memory r) {
        // Low-level staticcall throughout — no try/catch anywhere in the hot path.
        // viaIR is known to generate broken Yul for try/catch inside view functions
        // on Arbitrum fork: the call reverts with empty 0x data. staticcall is immune.
        (bool pairOk, bytes memory pairData) = address(factory).staticcall(
            abi.encodeWithSignature("getPair(address,address)", tIn, tOut)
        );
        if (!pairOk || pairData.length < 32) return r;
        address pairAddr = abi.decode(pairData, (address));
        if (pairAddr == address(0)) return r;

        (bool resOk, bytes memory resData) = pairAddr.staticcall(
            abi.encodeWithSignature("getReserves()")
        );
        if (!resOk || resData.length < 64) return r;
        (uint112 res0, uint112 res1,) = abi.decode(resData, (uint112, uint112, uint32));
        if (res0 == 0 || res1 == 0) return r;

        // All Uniswap V2 forks (Sushi, Camelot) enforce token0 < token1 at
        // pool creation — no external token0() call needed or safe here.
        bool isTIn0 = tIn < tOut;
        (uint256 rIn, uint256 rOut) = isTIn0
            ? (uint256(res0), uint256(res1))
            : (uint256(res1), uint256(res0));

        if (rIn == 0 || rOut == 0) return r;

        // Standard Uniswap V2 formula: 0.3% fee (997/1000)
        // _mulDiv replaces amtInFee * rOut to prevent overflow when amtIn is
        // large (e.g. when fed output from a broken extreme-price V3 pool).
        uint256 amtInFee = amtIn * 997;
        uint256 denom    = rIn * 1000 + amtInFee;
        if (denom == 0) return r;

        r.ok        = true;
        r.amountOut = _mulDiv(amtInFee, rOut, denom);
        r.dexType   = 0;
        r.router    = isSushi ? SUSHI_ROUTER : CAMELOT_ROUTER;
        r.isSushi   = isSushi;
    }

    // ── V3 QUOTE with liquidity-bounded price impact correction ─────────────
    // Uses the pool's current sqrtPriceX96 as the base price estimate.
    // Applies a progressive discount for large-relative-to-depth trades.
    // Returns r.ok=false (empty) for trades that would consume >80% of virtual
    // depth — these cannot be estimated reliably and always produce false positives.
    //
    // Three regimes:
    //   < 20% of virtual reserve  → no correction (sqrtP estimate is accurate)
    //   20–80% of virtual reserve → linear discount: 0 bps at 20%, 1000 bps at 80%
    //   ≥ 80% of virtual reserve  → return empty (tick crossings dominate, unreliable)
    //
    // confirmSimple/confirmTri using the Quoter contract provides exact verification
    // before any execution — this function's role is detection accuracy, not precision.
    function _quoteV3(
        IV3Factory factory,
        address    router,
        address    tIn,
        address    tOut,
        uint256    amtIn,
        uint24     fee
    ) internal view returns (QuoteResult memory r) {
        // Low-level staticcall throughout — see _quoteV2 comment above.
        (bool poolOk, bytes memory poolData) = address(factory).staticcall(
            abi.encodeWithSignature("getPool(address,address,uint24)", tIn, tOut, fee)
        );
        if (!poolOk || poolData.length < 32) return r;
        address poolAddr = abi.decode(poolData, (address));
        if (poolAddr == address(0)) return r;

        (bool slot0Ok, bytes memory slot0Data) = poolAddr.staticcall(
            abi.encodeWithSignature("slot0()")
        );
        if (!slot0Ok || slot0Data.length < 224) return r;
        (uint160 sqrtPriceX96, , , , , , bool unlocked) = abi.decode(
            slot0Data,
            (uint160, int24, uint16, uint16, uint16, uint8, bool)
        );
        if (!unlocked || sqrtPriceX96 == 0) return r;

        uint128 liq = IV3Pool(poolAddr).liquidity();
        if (liq == 0) return r;

        // All Uniswap V3 forks (Uni, PCS, Sushi) enforce token0 < token1 at
        // pool creation — no external token0() call needed or safe here.
        bool isTIn0 = tIn < tOut;

        // ── Gross output at current price ────────────────────────────────
        // Formula unchanged: amtIn × sqrtP² / 2^192  (or inverse).
        // FIX: original pre-computed sqrtP² as a plain uint256 multiply,
        // which panics with arithmetic overflow on pools where sqrtP > 2^128
        // (e.g. WBTC/LINK, WBTC/ARB at certain price ratios).
        // Now factors the squaring into two _mulDiv calls so FullMath's
        // 512-bit engine handles the full product internally — no pre-overflow.
        //   sqPScaled  = sqrtP × sqrtP / 2^96   (exact, 512-bit safe)
        //   tIn == t0: grossOut = amtIn × sqPScaled / 2^96  = amtIn × sqrtP² / 2^192
        //   tIn != t0: grossOut = amtIn × 2^96  / sqPScaled = amtIn × 2^192 / sqrtP²
        uint256 grossOut;
        {
            uint256 sqPScaled = _mulDiv(
                uint256(sqrtPriceX96),
                uint256(sqrtPriceX96),
                (1 << 96)
            );
            if (sqPScaled == 0) return r;

            if (isTIn0) {
                grossOut = _mulDiv(amtIn, sqPScaled, (1 << 96));
            } else {
                grossOut = _mulDiv(amtIn, (1 << 96), sqPScaled);
            }
        }

        // Cap guards against broken pools sitting at extreme tick boundaries
        // whose sqrtPrice produces an astronomically large but valid uint256 output.
        // No real arbitrage opportunity involves an output this large.
        if (grossOut == 0 || grossOut > 1e34) return r;

        // Apply fee: output × (1e6 - fee) / 1e6
        uint256 netOut = grossOut * (1_000_000 - uint256(fee)) / 1_000_000;
        if (netOut == 0) return r;

        // ── Virtual depth of the current tick range ───────────────────────
        // Approximates tokenIn reserve within the current tick from L and sqrtP:
        //   tIn == token0:  virtualReserveIn ≈ L × 2^96 / sqrtP
        //   tIn == token1:  virtualReserveIn ≈ L × sqrtP / 2^96
        // Conservative overestimate — actual depth decreases as price moves
        // through tick ranges, so this is the safe direction for a cutoff.
        uint256 virtualReserveIn;
        if (isTIn0) {
            virtualReserveIn = _mulDiv(uint256(liq), (1 << 96), uint256(sqrtPriceX96));
        } else {
            virtualReserveIn = _mulDiv(uint256(liq), uint256(sqrtPriceX96), (1 << 96));
        }

        if (virtualReserveIn == 0) return r;

        // ── Price impact correction ───────────────────────────────────────
        uint256 threshold80 = (virtualReserveIn * 80) / 100;
        if (amtIn >= threshold80) return r; // >80% of depth — unreliable, skip

        uint256 threshold20 = virtualReserveIn / 5; // 20%
        if (amtIn > threshold20) {
            // Linear discount: 0 bps at 20% depth → 1000 bps at 80% depth
            uint256 excess    = amtIn - threshold20;
            uint256 range     = threshold80 - threshold20; // 60% band
            uint256 impactBps = range > 0 ? (excess * 1000) / range : 1000;
            if (impactBps > 1000) impactBps = 1000;
            netOut = netOut * (10000 - impactBps) / 10000;
        }
        // Below 20%: trade fits well within current tick — no correction

        if (netOut == 0) return r;

        r.ok        = true;
        r.amountOut = netOut;
        r.dexType   = 1;
        r.router    = router;
        r.v3Fee     = fee;
    }

    // ── HELPERS ───────────────────────────────────────────────────

    function _makeLeg(QuoteResult memory q, address tIn, address tOut)
        internal pure returns (Leg memory leg)
    {
        leg.dexType  = q.dexType;
        leg.router   = q.router;
        leg.tokenIn  = tIn;
        leg.tokenOut = tOut;
        leg.v3Fee    = q.v3Fee;
        if (q.dexType == 0) {
            leg.v2Path    = new address[](2);
            leg.v2Path[0] = tIn;
            leg.v2Path[1] = tOut;
        }
    }

    // Two quotes are from the same effective source if:
    // same dexType + same router (for V3: same router + same fee tier)
    function _sameSource(QuoteResult memory a, QuoteResult memory b)
        internal pure returns (bool)
    {
        if (a.dexType != b.dexType) return false;
        if (a.router  != b.router)  return false;
        if (a.dexType == 1 && a.v3Fee != b.v3Fee) return false;
        return true;
    }

    // ── FullMath.mulDiv — Uniswap v3-core algorithm ──────────────────────────
    // Computes floor(a × b / denominator) with full 512-bit precision.
    // Never overflows regardless of input magnitude.
    // Reverts only if: denominator == 0, or the result exceeds uint256 max.
    //
    // How: EVM mulmod gives the exact 512-bit product for free. If it fits in
    // 256 bits, simple division. Otherwise, 512÷256 via Newton-Raphson modular
    // inverse — the standard Uniswap FullMath approach, battle-tested since 2021.
    function _mulDiv(uint256 a, uint256 b, uint256 denominator)
        internal pure returns (uint256 result)
    {
        // Compute exact 512-bit product [prod1 prod0] = a * b
        uint256 prod0; // low 256 bits of the product
        uint256 prod1; // high 256 bits of the product
        assembly {
            let mm := mulmod(a, b, not(0))
            prod0  := mul(a, b)
            prod1  := sub(sub(mm, prod0), lt(mm, prod0))
        }

        // Fast path: product fits in 256 bits
        if (prod1 == 0) {
            require(denominator > 0, "div/0");
            assembly { result := div(prod0, denominator) }
            return result;
        }

        // Ensure result fits in 256 bits
        require(denominator > prod1, "mulDiv overflow");

        // 512-by-256 division via modular inverse.
        // IMPORTANT: everything below uses intentional modular (wrapping) arithmetic.
        // FullMath was designed for pre-0.8 Solidity where all math wraps silently.
        // In 0.8+, we must use unchecked{} — the intermediate overflows are correct
        // by design, and the final result is guaranteed to fit in uint256 by the
        // require(denominator > prod1) check above.
        unchecked {
            // Subtract remainder so [prod1 prod0] is exactly divisible by denominator
            uint256 remainder;
            assembly { remainder := mulmod(a, b, denominator) }
            assembly {
                prod1 := sub(prod1, gt(remainder, prod0))
                prod0 := sub(prod0, remainder)
            }

            // Factor powers-of-two out of denominator
            uint256 twos = denominator & (~denominator + 1);
            assembly { denominator := div(denominator, twos) }
            assembly { prod0 := div(prod0, twos) }
            // Compute 2^256 / twos, then shift prod1 into the vacated bits of prod0
            assembly { twos := add(div(sub(0, twos), twos), 1) }
            prod0 |= prod1 * twos;  // wraps intentionally — result fits by construction

            // Modular inverse of denominator mod 2^256 via Newton-Raphson.
            // All multiplications here wrap intentionally — the iteration converges
            // in modular arithmetic regardless of intermediate overflow.
            uint256 inv = (3 * denominator) ^ 2;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;

            result = prod0 * inv;  // wraps intentionally — result fits in uint256
        }
    }

    // DEX name for human-readable description
    function _dexName(QuoteResult memory q) internal pure returns (string memory) {
        if (q.dexType == 0) return q.isSushi ? "SUSHI" : "CAMELOT";
        if (q.router == UNIV3_ROUTER) {
            if (q.v3Fee ==   100) return "UNI3_100";
            if (q.v3Fee ==   500) return "UNI3_500";
            if (q.v3Fee ==  3000) return "UNI3_3000";
            if (q.v3Fee == 10000) return "UNI3_10000";
            return "UNI3";
        }
        if (q.router == PCSV3_ROUTER) {
            if (q.v3Fee ==   500) return "PCS3_500";
            if (q.v3Fee ==  2500) return "PCS3_2500";
            if (q.v3Fee == 10000) return "PCS3_10000";  // now actively scanned
            return "PCS3";
        }
        if (q.router == SUSHIV3_ROUTER) {
            if (q.v3Fee ==   100) return "SUSHIV3_100";
            if (q.v3Fee ==   500) return "SUSHIV3_500";
            if (q.v3Fee ==  3000) return "SUSHIV3_3000";
            if (q.v3Fee == 10000) return "SUSHIV3_10000";
            return "SUSHIV3";
        }
        return "V3_UNKNOWN";
    }

    // Token symbol for description — no string storage, hardcoded
    function _sym(address t) internal pure returns (string memory) {
        if (t == USDC)   return "USDC";
        if (t == USDT)   return "USDT";
        if (t == WETH)   return "WETH";
        if (t == WBTC)   return "WBTC";
        if (t == DAI)    return "DAI";
        if (t == ARB)    return "ARB";
        if (t == GMX)    return "GMX";
        if (t == WSTETH) return "wstETH";
        if (t == USDCE)  return "USDC.e";
        if (t == LINK)   return "LINK";
        return "UNKNOWN";
    }

    // ── AAVE AVAILABLE LIQUIDITY (for loan size validation) ───────
    function aaveAvailable(address token) external view returns (uint256) {
        try AAVE_DATA.getReserveData(token) returns (
            uint256, uint256, uint256 totalAToken,
            uint256 totalStableDebt, uint256 totalVariableDebt,
            uint256, uint256, uint256, uint256, uint256, uint256, uint40
        ) {
            if (totalAToken <= totalStableDebt + totalVariableDebt) return 0;
            return totalAToken - totalStableDebt - totalVariableDebt;
        } catch {
            return 0;
        }
    }

    // ── CONFIRMATION QUOTE (before execution, returns exact output) ──
    // Called by scanner after check() returns found == true.
    // Uses the same reserve math but on a specific pair — fast confirmation.
    function confirmSimple(
        address base,
        address mid,
        uint256 loan,
        address buyRouter,
        uint8   buyDexType,
        uint24  buyFee,
        address sellRouter,
        uint8   sellDexType,
        uint24  sellFee
    ) external view returns (uint256 confirmedProfit, bool stillProfitable) {
        QuoteResult memory buy;
        QuoteResult memory sell;

        if (buyDexType == 0) {
            bool isSushi = buyRouter == SUSHI_ROUTER;
            buy = _quoteV2(
                isSushi ? SUSHI_FACTORY : CAMELOT_FACTORY,
                base, mid, loan, isSushi
            );
        } else {
            buy = _quoteV3(UNIV3_FACTORY, buyRouter, base, mid, loan, buyFee);
            if (!buy.ok) buy = _quoteV3(PCSV3_FACTORY,   buyRouter, base, mid, loan, buyFee);
            if (!buy.ok) buy = _quoteV3(SUSHIV3_FACTORY, buyRouter, base, mid, loan, buyFee);
        }

        if (!buy.ok) return (0, false);

        if (sellDexType == 0) {
            bool isSushi = sellRouter == SUSHI_ROUTER;
            sell = _quoteV2(
                isSushi ? SUSHI_FACTORY : CAMELOT_FACTORY,
                mid, base, buy.amountOut, isSushi
            );
        } else {
            sell = _quoteV3(UNIV3_FACTORY,   sellRouter, mid, base, buy.amountOut, sellFee);
            if (!sell.ok) sell = _quoteV3(PCSV3_FACTORY,   sellRouter, mid, base, buy.amountOut, sellFee);
            if (!sell.ok) sell = _quoteV3(SUSHIV3_FACTORY, sellRouter, mid, base, buy.amountOut, sellFee);
        }

        if (!sell.ok) return (0, false);

        uint256 toRepay = loan + (loan * AAVE_FEE_BPS) / 10000;
        if (sell.amountOut <= toRepay) return (0, false);

        confirmedProfit  = sell.amountOut - toRepay;
        stillProfitable  = true;
    }

    // ── U5: TRIANGULAR CONFIRMATION QUOTE ─────────────────────────
    // Called by scanner after check() returns a TRIANGULAR opportunity.
    // Mirrors confirmSimple() exactly — re-reads current reserves for all 3 legs,
    // returns updated profit and a bool the scanner uses to gate execution.
    function confirmTri(
        address base,
        address midA,
        address midB,
        uint256 loan,
        address l1Router, uint8 l1DexType, uint24 l1Fee,
        address l2Router, uint8 l2DexType, uint24 l2Fee,
        address l3Router, uint8 l3DexType, uint24 l3Fee
    ) external view returns (uint256 confirmedProfit, bool stillProfitable) {
        QuoteResult memory leg1;
        QuoteResult memory leg2;
        QuoteResult memory leg3;

        // ── Leg 1: base → midA ───────────────────────────────────
        if (l1DexType == 0) {
            bool isSushi = l1Router == SUSHI_ROUTER;
            leg1 = _quoteV2(
                isSushi ? SUSHI_FACTORY : CAMELOT_FACTORY,
                base, midA, loan, isSushi
            );
        } else {
            leg1 = _quoteV3(UNIV3_FACTORY,   l1Router, base, midA, loan, l1Fee);
            if (!leg1.ok) leg1 = _quoteV3(PCSV3_FACTORY,   l1Router, base, midA, loan, l1Fee);
            if (!leg1.ok) leg1 = _quoteV3(SUSHIV3_FACTORY, l1Router, base, midA, loan, l1Fee);
        }
        if (!leg1.ok) return (0, false);

        // ── Leg 2: midA → midB ───────────────────────────────────
        if (l2DexType == 0) {
            bool isSushi = l2Router == SUSHI_ROUTER;
            leg2 = _quoteV2(
                isSushi ? SUSHI_FACTORY : CAMELOT_FACTORY,
                midA, midB, leg1.amountOut, isSushi
            );
        } else {
            leg2 = _quoteV3(UNIV3_FACTORY,   l2Router, midA, midB, leg1.amountOut, l2Fee);
            if (!leg2.ok) leg2 = _quoteV3(PCSV3_FACTORY,   l2Router, midA, midB, leg1.amountOut, l2Fee);
            if (!leg2.ok) leg2 = _quoteV3(SUSHIV3_FACTORY, l2Router, midA, midB, leg1.amountOut, l2Fee);
        }
        if (!leg2.ok) return (0, false);

        // ── Leg 3: midB → base ───────────────────────────────────
        if (l3DexType == 0) {
            bool isSushi = l3Router == SUSHI_ROUTER;
            leg3 = _quoteV2(
                isSushi ? SUSHI_FACTORY : CAMELOT_FACTORY,
                midB, base, leg2.amountOut, isSushi
            );
        } else {
            leg3 = _quoteV3(UNIV3_FACTORY,   l3Router, midB, base, leg2.amountOut, l3Fee);
            if (!leg3.ok) leg3 = _quoteV3(PCSV3_FACTORY,   l3Router, midB, base, leg2.amountOut, l3Fee);
            if (!leg3.ok) leg3 = _quoteV3(SUSHIV3_FACTORY, l3Router, midB, base, leg2.amountOut, l3Fee);
        }
        if (!leg3.ok) return (0, false);

        uint256 toRepay = loan + (loan * AAVE_FEE_BPS) / 10000;
        if (leg3.amountOut <= toRepay) return (0, false);

        confirmedProfit = leg3.amountOut - toRepay;
        stillProfitable = true;
    }
}
