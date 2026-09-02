'use strict';
const { ethers } = require('ethers');
const fs         = require('fs');

// ════════════════════════════════════════════════════════════════════════
// UNCHAINED9 — Flash Arbitrage Scanner  [v10 — Phase 5: Latency Hardening]
// Network  : Arbitrum One
// DEXes    : SushiSwap, Camelot (V2) · Uniswap V3, PancakeSwap V3, SushiSwap V3
// Paths    : Simple (A→B→A) + Triangular (A→B→C→A)
// Sizing   : Dynamic $50K–$25M (Aave ceiling live) + 0.5–500 WBTC ladder
// RPC      : Multi-RPC failover (WS primary · HTTP fallback)
// Scanning : Searcher.sol on-chain detection via eth_call (ZERO gas)
//
// v10.1 bug fixes (audit pass):
//   BF1  lastWbtcPriceBlock — separate counter from ETH; shared counter suppressed initial WBTC fetch
//   BF2  Searcher recovery  — transient RPC failure now suspends for SEARCHER_RETRY_BLOCKS then retries
//                             (previously set searcherAvailable=false with no recovery path in-session)
//   BF3  enforceSlippage()  — dead function removed; all slippage already enforced inline in execute()
//   BF4  WBTC confirmSimple — WBTC opps now confirmed via Searcher before scaling, matching USDC path
//
// v10 over v9 — Phase 5: Latency Hardening:
//   L1  QuickNode-first RPC — US-East endpoint closest to Arbitrum sequencer (AWS us-east-2)
//   L2  Nonce pre-cache    — fetched at scan start, eliminates eth_getTransactionCount from hot path
//   L3  Gas price thread   — fetched once in scan(), reused in execute() (was fetched twice)
//   L4  SushiV3 flag       — disabled by default; quoter unconfirmed; enable via SUSHIV3_ENABLED=true
//
// v9 over v8:
//   G3  WBTC expansion — WBTC added to BASES; checkWBTC Searcher entry point;
//       dynamic size ladder per asset; price tracking; USDC-normalised comparison
//
// v8 over v7:
//   G1  Profit-proportional tip  — bid up to 100% of base fee on large opportunities
//   G2  Scaled min-profit floor  — 90% near threshold, linear to 72% on large trades
//   G4  ETH balance monitor      — alerts on startup, heartbeat, and post-trade
//   G5  Gas-spike opportunity retry — cache confirmed opp; retry during spikes
//
// v6 over v5:
//   S1  Searcher integration   — one eth_call replaces all Multicall3 batches
//   S2  Fallback pipeline      — Multicall3 path retained; runs if Searcher unavailable
//   S3  amountOutMinimum fix   — slippage guard added to all swap legs (contract bug fix)
//   S4  Deadline tightened     — 300s→30s; Arbitrum block is 250ms
//   S5  confirmQuote pre-exec  — Searcher.confirmSimple() called before any tx fires
//   S6  Quoter confirmation    — V3 Quoter re-quote before execution (exact output)
//   S7  Safe transfer check    — withdraw pattern notes; executor side only (scanner)
//
// v5 hardening retained (M1–M7, P1–P7, X1–X3, C1, BF1)
// ════════════════════════════════════════════════════════════════════════

// ── CONFIG ───────────────────────────────────────────────────────────────
const CONFIG = {
  // L1: QuickNode goes first — physically closest to Arbitrum sequencer (AWS us-east-2, Ohio).
  // Get your endpoint at quicknode.com → Create Endpoint → Arbitrum One → US East.
  QUICKNODE_WSS       : process.env.QUICKNODE_WSS,
  QUICKNODE_HTTP      : process.env.QUICKNODE_HTTP,
  ALCHEMY_KEY         : process.env.ALCHEMY_KEY,
  PRIVATE_KEY         : process.env.PRIVATE_KEY,
  CONTRACT_ADDR       : process.env.CONTRACT_ADDR,
  SEARCHER_ADDR       : process.env.SEARCHER_ADDR,          // S1: deploy Searcher.sol, set this
  MIN_PROFIT_USD      : parseFloat(process.env.MIN_PROFIT   || '15'),
  MAX_STALE_BLOCKS    : parseInt(process.env.MAX_STALE      || '2'),
  GAS_SAFETY_PCT      : parseInt(process.env.GAS_SAFETY_PCT || '20'),
  SLIPPAGE_BPS        : parseInt(process.env.SLIPPAGE_BPS   || '50'),  // S3: 50bps = 0.5% slippage tolerance
  GAS_LIMIT_FALLBACK  : 800_000,
  MAX_CONSEC_FAILURES : parseInt(process.env.MAX_CONSEC_FAILURES   || '5'),
  MAX_DAILY_GAS_USDC  : parseFloat(process.env.MAX_DAILY_GAS_USDC  || '50'),
};

const missing = ['PRIVATE_KEY', 'CONTRACT_ADDR'].filter(k => !CONFIG[k]);
if (missing.length) { console.error(`[FATAL] Missing env vars: ${missing.join(', ')}`); process.exit(1); }

// G4: ETH balance thresholds
const ETH_WARN_THRESHOLD  = ethers.parseEther('0.005'); // ~$12 at $2500/ETH
const ETH_FATAL_THRESHOLD = ethers.parseEther('0.001'); // ~$2.50 — critically low

// ── M1: MULTI-RPC POOL ───────────────────────────────────────────────────
// L1: Priority order: QuickNode (US-East) → Alchemy → public node.
// QuickNode US-East sits ~8ms from the Arbitrum sequencer. Public node adds 40-80ms.
const WS_ENDPOINTS = [
  CONFIG.QUICKNODE_WSS || null,
  CONFIG.ALCHEMY_KEY ? `wss://arb-mainnet.g.alchemy.com/v2/${CONFIG.ALCHEMY_KEY}` : null,
  'wss://arb1.arbitrum.io/ws',
].filter(Boolean);

const HTTP_ENDPOINTS = [
  CONFIG.QUICKNODE_HTTP || null,
  CONFIG.ALCHEMY_KEY ? `https://arb-mainnet.g.alchemy.com/v2/${CONFIG.ALCHEMY_KEY}` : null,
  'https://arbitrum.llamarpc.com',
  'https://rpc.ankr.com/arbitrum',
  'https://arb1.arbitrum.io/rpc',
].filter(Boolean);

// M2: Direct sequencer submission
const SEQUENCER_ENDPOINT = 'https://arb1.arbitrum.io/rpc';

// ── VERIFIED ADDRESSES ────────────────────────────────────────────────────
const AAVE_POOL_ADDR = '0x794a61358D6845594F94dc1DB02A252b5b4814aD';
const MC3_ADDR       = '0xcA11bde05977b3631167028862bE2a173976CA11';

// ── TOKENS ────────────────────────────────────────────────────────────────
const TOKENS = {
  USDC  : { addr: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', dec: 6,  sym: 'USDC'   },
  USDT  : { addr: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', dec: 6,  sym: 'USDT'   },
  WETH  : { addr: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', dec: 18, sym: 'WETH'   },
  WBTC  : { addr: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', dec: 8,  sym: 'WBTC'   },
  DAI   : { addr: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', dec: 18, sym: 'DAI'    },
  ARB   : { addr: '0x912CE59144191C1204E64559FE8253a0e49E6548', dec: 18, sym: 'ARB'    },
  GMX   : { addr: '0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a', dec: 18, sym: 'GMX'    },
  WSTETH: { addr: '0x5979D7b546E38E414F7E9822514be443A4800529', dec: 18, sym: 'wstETH' },
  USDCE : { addr: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8', dec: 6,  sym: 'USDC.e' },
  LINK  : { addr: '0xf97f4df75117a78c1A5a0DBb814Af92458539FB4', dec: 18, sym: 'LINK'   },
};

// ── DEXes ─────────────────────────────────────────────────────────────────
const V2_DEXES = [
  { name: 'SUSHI',   router: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506' },
  { name: 'CAMELOT', router: '0xc873fEcbd354f5A56E00E710B90EF4201db2448d' },
];
const V2_RPP = V2_DEXES.length;

// L4: SushiSwap V3 Quoter VERIFIED — 0x0524E833cCD057e4d7A296e3aaAb9f7675964Ce1 confirmed on
// Arbiscan (verified source code) and matches SushiSwap v3-periphery official deployment JSON.
// Constructor args confirm it's wired to SushiSwap V3 Factory (0x1af415a1...) on Arbitrum.
// Default: ON. Disable via SUSHIV3_ENABLED=false in .env if issues arise.
const SUSHIV3_ENABLED = process.env.SUSHIV3_ENABLED !== 'false';

const V3_SOURCES = [
  {
    name  : 'UNIV3',
    router: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
    quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    fees  : [100, 500, 3000, 10000],
  },
  {
    name  : 'PCSV3',
    router: '0x1b81D678ffb9C0263b24A97847620C99d213eB14',
    quoter: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997',
    fees  : [500, 2500, 10000],
  },
  // U2/L4: SushiSwap V3 — VERIFIED. Address confirmed on Arbiscan + official deployment JSON.
  // Disable via SUSHIV3_ENABLED=false in .env if needed.
  ...(SUSHIV3_ENABLED ? [{
    name  : 'SUSHIV3',
    router: '0x8A21F6768C1f8075791D08546Dadf6daA0bE820c',
    quoter: '0x0524E833cCD057e4d7A296e3aaAb9f7675964Ce1',
    fees  : [100, 500, 3000, 10000],
  }] : []),
];

const REQS_PER_PAIR = V2_DEXES.length + V3_SOURCES.reduce((s, src) => s + src.fees.length, 0);

// ── LOAN SIZE LADDER ──────────────────────────────────────────────────────
const SIZE_LADDER = [
  '50000', '250000', '500000', '1000000',
  '2500000', '5000000', '10000000', '25000000',
].map(n => ethers.parseUnits(n, 6));

const DETECT_AMOUNT = SIZE_LADDER[0];

// G3: WBTC loan sizes. WBTC is 8-decimal. At ~$100K/BTC:
// 0.5 BTC ≈ $50K, 2 BTC ≈ $200K, etc.
const WBTC_SIZE_LADDER = [
  '0.5', '2', '5', '10', '25', '100', '200', '500',
].map(n => ethers.parseUnits(n, 8));

// G3: Select correct size ladder based on borrow asset
function sizeLadder(assetAddr) {
  return assetAddr.toLowerCase() === TOKENS.WBTC.addr.toLowerCase()
    ? WBTC_SIZE_LADDER
    : SIZE_LADDER;
}

// G3: Initial detection amount by asset
function detectAmount(assetAddr) {
  return assetAddr.toLowerCase() === TOKENS.WBTC.addr.toLowerCase()
    ? WBTC_SIZE_LADDER[0]
    : SIZE_LADDER[0];
}

// ── SCAN SETS (fallback Multicall3 path) ──────────────────────────────────
const BASES = [TOKENS.USDC, TOKENS.USDT, TOKENS.WBTC]; // G3: WBTC added as base asset
const MIDS  = [
  TOKENS.WETH, TOKENS.WBTC, TOKENS.ARB,  TOKENS.GMX,
  TOKENS.WSTETH, TOKENS.DAI, TOKENS.USDCE, TOKENS.LINK,
];

// ── ABIs ──────────────────────────────────────────────────────────────────
const V2_IFACE = new ethers.Interface([
  'function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)',
]);
const V3Q_IFACE = new ethers.Interface([
  'function quoteExactInputSingle(tuple(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);
const ERC20_ABI    = ['function balanceOf(address) external view returns (uint256)'];
const MC3_ABI      = ['function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) external payable returns (tuple(bool success, bytes returnData)[] returnData)'];
const CONTRACT_ABI = [
  'function executeArbitrage(address borrowAsset, uint256 borrowAmount, tuple(uint8 dexType, address router, address tokenIn, address tokenOut, uint24 v3Fee, address[] v2Path, uint256 amountOutMinimum)[] calldata legs, uint256 minProfit) external',
  'event ArbitrageExecuted(address indexed asset, uint256 loan, uint256 profit)',
];
const CONTRACT_IFACE = new ethers.Interface(CONTRACT_ABI);

// S1: Searcher ABI — matches Searcher.sol exactly
const SEARCHER_ABI = [
  // Main detection call — zero gas via eth_call
  `function check(uint256 loan, uint256 minProfit) external view returns (
    tuple(
      bool found,
      address asset,
      uint256 loan,
      uint256 profit,
      tuple(
        uint8 dexType,
        address router,
        address tokenIn,
        address tokenOut,
        uint24 v3Fee,
        address[] v2Path
      )[] legs,
      string description
    ) opp
  )`,
  // Pre-execution confirmation — re-reads current reserves
  `function confirmSimple(
    address base, address mid, uint256 loan,
    address buyRouter, uint8 buyDexType, uint24 buyFee,
    address sellRouter, uint8 sellDexType, uint24 sellFee
  ) external view returns (uint256 confirmedProfit, bool stillProfitable)`,
  // U5: Pre-execution confirmation for tri arbs — re-reads current reserves for all 3 legs
  `function confirmTri(
    address base, address midA, address midB, uint256 loan,
    address l1Router, uint8 l1DexType, uint24 l1Fee,
    address l2Router, uint8 l2DexType, uint24 l2Fee,
    address l3Router, uint8 l3DexType, uint24 l3Fee
  ) external view returns (uint256 confirmedProfit, bool stillProfitable)`,
  // G3: WBTC detection — separate entry point to avoid decimal mismatch with check()
  `function checkWBTC(uint256 wbtcLoan, uint256 minProfitWBTC) external view returns (
    tuple(
      bool found,
      address asset,
      uint256 loan,
      uint256 profit,
      tuple(
        uint8 dexType,
        address router,
        address tokenIn,
        address tokenOut,
        uint24 v3Fee,
        address[] v2Path
      )[] legs,
      string description
    ) opp
  )`,
  // Aave available liquidity
  `function aaveAvailable(address token) external view returns (uint256)`,
];

// ── STATE ──────────────────────────────────────────────────────────────────
let readProvider   = null;
let alchemyProvider = null;
let submitProvider = null;
let wallet         = null;
let submitWallet   = null;
let contract       = null;
let submitContract = null;
let searcher       = null;   // S1: Searcher contract instance (read provider)
let mc3            = null;

let blockListener     = null;
let reconnectTimer    = null;
let reconnectCount    = 0;
let wsEndpointIndex   = 0;
let httpEndpointIndex = 0;
let pollIntervalId    = null;
let lastPolledBlock   = 0;
let usingHTTPFallback = false;

let scanning          = false;
let executing         = false;
let searcherAvailable = false;   // S1: true when SEARCHER_ADDR is set and contract responds
let MIN_PROFIT;

let ethPriceUSDC       = 0n;
let wbtcPriceUSDC      = 0n;  // G3: WBTC price in USDC 6-dec (per 1 WBTC)
let lastEthPriceBlock  = 0;
let lastWbtcPriceBlock = 0;   // BF1: separate from ETH — shared counter suppressed initial WBTC fetch
const ETH_PRICE_INTERVAL = 20; // refresh every ~5 s (20 × 250 ms blocks)

// P7: BigInt P&L
let totalScans       = 0;
let totalTrades      = 0;
let totalFailedTxs   = 0;
let totalGrossProfit = 0n;
let totalGasCost     = 0n;
let totalNetProfit   = 0n;
// S1: Searcher-specific stats
let searcherHits     = 0;   // scans handled by Searcher path
let fallbackHits     = 0;   // scans handled by Multicall3 fallback path

// P4: Trade telemetry — append-only JSONL log
const TRADE_LOG_FILE = process.env.TRADE_LOG || 'trades.jsonl';
let   tradeLogStream = null;

// P4: Capture rate counters
let crDetected    = 0; // opportunities that entered execute()
let crAbortStale  = 0; // killed by stale-quote check
let crAbortSim    = 0; // simulation reverted
let crAbortGas    = 0; // net-after-gas below MIN_PROFIT (pre-sim or post-sim)
let crAbortSpike  = 0; // gas spike in execute()
let crSubmitted   = 0; // tx submitted to sequencer
let crConfirmed   = 0; // tx confirmed (success)
let crFailed      = 0; // tx failed on-chain

// P4: Historical gas usage by trade type for pre-simulation filtering
const GAS_HISTORY_WINDOW = 20; // rolling window — last 20 trades per type
const gasHistory = {
  SIMPLE     : { samples: [], default: 400_000n },
  TRIANGULAR : { samples: [], default: 600_000n },
};

// Kill switch / risk governor
let killed         = false;
let consecFailures = 0;
let dailyGasUsdc   = 0n;
let dailyResetDate = new Date().toDateString();

// G5: cache for spike-retry
let lastConfirmedOpp = null;

// BF2: Searcher transient-failure recovery.
// A single RPC hiccup used to permanently disable the Searcher for the session.
// After SEARCHER_RETRY_BLOCKS, scan() will re-enable it and try again.
let searcherDisabledBlock  = 0;           // block number when Searcher was suspended
const SEARCHER_RETRY_BLOCKS = 40;         // ~10 s on Arbitrum before retrying

const startTime = Date.now();

// ── L2 + L3: LATENCY CACHE ────────────────────────────────────────────────
// WHY: In v9, both nonce and gas price were fetched INSIDE execute() — two extra
// RPC calls at the worst possible moment (inside the 250ms block window).
// v10 pre-fetches both at scan() start and threads them into execute().
// Result: execute() starts with nonce + gasPrice already in memory.
let cachedNonce    = null;  // incremented after successful submit; reset to null on failure
let cachedGasPrice = null;  // set fresh each block by scan(); consumed by execute()

// ── M4: GAS SPIKE GUARD ───────────────────────────────────────────────────
const ARB_BASELINE_GAS = 100_000_000n;
const GAS_SPIKE_FACTOR = 5n;
let   rollingGasBaseline = ARB_BASELINE_GAS;

function isGasSpike(gasPrice)      { return gasPrice > rollingGasBaseline * GAS_SPIKE_FACTOR; }
function updateGasBaseline(gp)     { rollingGasBaseline = (rollingGasBaseline * 9n + gp) / 10n; }

// ── RISK GOVERNOR ─────────────────────────────────────────────────────────
function _resetDailyGasIfNewDay() {
  const today = new Date().toDateString();
  if (today !== dailyResetDate) {
    dailyGasUsdc  = 0n;
    dailyResetDate = today;
    info('Risk: daily gas counter reset');
  }
}

function engageKillSwitch(reason) {
  if (killed) return;
  killed = true;
  err(`KILL SWITCH ENGAGED — ${reason}`);
  err('Bot halted. Resolve and restart, or send SIGUSR1 to resume.');
}

function checkRiskLimits() {
  _resetDailyGasIfNewDay();
  if (consecFailures >= CONFIG.MAX_CONSEC_FAILURES) {
    engageKillSwitch(`${consecFailures} consecutive execution failures`);
  }
  const maxDailyGas = BigInt(Math.round(CONFIG.MAX_DAILY_GAS_USDC * 1e6));
  if (dailyGasUsdc >= maxDailyGas) {
    engageKillSwitch(`Daily gas spend ${fmt(dailyGasUsdc, 6)} exceeded limit $${CONFIG.MAX_DAILY_GAS_USDC}`);
  }
}

// ── M5: BLOCK LAG ─────────────────────────────────────────────────────────
const ARB_BLOCK_TIME_MS = 250;
const LAG_WARN_MS       = ARB_BLOCK_TIME_MS * 2;

// ── LOGGER ────────────────────────────────────────────────────────────────
const ts   = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const info = m  => console.log(`[${ts()}] ${m}`);
const ok   = m  => console.log(`[${ts()}] ✓ ${m}`);
const warn = m  => console.warn(`[${ts()}] ⚠ ${m}`);
const fire = m  => console.log(`[${ts()}] 🔥 ${m}`);
const err  = m  => console.error(`[${ts()}] ✗ ${m}`);

const fmt      = (v, dec) => '$' + parseFloat(ethers.formatUnits(v, dec)).toFixed(2);
const fmtLoan  = v        => '$' + parseFloat(ethers.formatUnits(v, 6)).toLocaleString('en-US', { maximumFractionDigits: 0 });
const fmtTotal = ()       => `gross:${fmt(totalGrossProfit,6)} gas:${fmt(totalGasCost,6)} net:${fmt(totalNetProfit,6)}`;
const fmtGas   = gwei     => parseFloat(ethers.formatUnits(gwei, 'gwei')).toFixed(3) + ' gwei';

// ── MULTICALL3 BATCH (Fallback path) ──────────────────────────────────────
async function batchQuotes(requests) {
  if (!requests.length) return [];
  const calls = requests.map(r => ({ target: r.target, allowFailure: true, callData: r.callData }));
  let raw;
  try {
    const mc3Data   = mc3.interface.encodeFunctionData('aggregate3', [calls]);
    const mc3Result = await alchemyProvider.call({
      to   : MC3_ADDR,
      data : mc3Data,
      gasLimit : 50_000_000n,
    });
    raw = mc3.interface.decodeFunctionResult('aggregate3', mc3Result)[0];
  } catch (e) {
    err(`Multicall3 failed — ${e.message?.slice(0, 80)}`);
    return requests.map(() => null);
  }
  return raw.map(({ success, returnData }, i) => {
    if (!success || !returnData || returnData === '0x' || returnData.length <= 2) return null;
    try   { return requests[i].decode(returnData); }
    catch { return null; }
  });
}

// ── QUOTE REQUEST BUILDERS (Fallback path) ────────────────────────────────
function mkAllQuoteReqs(tIn, tOut, amtIn) {
  const reqs = [];
  for (const d of V2_DEXES) {
    reqs.push({
      target  : d.router,
      callData: V2_IFACE.encodeFunctionData('getAmountsOut', [amtIn, [tIn, tOut]]),
      decode(data) {
        const [amounts] = V2_IFACE.decodeFunctionResult('getAmountsOut', data);
        const out = amounts[amounts.length - 1];
        return out > 0n ? { name: d.name, type: 0, router: d.router, out, v3Fee: 0, path: [tIn, tOut] } : null;
      },
    });
  }
  for (const src of V3_SOURCES) {
    for (const fee of src.fees) {
      reqs.push({
        target  : src.quoter,
        callData: V3Q_IFACE.encodeFunctionData('quoteExactInputSingle', [{
          tokenIn: tIn, tokenOut: tOut, amountIn: amtIn, fee, sqrtPriceLimitX96: 0n,
        }]),
        decode(data) {
          const [amountOut] = V3Q_IFACE.decodeFunctionResult('quoteExactInputSingle', data);
          return amountOut > 0n
            ? { name: `${src.name}_${fee}`, type: 1, router: src.router, out: amountOut, v3Fee: fee, path: null }
            : null;
        },
      });
    }
  }
  return reqs;
}

function mkV2QuoteReqs(tIn, tOut, amtIn) {
  return V2_DEXES.map(d => ({
    target  : d.router,
    callData: V2_IFACE.encodeFunctionData('getAmountsOut', [amtIn, [tIn, tOut]]),
    decode(data) {
      const [amounts] = V2_IFACE.decodeFunctionResult('getAmountsOut', data);
      const out = amounts[amounts.length - 1];
      return out > 0n ? { name: d.name, type: 0, router: d.router, out, v3Fee: 0, path: [tIn, tOut] } : null;
    },
  }));
}

// ── HELPERS ───────────────────────────────────────────────────────────────
function calcProfit(received, loan) {
  return received - loan - (loan * 9n) / 10000n;
}

function mkLeg(src, tokenIn, tokenOut) {
  return {
    dexType: src.type,
    router : src.router,
    tokenIn,
    tokenOut,
    v3Fee  : src.v3Fee,
    v2Path : src.path ?? [tokenIn, tokenOut],
  };
}

function sortByOut(arr) {
  return arr.filter(Boolean).sort((a, b) => Number(b.out - a.out));
}

// U4: Reverse-lookup helpers for description rebuild after scaling.
// Both functions are non-throwing — return '?' on unknown input.
function tokenSymbol(addr) {
  const lc    = addr.toLowerCase();
  const entry = Object.values(TOKENS).find(t => t.addr.toLowerCase() === lc);
  return entry ? entry.sym : '?';
}

function legSourceName(leg) {
  if (leg.dexType === 0) {
    const lc = leg.router.toLowerCase();
    const d  = V2_DEXES.find(d => d.router.toLowerCase() === lc);
    return d ? d.name : '?';
  }
  const lc  = leg.router.toLowerCase();
  const src = V3_SOURCES.find(s => s.router.toLowerCase() === lc);
  if (!src) return '?';
  return leg.v3Fee ? `${src.name}_${leg.v3Fee}` : src.name;
}

async function getAaveAvailable(tokenAddr) {
  // S1: Use Searcher if available (avoids extra RPC call)
  if (searcher && searcherAvailable) {
    try {
      return await searcher.aaveAvailable(tokenAddr);
    } catch {}
  }
  try {
    return await (new ethers.Contract(tokenAddr, ERC20_ABI, readProvider)).balanceOf(AAVE_POOL_ADDR);
  } catch { return 0n; }
}

function updateEthPrice(pairBuys) {
  const wethPair = pairBuys.find(p =>
    p.pair.base.addr === TOKENS.USDC.addr && p.pair.mid.addr === TOKENS.WETH.addr
  );
  if (!wethPair || !wethPair.buys.length) return;
  const wethOut = wethPair.buys[0].out;
  if (wethOut > 0n) ethPriceUSDC = (DETECT_AMOUNT * 10n ** 18n) / wethOut;
}

// Conservative fallback when ETH price hasn't been fetched yet.
// $2 000 rather than live price — overestimates gas cost, which is the safe direction:
// we skip marginal trades rather than execute unprofitable ones.
const ETH_PRICE_FALLBACK = 2_000_000_000n; // $2 000 in USDC 6-dec

function gasCostToUSDC(gasUsed, gasPrice) {
  const price = ethPriceUSDC > 0n ? ethPriceUSDC : ETH_PRICE_FALLBACK;
  return (gasUsed * gasPrice * price) / 10n ** 18n;
}

// Refresh ETH price using existing Multicall3 infrastructure.
// Runs at most once every ETH_PRICE_INTERVAL blocks and immediately on first call.
// Reuses the USDC→WETH quote that detectSimple already performs, so there is no
// extra RPC round-trip when the Multicall3 fallback is active.  When the Searcher
// is the sole active path and detectSimple never fires, this function fills the gap.
async function refreshEthPrice(blockNum) {
  if (ethPriceUSDC > 0n && (blockNum - lastEthPriceBlock) < ETH_PRICE_INTERVAL) return;
  try {
    const reqs = mkAllQuoteReqs(TOKENS.USDC.addr, TOKENS.WETH.addr, DETECT_AMOUNT);
    const raw  = await batchQuotes(reqs);
    const syntheticPairBuys = [{
      pair: { base: TOKENS.USDC, mid: TOKENS.WETH },
      buys: sortByOut(raw),
    }];
    updateEthPrice(syntheticPairBuys);
    if (ethPriceUSDC > 0n) lastEthPriceBlock = blockNum;
  } catch {}
}

// G3: Refresh WBTC/USDC price. Runs at most once per ETH_PRICE_INTERVAL blocks.
// Uses the same Multicall3 infrastructure as refreshEthPrice — zero extra round-trips
// when the Searcher is the primary path.
async function refreshWbtcPrice(blockNum) {
  // BF1: use lastWbtcPriceBlock — not lastEthPriceBlock — so the initial WBTC fetch
  // is never suppressed by a concurrent ETH price refresh.
  if (wbtcPriceUSDC > 0n && (blockNum - lastWbtcPriceBlock) < ETH_PRICE_INTERVAL) return;
  try {
    const reqs = mkAllQuoteReqs(TOKENS.WBTC.addr, TOKENS.USDC.addr, WBTC_SIZE_LADDER[0]);
    const raw  = await batchQuotes(reqs);
    const best = sortByOut(raw)[0];
    if (best && best.out > 0n) {
      // best.out: USDC received for WBTC_SIZE_LADDER[0] (0.5 BTC in satoshis = 50_000_000n)
      // Scale to price per 1 WBTC: wbtcPriceUSDC = best.out * 1e8 / WBTC_SIZE_LADDER[0]
      wbtcPriceUSDC      = (best.out * 100_000_000n) / WBTC_SIZE_LADDER[0];
      lastWbtcPriceBlock = blockNum; // BF1: stamp with the block the price was fetched
    }
  } catch {}
}

// G3: Convert USDC min profit to WBTC satoshis for Searcher comparison.
// Falls back to 50_000n (~$0.05 at $100K/BTC) when price is unavailable — very conservative.
function minProfitWBTC(minProfitUSDC) {
  if (wbtcPriceUSDC === 0n) return 50_000n;
  return (minProfitUSDC * 100_000_000n) / wbtcPriceUSDC;
}

// G3: Convert WBTC profit (satoshis) to USDC 6-dec for comparison with gas cost and MIN_PROFIT.
function wbtcProfitToUsdc(satoshis) {
  if (wbtcPriceUSDC === 0n) return 0n;
  return (satoshis * wbtcPriceUSDC) / 100_000_000n;
}

// G1: Scale tip with opportunity value. On Arbitrum the cost delta is < $0.01.
function priorityFeeForProfit(netProfit, gasPrice) {
  if (netProfit < 30_000_000n)  return gasPrice / 10n > 1n ? gasPrice / 10n : 1n;  // <$30:  10%
  if (netProfit < 100_000_000n) return gasPrice / 5n  > 1n ? gasPrice / 5n  : 1n;  // <$100: 20%
  if (netProfit < 500_000_000n) return gasPrice / 2n  > 1n ? gasPrice / 2n  : 1n;  // <$500: 50%
  return gasPrice > 1n ? gasPrice : 1n;                                              // $500+: 100%
}

// G2: Slide min-profit floor from 90% (near-threshold) to 72% (large trades).
function scaledMinProfit(profit, minProfit) {
  const excess = profit > minProfit ? profit - minProfit : 0n;
  const CAP    = 200_000_000n; // $200 excess — floor stabilises at 72% above this
  if (excess === 0n)  return (profit * 90n) / 100n;
  if (excess >= CAP)  return (profit * 72n) / 100n;
  // Linear interpolation: 90% → 72% as excess goes from 0 → CAP
  const pct = 90n - (18n * excess) / CAP;
  return (profit * pct) / 100n;
}

// G4: Check wallet ETH balance and warn if low. Non-fatal — never throws.
async function checkEthBalance() {
  try {
    const balance = await readProvider.getBalance(wallet.address);
    if (balance < ETH_FATAL_THRESHOLD) {
      err(`CRITICAL: ETH balance ${ethers.formatEther(balance)} ETH — bot will fail on next execution`);
    } else if (balance < ETH_WARN_THRESHOLD) {
      warn(`Low ETH balance: ${ethers.formatEther(balance)} ETH — top up soon`);
    }
    return balance;
  } catch { return null; }
}

// S3: Apply slippage tolerance to a quoted amount
// Returns the minimum acceptable output (quoted * (10000 - slippageBps) / 10000)
function applySlippage(quoted) {
  return (quoted * BigInt(10000 - CONFIG.SLIPPAGE_BPS)) / 10000n;
}

// U3: Re-quote all three legs of a tri arb to get intermediate amounts.
// Used on the Searcher path where the Searcher returns no per-leg outputs,
// so legs 0 and 1 would otherwise receive amountOutMinimum = 0 in execute().
// Non-fatal: returns opp unchanged if any leg quote fails — never blocks execution.
async function requoteTriLegs(opp) {
  try {
    const l1Reqs = mkAllQuoteReqs(opp.legs[0].tokenIn, opp.legs[0].tokenOut, opp.loan);
    const l1Raw  = await batchQuotes(l1Reqs);
    const l1Best = sortByOut(l1Raw)[0];
    if (!l1Best) return opp;

    const l2Reqs = mkAllQuoteReqs(opp.legs[1].tokenIn, opp.legs[1].tokenOut, l1Best.out);
    const l2Raw  = await batchQuotes(l2Reqs);
    const l2Best = sortByOut(l2Raw)[0];
    if (!l2Best) return opp;

    const l3Reqs = mkAllQuoteReqs(opp.legs[2].tokenIn, opp.legs[2].tokenOut, l2Best.out);
    const l3Raw  = await batchQuotes(l3Reqs);
    const l3Best = sortByOut(l3Raw)[0];
    if (!l3Best) return opp;

    return {
      ...opp,
      quotedOutputs: [l1Best.out, l2Best.out, l3Best.out],
    };
  } catch {
    return opp; // non-fatal: fall back to original opp; last-leg floor still protects in execute()
  }
}

// ── P4: TELEMETRY & GAS HISTORY HELPERS ──────────────────────────────────

// P4: Write one trade record to the JSONL log. Non-blocking, non-fatal.
function emitTradeRecord(record) {
  if (!tradeLogStream) return;
  try {
    tradeLogStream.write(JSON.stringify(record) + '\n');
  } catch {}
}

// P4: Format capture funnel for heartbeat
function fmtCapture() {
  const pct = crDetected > 0
    ? ((crConfirmed / crDetected) * 100).toFixed(1)
    : '0.0';
  return `detect:${crDetected} stale:${crAbortStale} spike:${crAbortSpike} sim_fail:${crAbortSim} gas_kill:${crAbortGas} submit:${crSubmitted} ok:${crConfirmed} fail:${crFailed} (${pct}%)`;
}

// P4: Record actual gas used after a confirmed trade
function recordGasUsed(type, gasUsed) {
  const h = gasHistory[type];
  if (!h) return;
  h.samples.push(BigInt(gasUsed));
  if (h.samples.length > GAS_HISTORY_WINDOW) h.samples.shift();
}

// P4: Return P90 gas estimate from history, or null if insufficient samples.
// Caller falls through to live estimateGas() when null.
function historicalGasEstimate(type) {
  const h = gasHistory[type];
  if (!h || h.samples.length < 5) return null; // need at least 5 samples
  const sorted = [...h.samples].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const p90idx = Math.min(Math.floor(sorted.length * 0.9), sorted.length - 1);
  return (sorted[p90idx] * 120n) / 100n; // P90 + 20% safety margin
}

// ── S1: SEARCHER PATH ─────────────────────────────────────────────────────
// Called when Searcher.sol is deployed and SEARCHER_ADDR is configured.
// One eth_call → full opportunity struct. Zero gas.
//
// G3: Two calls per block — check() for USDC/USDT, checkWBTC() for WBTC.
// Best by USDC-equivalent profit is returned. WBTC path is non-fatal:
// if checkWBTC throws, USDC/USDT detection continues unaffected.
async function detectViaSearcher(blockNum) {
  if (!searcher || !searcherAvailable) return null;

  let raw;
  try {
    const checkData = searcher.interface.encodeFunctionData('check', [DETECT_AMOUNT, MIN_PROFIT]);
    const checkResult = await alchemyProvider.call({
      to   : await searcher.getAddress(),
      data : checkData,
      gasLimit : 500_000_000n,
    });
    raw = searcher.interface.decodeFunctionResult('check', checkResult)[0];
  } catch (e) {
    warn(`Searcher.check failed — ${e.message?.slice(0, 60)} — suspended for ${SEARCHER_RETRY_BLOCKS} blocks`);
    searcherAvailable     = false;
    searcherDisabledBlock = blockNum; // BF2: stamp so scan() knows when to retry
    return null;
  }

  // ── USDC/USDT opportunity ─────────────────────────────────────────────
  let opp = null;

  if (raw.found) {
    searcherHits++;

    // Reconstruct opportunity in the same shape as Multicall3 path
    // so execute() can handle both paths identically
    opp = {
      type        : raw.legs.length === 2 ? 'SIMPLE' : 'TRIANGULAR',
      path        : raw.description,
      route       : raw.description,
      asset       : raw.asset,
      dec         : 6, // USDC or USDT — both 6 dec
      loan        : raw.loan,
      profit      : raw.profit,
      legs        : raw.legs.map(l => ({
        dexType  : l.dexType,
        router   : l.router,
        tokenIn  : l.tokenIn,
        tokenOut : l.tokenOut,
        v3Fee    : l.v3Fee,
        v2Path   : l.v2Path.length > 0 ? Array.from(l.v2Path) : [l.tokenIn, l.tokenOut],
      })),
      quoteBlock  : blockNum,
      fromSearcher: true,
    };

    // S6: For simple arbs, confirm via Searcher.confirmSimple() before scaling
    if (opp.type === 'SIMPLE' && opp.legs.length === 2) {
      try {
        const buyLeg  = opp.legs[0];
        const sellLeg = opp.legs[1];
        const [confirmedProfit, stillProfitable] = await searcher.confirmSimple(
          opp.asset, buyLeg.tokenOut, opp.loan,
          buyLeg.router,  buyLeg.dexType,  buyLeg.v3Fee,
          sellLeg.router, sellLeg.dexType, sellLeg.v3Fee
        );
        if (!stillProfitable) {
          info(`Searcher confirm: no longer profitable`);
          opp = null; // G3: don't return — WBTC path still runs below
        } else {
          opp.profit = confirmedProfit;
        }
      } catch {
        // Non-fatal — proceed with original profit estimate
      }
    }

    // U5: For tri arbs, confirm via Searcher.confirmTri() before returning
    if (opp && opp.type === 'TRIANGULAR' && opp.legs.length === 3) {
      try {
        const l1 = opp.legs[0];
        const l2 = opp.legs[1];
        const l3 = opp.legs[2];
        const [confirmedProfit, stillProfitable] = await searcher.confirmTri(
          opp.asset, l1.tokenOut, l2.tokenOut, opp.loan,
          l1.router, l1.dexType, l1.v3Fee,
          l2.router, l2.dexType, l2.v3Fee,
          l3.router, l3.dexType, l3.v3Fee
        );
        if (!stillProfitable) {
          info(`Searcher confirmTri: no longer profitable`);
          opp = null; // G3: don't return — WBTC path still runs below
        } else {
          opp.profit = confirmedProfit;
        }
      } catch {
        // Non-fatal — proceed with original profit estimate
      }
    }
  }

  // ── G3: WBTC opportunity — separate entry point to avoid decimal mismatch ──
  // Only attempted when wbtcPriceUSDC has been fetched (avoids division by zero
  // in minProfitWBTC and ensures the USDC-equivalent comparison is meaningful).
  let wbtcOpp = null;
  if (wbtcPriceUSDC > 0n) {
    try {
      const wbtcLoan      = WBTC_SIZE_LADDER[0];
      const wbtcMinProfit = minProfitWBTC(MIN_PROFIT);
      const wbtcCallData  = searcher.interface.encodeFunctionData('checkWBTC', [wbtcLoan, wbtcMinProfit]);
      const wbtcResult    = await alchemyProvider.call({
        to   : await searcher.getAddress(),
        data : wbtcCallData,
        gasLimit : 500_000_000n,
      });
      const wbtcRaw       = searcher.interface.decodeFunctionResult('checkWBTC', wbtcResult)[0];
      if (wbtcRaw.found) {
        wbtcOpp = {
          type        : wbtcRaw.legs.length === 2 ? 'SIMPLE' : 'TRIANGULAR',
          path        : wbtcRaw.description,
          route       : wbtcRaw.description,
          asset       : wbtcRaw.asset,
          dec         : 8,  // WBTC is 8-decimal
          loan        : wbtcRaw.loan,
          profit      : wbtcRaw.profit,
          legs        : wbtcRaw.legs.map(l => ({
            dexType  : l.dexType,
            router   : l.router,
            tokenIn  : l.tokenIn,
            tokenOut : l.tokenOut,
            v3Fee    : l.v3Fee,
            v2Path   : l.v2Path.length > 0 ? Array.from(l.v2Path) : [l.tokenIn, l.tokenOut],
          })),
          quoteBlock  : blockNum,
          fromSearcher: true,
        };
      }
    } catch (e) {
      warn(`Searcher.checkWBTC failed — ${e.message?.slice(0, 60)}`);
    }

    // BF4: Confirm WBTC opportunity before scaling — mirrors the USDC/USDT confirmSimple path.
    // Previously WBTC opps skipped confirmation entirely, wasting a simulation RPC call on
    // already-gone opportunities. Non-fatal: execute()'s simulation remains the final backstop.
    if (wbtcOpp && wbtcOpp.type === 'SIMPLE' && wbtcOpp.legs.length === 2) {
      try {
        const buyLeg  = wbtcOpp.legs[0];
        const sellLeg = wbtcOpp.legs[1];
        const [, stillProfitable] = await searcher.confirmSimple(
          wbtcOpp.asset, buyLeg.tokenOut, wbtcOpp.loan,
          buyLeg.router,  buyLeg.dexType,  buyLeg.v3Fee,
          sellLeg.router, sellLeg.dexType, sellLeg.v3Fee,
        );
        if (!stillProfitable) {
          warn('Searcher confirmSimple (WBTC): no longer profitable');
          wbtcOpp = null;
        }
      } catch { /* non-fatal — execute() simulation is the backstop */ }
    }
  }

  // ── G3: Pick best by USDC-equivalent profit ───────────────────────────
  if (opp && wbtcOpp) {
    const oppUsdc     = opp.profit; // already USDC 6-dec
    const wbtcOppUsdc = wbtcProfitToUsdc(wbtcOpp.profit);
    return wbtcOppUsdc > oppUsdc ? wbtcOpp : opp;
  }
  return opp ?? wbtcOpp ?? null;
}

// ── FALLBACK: SIMPLE ARB DETECTION (Multicall3) ───────────────────────────
async function detectSimple(pairs, blockNum) {
  // G3: detectAmount() selects WBTC_SIZE_LADDER[0] for WBTC pairs, SIZE_LADDER[0] otherwise.
  // Each pair uses its own detect amount; slice indexing by REQS_PER_PAIR is unaffected.
  const fwdReqs = pairs.flatMap(p => mkAllQuoteReqs(p.base.addr, p.mid.addr, detectAmount(p.base.addr)));
  const fwdRaw  = await batchQuotes(fwdReqs);

  const pairBuys = pairs.map((pair, i) => ({
    pair,
    buys: sortByOut(fwdRaw.slice(i * REQS_PER_PAIR, (i + 1) * REQS_PER_PAIR)),
  })).filter(p => p.buys.length > 0);

  updateEthPrice(pairBuys);

  const revReqs  = [];
  const revSlots = [];
  for (const { pair, buys } of pairBuys) {
    for (const buy of buys) {
      const start = revReqs.length;
      mkAllQuoteReqs(pair.mid.addr, pair.base.addr, buy.out).forEach(r => revReqs.push(r));
      revSlots.push({ pairKey: pair.base.addr + pair.mid.addr, pair, buy, start });
    }
  }
  const revRaw = await batchQuotes(revReqs);

  const opps     = [];
  const seenPair = new Set();

  for (const { pairKey, pair, buy, start } of revSlots) {
    if (seenPair.has(pairKey)) continue;
    const sells = sortByOut(revRaw.slice(start, start + REQS_PER_PAIR));
    for (const sell of sells) {
      if (buy.name === sell.name) continue;
      const da     = detectAmount(pair.base.addr); // G3: per-pair detect amount
      const profit = calcProfit(sell.out, da);
      if (profit > 0n) {
        opps.push({
          type      : 'SIMPLE',
          path      : `${pair.base.sym}→${pair.mid.sym}→${pair.base.sym}`,
          route     : `${buy.name}→${sell.name}`,
          asset     : pair.base.addr,
          dec       : pair.base.dec,
          loan      : da,
          profit,
          legs      : [mkLeg(buy, pair.base.addr, pair.mid.addr), mkLeg(sell, pair.mid.addr, pair.base.addr)],
          quoteBlock: blockNum,
          // Track quoted outputs for slippage enforcement
          quotedOutputs: [buy.out, sell.out],
        });
        seenPair.add(pairKey);
        break;
      }
    }
  }
  return opps;
}

// ── FALLBACK: TRIANGULAR DETECTION (Multicall3) ───────────────────────────
async function detectTriangular(combos, blockNum) {
  // G3: detectAmount() selects WBTC_SIZE_LADDER[0] for WBTC-base combos.
  const l1Reqs = combos.flatMap(t => mkAllQuoteReqs(t.base.addr, t.midA.addr, detectAmount(t.base.addr)));
  const l1Raw  = await batchQuotes(l1Reqs);

  const active1 = combos.map((t, i) => ({
    ...t, l1: sortByOut(l1Raw.slice(i * REQS_PER_PAIR, (i + 1) * REQS_PER_PAIR)),
  })).filter(t => t.l1.length > 0);

  if (!active1.length) return [];

  const l2Reqs = active1.flatMap(t => mkAllQuoteReqs(t.midA.addr, t.midB.addr, t.l1[0].out));
  const l2Raw  = await batchQuotes(l2Reqs);

  const active2 = active1.map((t, i) => ({
    ...t, l2: sortByOut(l2Raw.slice(i * REQS_PER_PAIR, (i + 1) * REQS_PER_PAIR)),
  })).filter(t => t.l2.length > 0);

  if (!active2.length) return [];

  const l3Reqs = active2.flatMap(t => mkAllQuoteReqs(t.midB.addr, t.base.addr, t.l2[0].out));
  const l3Raw  = await batchQuotes(l3Reqs);

  const opps = [];
  active2.forEach((t, i) => {
    const l3 = sortByOut(l3Raw.slice(i * REQS_PER_PAIR, (i + 1) * REQS_PER_PAIR));
    if (!l3.length) return;
    const da     = detectAmount(t.base.addr); // G3: per-combo detect amount
    const profit = calcProfit(l3[0].out, da);
    if (profit > 0n) {
      opps.push({
        type      : 'TRIANGULAR',
        path      : `${t.base.sym}→${t.midA.sym}→${t.midB.sym}→${t.base.sym}`,
        route     : `${t.l1[0].name}→${t.l2[0].name}→${l3[0].name}`,
        asset     : t.base.addr,
        dec       : t.base.dec,
        loan      : da,
        profit,
        legs      : [
          mkLeg(t.l1[0], t.base.addr, t.midA.addr),
          mkLeg(t.l2[0], t.midA.addr, t.midB.addr),
          mkLeg(l3[0],   t.midB.addr, t.base.addr),
        ],
        quoteBlock: blockNum,
        quotedOutputs: [t.l1[0].out, t.l2[0].out, l3[0].out],
      });
    }
  });
  return opps;
}

// ── SCALE UP: SIMPLE (Fallback path) ─────────────────────────────────────
async function scaleUpSimple(opp) {
  const midAddr  = opp.legs[0].tokenOut;
  const maxAvail = await getAaveAvailable(opp.asset);
  const sizes    = sizeLadder(opp.asset).filter(s => s <= maxAvail); // G3: asset-aware ladder
  if (!sizes.length) return opp;

  const fwdReqs = [], fwdMap = [];
  for (const sz of sizes) {
    const start = fwdReqs.length;
    mkAllQuoteReqs(opp.asset, midAddr, sz).forEach(r => fwdReqs.push(r));
    fwdMap.push({ sz, start });
  }
  const fwdRaw  = await batchQuotes(fwdReqs);
  const fwdBySz = fwdMap.map(({ sz, start }) => ({
    sz, buys: sortByOut(fwdRaw.slice(start, start + REQS_PER_PAIR)),
  })).filter(t => t.buys.length > 0);

  if (!fwdBySz.length) return opp;

  const revReqs = [], revMap = [];
  for (const { sz, buys } of fwdBySz) {
    const start = revReqs.length;
    mkAllQuoteReqs(midAddr, opp.asset, buys[0].out).forEach(r => revReqs.push(r));
    revMap.push({ sz, bestBuy: buys[0], start });
  }
  const revRaw = await batchQuotes(revReqs);

  let best = { loan: opp.loan, profit: opp.profit, legs: opp.legs, quotedOutputs: opp.quotedOutputs };
  for (const { sz, bestBuy, start } of revMap) {
    const sells = sortByOut(revRaw.slice(start, start + REQS_PER_PAIR));
    for (const sell of sells) {
      if (bestBuy.name === sell.name) continue;
      const profit = calcProfit(sell.out, sz);
      if (profit > best.profit) {
        best = {
          loan: sz, profit,
          legs: [mkLeg(bestBuy, opp.asset, midAddr), mkLeg(sell, midAddr, opp.asset)],
          quotedOutputs: [bestBuy.out, sell.out],
        };
      }
      break;
    }
  }
  return { ...opp, ...best };
}

// ── SCALE UP: TRIANGULAR (Fallback path) ─────────────────────────────────
async function scaleUpTri(opp) {
  const midAAddr = opp.legs[0].tokenOut;
  const midBAddr = opp.legs[1].tokenOut;
  const maxAvail = await getAaveAvailable(opp.asset);
  const sizes    = sizeLadder(opp.asset).filter(s => s <= maxAvail); // G3: asset-aware ladder
  if (!sizes.length) return opp;

  const l1Reqs = [], l1Map = [];
  for (const sz of sizes) {
    const start = l1Reqs.length;
    mkAllQuoteReqs(opp.asset, midAAddr, sz).forEach(r => l1Reqs.push(r));
    l1Map.push({ sz, start });
  }
  const l1Raw  = await batchQuotes(l1Reqs);
  const l1BySz = l1Map.map(({ sz, start }) => ({
    sz, l1: sortByOut(l1Raw.slice(start, start + REQS_PER_PAIR)),
  })).filter(t => t.l1.length > 0);

  if (!l1BySz.length) return opp;

  const l2Reqs = [], l2Map = [];
  for (const { sz, l1 } of l1BySz) {
    const start = l2Reqs.length;
    mkAllQuoteReqs(midAAddr, midBAddr, l1[0].out).forEach(r => l2Reqs.push(r));
    l2Map.push({ sz, l1: l1[0], start });
  }
  const l2Raw  = await batchQuotes(l2Reqs);
  const l2BySz = l2Map.map(({ sz, l1, start }) => ({
    sz, l1, l2: sortByOut(l2Raw.slice(start, start + REQS_PER_PAIR)),
  })).filter(t => t.l2.length > 0);

  if (!l2BySz.length) return opp;

  const l3Reqs = [], l3Map = [];
  for (const { sz, l1, l2 } of l2BySz) {
    const start = l3Reqs.length;
    mkAllQuoteReqs(midBAddr, opp.asset, l2[0].out).forEach(r => l3Reqs.push(r));
    l3Map.push({ sz, l1, l2: l2[0], start });
  }
  const l3Raw = await batchQuotes(l3Reqs);

  let best = { loan: opp.loan, profit: opp.profit, legs: opp.legs, quotedOutputs: opp.quotedOutputs };
  l3Map.forEach(({ sz, l1, l2, start }) => {
    const l3 = sortByOut(l3Raw.slice(start, start + REQS_PER_PAIR));
    if (!l3.length) return;
    const profit = calcProfit(l3[0].out, sz);
    if (profit > best.profit) {
      best = {
        loan: sz, profit,
        legs: [
          mkLeg(l1,    opp.asset, midAAddr),
          mkLeg(l2,    midAAddr,  midBAddr),
          mkLeg(l3[0], midBAddr,  opp.asset),
        ],
        quotedOutputs: [l1.out, l2.out, l3[0].out],
      };
    }
  });
  return { ...opp, ...best };
}

// ── EXECUTE ───────────────────────────────────────────────────────────────
// L3: scanGasPrice pre-fetched by scan() — eliminates duplicate getFeeData() RPC call
async function execute(opp, blockNum, scanGasPrice) {
  if (killed) return;
  if (executing) return;
  executing = true;
  crDetected++;                     // P4: count viable opportunities entering the pipeline
  const submitTs = Date.now();      // P4: submission timestamp (defined outside try for catch access)

  try {
    // X2: Stale-quote protection
    const age = blockNum - (opp.quoteBlock ?? blockNum);
    if (age > CONFIG.MAX_STALE_BLOCKS) {
      crAbortStale++;
      warn(`Stale quote (age: ${age} blocks) — skipping`);
      return;
    }

    // L3: Use gas price pre-fetched in scan() — eliminates a duplicate getFeeData() RPC call.
    // Falls back to a fresh fetch if scan() threw (rare but safe).
    let gasPrice = scanGasPrice ?? cachedGasPrice;
    if (gasPrice === null) {
      try {
        const feeData = await readProvider.getFeeData();
        gasPrice = feeData.gasPrice ?? ARB_BASELINE_GAS;
      } catch {
        gasPrice = ARB_BASELINE_GAS;
      }
    }

    // M4: Gas spike check inside execute() — price can move between scan and execute
    if (isGasSpike(gasPrice)) {
      crAbortSpike++;
      warn(`M4 Gas spike (${fmtGas(gasPrice)}) at execution — aborting`);
      return;
    }

    // G3: Hoist asset classification so every downstream calculation uses the right units.
    const isWbtcOpp    = opp.asset.toLowerCase() === TOKENS.WBTC.addr.toLowerCase();
    const profitInUSDC = isWbtcOpp ? wbtcProfitToUsdc(opp.profit) : opp.profit;

    // S3: Build slippage-enforced legs
    // quotedOutputs may not be set for Searcher path — re-quote if needed
    let legs = opp.legs;
    if (!opp.quotedOutputs || opp.quotedOutputs.length !== legs.length) {
      // Searcher path doesn't provide per-leg intermediate outputs for slippage.
      // Use a conservative floor: Aave repay amount + min profit as the last leg's minimum.
      // G3: nativeMinProfit must be in the borrowed token's units (satoshis for WBTC).
      const aaveFee         = (opp.loan * 9n) / 10000n;
      const toRepay         = opp.loan + aaveFee;
      const nativeMinProfit = isWbtcOpp ? minProfitWBTC(MIN_PROFIT) : MIN_PROFIT;
      const minReturn       = toRepay + nativeMinProfit;
      // For multi-leg we can't enforce intermediates without re-quoting — set 0 on intermediates
      // and enforce the floor on the last leg. The simulation (X1) will catch any revert.
      legs = legs.map((leg, i) => ({
        ...leg,
        amountOutMinimum: i === legs.length - 1 ? minReturn : 0n,
      }));
    } else {
      // Fallback path: enforce slippage on every leg
      legs = legs.map((leg, i) => ({
        ...leg,
        amountOutMinimum: applySlippage(BigInt(opp.quotedOutputs[i])),
      }));
    }

    // G2 + G3: onChainMinProfit tier is determined in USDC-equivalent space (correct G2 curve),
    // then the resulting percentage is applied to opp.profit in its native units so the
    // on-chain contract receives the floor in the borrowed token (satoshis for WBTC, 6-dec for USDC).
    const scaledFloorUSDC  = scaledMinProfit(profitInUSDC, MIN_PROFIT);
    const onChainMinProfit = isWbtcOpp && profitInUSDC > 0n
      ? (opp.profit * scaledFloorUSDC) / profitInUSDC  // same pct applied to satoshis
      : scaledFloorUSDC;                                // USDC/USDT: already correct units

    // P4: Pre-simulation gas filter — avoid RPC round-trip on clearly unprofitable opps.
    // Uses profitInUSDC (always USDC 6-dec) so WBTC opps are compared correctly.
    // Returns null until 5 samples are collected — no filtering during warm-up.
    const histGas = historicalGasEstimate(opp.type);
    if (histGas !== null) {
      const quickCost = gasCostToUSDC(histGas, gasPrice);
      const quickNet  = profitInUSDC - quickCost;
      if (quickNet < MIN_PROFIT) {
        crAbortGas++;
        info(`Pre-sim filter (${fmt(quickNet, 6)}) < min — skipping`);
        return;
      }
    }

    // X1 + P2: Live simulation (always runs — catches reverts regardless of pre-sim filter)
    let gasEstimate;
    try {
      gasEstimate = await contract.executeArbitrage.estimateGas(
        opp.asset, opp.loan, legs, onChainMinProfit
      );
    } catch (simErr) {
      crAbortSim++;
      warn(`Simulation reverted — ${simErr.reason ?? simErr.message?.slice(0, 80)}`);
      return;
    }

    // P1: Off-chain gas cost — profitInUSDC already computed above
    const gasCostUSDC = gasCostToUSDC(gasEstimate, gasPrice);
    const netProfit   = profitInUSDC - gasCostUSDC;
    if (netProfit < MIN_PROFIT) {
      crAbortGas++;
      info(`Net after gas (${fmt(netProfit, 6)}) < min — skipping`);
      return;
    }

    const gasLimit = (gasEstimate * BigInt(100 + CONFIG.GAS_SAFETY_PCT)) / 100n;

    // M3: EIP-1559 gas params
    // G1: Tip scales with net profit — on Arbitrum the cost delta is < $0.01
    const maxFeePerGas         = (gasPrice * BigInt(100 + CONFIG.GAS_SAFETY_PCT)) / 100n;
    const maxPriorityFeePerGas = priorityFeeForProfit(netProfit, gasPrice);

    fire(`EXECUTING — ${opp.type} | ${opp.path} | ${opp.fromSearcher ? 'SEARCHER' : 'MULTICALL'} | tip: ${fmtGas(maxPriorityFeePerGas)}`);
    fire(`Loan: ${fmtLoan(opp.loan)} | Gross: ${fmt(profitInUSDC, 6)} | Gas: ${fmt(gasCostUSDC, 6)} | Net: ${fmt(netProfit, 6)} | Block: ${blockNum}`);

    // M2: Submit via submitContract (direct to Arbitrum sequencer)
    crSubmitted++;
    // L2: Supply cached nonce explicitly — skips eth_getTransactionCount in ethers internals.
    // Increment immediately after submit (tx is in mempool with this nonce).
    // On failure, cachedNonce is reset to null in the catch block — re-fetched next block.
    const txOverrides = {
      gasLimit, maxFeePerGas, maxPriorityFeePerGas, type: 2,
      ...(cachedNonce !== null ? { nonce: cachedNonce } : {}),
    };
    const tx = await submitContract.executeArbitrage(
      opp.asset, opp.loan, legs, onChainMinProfit, txOverrides
    );
    if (cachedNonce !== null) cachedNonce++; // L2: increment locally after successful submit

    info(`TX: ${tx.hash}`);
    const receipt = await tx.wait();

    const actualGasPrice = receipt.gasPrice ?? gasPrice;
    const actualGasCost  = gasCostToUSDC(BigInt(receipt.gasUsed), actualGasPrice);

    let grossProfit = opp.profit;
    for (const log of receipt.logs) {
      try {
        const parsed = CONTRACT_IFACE.parseLog(log);
        if (parsed?.name === 'ArbitrageExecuted') { grossProfit = parsed.args[2]; break; }
      } catch {}
    }

    // G3: Normalise gross profit to USDC so lifetime P&L counters are always in one unit.
    // grossProfit from the event is in the borrowed token (satoshis for WBTC).
    const grossProfitUSDC = isWbtcOpp ? wbtcProfitToUsdc(grossProfit) : grossProfit;
    const actualNet       = grossProfitUSDC - actualGasCost;

    totalTrades++;
    totalGrossProfit += grossProfitUSDC;
    totalGasCost     += actualGasCost;
    totalNetProfit   += actualNet;

    ok(`CONFIRMED — Block ${receipt.blockNumber} | Gross: ${fmt(grossProfitUSDC, 6)} | Gas: ${fmt(actualGasCost, 6)} | Net: ${fmt(actualNet, 6)} | ${fmtTotal()}`);
    crConfirmed++;
    recordGasUsed(opp.type, receipt.gasUsed); // P4: feed gas history
    // P4: Emit success record
    emitTradeRecord({
      ts:             submitTs,
      confirmed:      Date.now(),
      status:         'confirmed',
      type:           opp.type,
      path:           opp.path,
      route:          opp.route ?? '',
      asset:          opp.asset,
      loan:           opp.loan.toString(),
      quotedProfit:   opp.profit.toString(),
      actualProfit:   grossProfit.toString(),
      quotedGasCost:  gasCostUSDC.toString(),
      actualGasCost:  actualGasCost.toString(),
      netProfit:      actualNet.toString(),
      gasUsed:        receipt.gasUsed.toString(),
      gasPrice:       actualGasPrice.toString(),
      txHash:         tx.hash,
      blockSubmitted: blockNum,
      blockIncluded:  receipt.blockNumber,
      latencyMs:      Date.now() - submitTs,
      fromSearcher:   opp.fromSearcher ?? false,
    });
    consecFailures   = 0;
    dailyGasUsdc    += actualGasCost;
    lastConfirmedOpp = null;       // G5: clear cache after success
    checkEthBalance();             // G4: non-blocking background check after each trade

  } catch (e) {
    crFailed++;
    // P4: Emit failure record
    emitTradeRecord({
      ts:           submitTs,
      confirmed:    Date.now(),
      status:       'failed',
      type:         opp.type,
      path:         opp.path,
      route:        opp.route ?? '',
      asset:        opp.asset,
      loan:         opp.loan.toString(),
      quotedProfit: opp.profit.toString(),
      fromSearcher: opp.fromSearcher ?? false,
      error:        e.message?.slice(0, 200) ?? 'unknown',
    });
    try {
      const feeData  = await readProvider.getFeeData();
      const gp       = feeData.gasPrice ?? ARB_BASELINE_GAS;
      const failCost = gasCostToUSDC(BigInt(CONFIG.GAS_LIMIT_FALLBACK), gp);
      totalGasCost   += failCost;
      totalNetProfit -= failCost;
      totalFailedTxs++;
      consecFailures++;
      dailyGasUsdc  += failCost;
      checkRiskLimits();
      err(`TX FAILED — est. cost: ${fmt(failCost, 6)} | ${fmtTotal()} | ${e.message?.slice(0, 100)}`);
      lastConfirmedOpp = null;     // G5: clear cache after failure
      cachedNonce      = null;     // L2: reset nonce — re-fetch next block for safety
    } catch {
      totalFailedTxs++;
      err(`TX FAILED — ${e.message?.slice(0, 100)}`);
      lastConfirmedOpp = null;     // G5: clear cache after failure
      cachedNonce      = null;     // L2: reset nonce on failure
    }
  } finally {
    executing = false;
  }
}

// ── MAIN SCAN ─────────────────────────────────────────────────────────────
async function scan(blockNum) {
  if (executing || scanning || !readProvider) return;
  scanning = true;
  totalScans++;
  const scanStart = Date.now();

  try {
    // M4 + L3: Fetch gas price once per block — cached for execute() (eliminates duplicate fetch)
    cachedGasPrice = null; // clear previous block's value before re-fetching
    try {
      const feeData  = await readProvider.getFeeData();
      cachedGasPrice = feeData.gasPrice ?? ARB_BASELINE_GAS;
      updateGasBaseline(cachedGasPrice);
      if (isGasSpike(cachedGasPrice)) {
        process.stdout.write(`Block ${blockNum} — gas spike (${fmtGas(cachedGasPrice)}), skipping\r`);
        // G5: Retry cached opportunity if still fresh.
        // Pass null as gas price so execute() re-fetches — the spike may have
        // normalized by the time execute() runs (~1 RPC call later). If the spike
        // persists, execute()'s own isGasSpike check aborts safely.
        if (lastConfirmedOpp && !executing) {
          const age = blockNum - (lastConfirmedOpp.quoteBlock ?? blockNum);
          if (age <= CONFIG.MAX_STALE_BLOCKS) {
            info(`G5 spike-retry — cached ${lastConfirmedOpp.type} age: ${age} block(s)`);
            await execute(lastConfirmedOpp, blockNum, null);
          } else {
            lastConfirmedOpp = null;
          }
        }
        return;
      }
    } catch {}

    checkRiskLimits();
    if (killed) return;

    // L2: Pre-fetch nonce while we're about to scan — so execute() gets it for free.
    // Only fetch if null (first block or post-failure). After submit, cachedNonce increments locally.
    if (cachedNonce === null && submitWallet) {
      try { cachedNonce = await submitWallet.getNonce('pending'); } catch {}
    }

    let final = null;

    // Keep ETH and WBTC prices current on both paths.  When Searcher is primary,
    // detectSimple never fires and ethPriceUSDC/wbtcPriceUSDC would stay 0 — this closes that gap.
    await refreshEthPrice(blockNum);
    await refreshWbtcPrice(blockNum); // G3: required before WBTC min-profit conversion

    // ── S1: SEARCHER PATH (primary) ───────────────────────────────
    // BF2: Re-enable Searcher after a transient failure once SEARCHER_RETRY_BLOCKS have elapsed.
    // Prevents a single RPC hiccup from permanently disabling the fast path for the session.
    if (!searcherAvailable && CONFIG.SEARCHER_ADDR && searcherDisabledBlock > 0 &&
        (blockNum - searcherDisabledBlock) >= SEARCHER_RETRY_BLOCKS) {
      searcherAvailable     = true;
      searcherDisabledBlock = 0;
      info(`Searcher re-enabled after ${SEARCHER_RETRY_BLOCKS}-block suspension`);
    }

    if (searcherAvailable) {
      const searcherOpp = await detectViaSearcher(blockNum);
      if (searcherOpp) {
        // G3: WBTC profit is in satoshis — normalise to USDC before comparing with MIN_PROFIT
        const isWbtcSearcher    = searcherOpp.asset.toLowerCase() === TOKENS.WBTC.addr.toLowerCase();
        const searcherProfitUsd = isWbtcSearcher ? wbtcProfitToUsdc(searcherOpp.profit) : searcherOpp.profit;

        if (searcherProfitUsd >= MIN_PROFIT) {
          // Scale up if Searcher found at detect amount — try larger sizes
          let scaled = searcherOpp;
          if (searcherOpp.type === 'SIMPLE') {
            try { scaled = await scaleUpSimple(searcherOpp); }
            catch (e) { warn(`Searcher scaleUp failed — ${e.message?.slice(0, 60)}`); }
          } else if (searcherOpp.type === 'TRIANGULAR') {
            // U3: Re-quote legs to get intermediate outputs for per-leg slippage.
            // REQUIRED for tri arbs — without per-leg quotes, the middle legs would
            // fire with amountOutMinimum = 0, exposing them to sandwich attacks.
            // If requote fails (RPC hiccup), we skip this block and retry next block.
            const requoted = await requoteTriLegs(searcherOpp);
            if (!requoted.quotedOutputs || requoted.quotedOutputs.length !== requoted.legs.length) {
              info(`Searcher tri: requote failed — skipping (slippage guard requires per-leg quotes)`);
              scaled = null; // signal to skip — Multicall3 fallback runs and always has quotedOutputs
            } else {
              scaled = requoted;
              // U1: Scale up to find optimal loan size
              try { scaled = await scaleUpTri(requoted); }
              catch (e) { warn(`Searcher scaleUp failed — ${e.message?.slice(0, 60)}`); }
            }
          }
          // U4: Rebuild path/route fields when scaling found better legs at a larger loan
          if (scaled && scaled.loan > searcherOpp.loan && scaled.legs) {
            const symbols = scaled.legs.map(l => tokenSymbol(l.tokenOut));
            const sources = scaled.legs.map(l => legSourceName(l));
            scaled.path  = [tokenSymbol(scaled.legs[0].tokenIn), ...symbols].join('→');
            scaled.route = sources.join('→');
          }
          if (scaled) {
            scaled.quoteBlock = blockNum;
            // G3: re-normalise after scaling (scaled opp may differ from searcherOpp)
            const isWbtcScaled    = scaled.asset.toLowerCase() === TOKENS.WBTC.addr.toLowerCase();
            const scaledProfitUsd = isWbtcScaled ? wbtcProfitToUsdc(scaled.profit) : scaled.profit;
            if (scaledProfitUsd >= MIN_PROFIT) {
              info(`Block ${blockNum} | SEARCHER | ${fmt(scaledProfitUsd, 6)} | ${scaled.description ?? scaled.path}`);
              if (scaled.loan > searcherOpp.loan) {
                info(`Scaled → ${fmtLoan(scaled.loan)} | ${fmt(scaledProfitUsd, 6)}`);
              }
              final = scaled;
            }
          }
        }
      }
    }

    // ── S2: MULTICALL3 FALLBACK PATH ──────────────────────────────
    if (!final) {
      fallbackHits++;

      // G3: Guard against self-pairs when WBTC is both base and a member of MIDS.
      // WBTC stays in MIDS so USDC→WBTC→USDC detection is preserved; the filter
      // only removes base→base pairs (e.g. WBTC→WBTC) that would always be zero-profit.
      const simplePairs = BASES.flatMap(base =>
        MIDS
          .filter(mid => mid.addr.toLowerCase() !== base.addr.toLowerCase())
          .map(mid => ({ base, mid }))
      );
      const triCombos = BASES.flatMap(base =>
        MIDS.flatMap((midA, i) => MIDS.slice(i + 1).map(midB => ({ base, midA, midB })))
          .filter(c =>
            c.midA.addr.toLowerCase() !== base.addr.toLowerCase() &&
            c.midB.addr.toLowerCase() !== base.addr.toLowerCase()
          )
      );

      const [simpleOpps, triOpps] = await Promise.all([
        detectSimple(simplePairs, blockNum),
        detectTriangular(triCombos, blockNum),
      ]);

      const opps = [...simpleOpps, ...triOpps];

      if (opps.length) {
        // G3: Normalise all profits to USDC for cross-asset comparison and MIN_PROFIT gate.
        // WBTC opps carry profit in satoshis; wbtcProfitToUsdc returns 0n if price not yet fetched.
        const toUsdcProfit = o => o.asset.toLowerCase() === TOKENS.WBTC.addr.toLowerCase()
          ? wbtcProfitToUsdc(o.profit)
          : o.profit;

        opps.sort((a, b) => Number(toUsdcProfit(b) - toUsdcProfit(a)));
        const best         = opps[0];
        const bestProfitUsd = toUsdcProfit(best);
        info(`Block ${blockNum} | ${best.type} | ${fmt(bestProfitUsd, 6)} @ detect | ${best.path} | ${best.route}`);

        let scaled = best;
        try {
          scaled = best.type === 'SIMPLE'
            ? await scaleUpSimple(best)
            : await scaleUpTri(best);
          if (scaled.loan > best.loan) {
            const scaledProfitUsd = toUsdcProfit(scaled);
            info(`Scaled → ${fmtLoan(scaled.loan)} | ${fmt(scaledProfitUsd, 6)}`);
          }
        } catch (e) {
          warn(`ScaleUp failed — ${e.message?.slice(0, 60)}`);
        }

        scaled.quoteBlock = blockNum;

        if (toUsdcProfit(scaled) >= MIN_PROFIT) final = scaled;
        else info(`Below min profit — skipping`);
      } else {
        process.stdout.write(`Block ${blockNum} — no gap\r`);
      }
    }

    if (final) {
      lastConfirmedOpp = final; // G5: cache confirmed opportunity
      await execute(final, blockNum, cachedGasPrice); // L3: pass pre-fetched gas price
    }

  } catch (e) {
    if (e?.message?.includes('destroyed')) return;
    err(`Scan error — ${e.message?.slice(0, 80)}`);
  } finally {
    scanning = false;
    const duration = Date.now() - scanStart;
    if (duration > LAG_WARN_MS) {
      warn(`M5 Lag: ${duration}ms (>${LAG_WARN_MS}ms) — move server closer to the Arbitrum sequencer`);
    }
  }
}

// ── M6: HTTP POLLING FALLBACK ─────────────────────────────────────────────
function startHTTPPolling() {
  if (pollIntervalId) clearInterval(pollIntervalId);
  pollIntervalId = setInterval(async () => {
    try {
      const blockNum = await readProvider.getBlockNumber();
      if (blockNum > lastPolledBlock) {
        lastPolledBlock = blockNum;
        scan(blockNum);
      }
    } catch (e) {
      warn(`HTTP poll error — ${e.message?.slice(0, 60)}`);
      clearInterval(pollIntervalId);
      pollIntervalId = null;
      scheduleReconnect();
    }
  }, ARB_BLOCK_TIME_MS + 50);
}

// ── CLEANUP ───────────────────────────────────────────────────────────────
function cleanup() {
  if (blockListener && readProvider) try { readProvider.off('block', blockListener); } catch {}
  if (pollIntervalId) { clearInterval(pollIntervalId); pollIntervalId = null; }
  if (readProvider)   try { readProvider.destroy();  }  catch {}
  readProvider      = null;
  blockListener     = null;
  scanning          = false;
  usingHTTPFallback = false;
}

// ── M1 + M6: CONNECT ──────────────────────────────────────────────────────
async function connect() {
  cleanup();

  for (let i = 0; i < WS_ENDPOINTS.length; i++) {
    const wsUrl      = WS_ENDPOINTS[(wsEndpointIndex + i) % WS_ENDPOINTS.length];
    const displayUrl = wsUrl.replace(/\/v2\/[^?/]+/, '/v2/***');
    info(`Trying WS [${i + 1}/${WS_ENDPOINTS.length}]: ${displayUrl}`);

    try {
      const ws = new ethers.WebSocketProvider(wsUrl);
      await Promise.race([
        ws.getBlockNumber(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('5s timeout')), 5_000)),
      ]);

      readProvider  = ws;
      wallet        = new ethers.Wallet(CONFIG.PRIVATE_KEY, readProvider);
      contract      = new ethers.Contract(CONFIG.CONTRACT_ADDR, CONTRACT_ABI, wallet);

      // Route eth_call reads through Alchemy which allows higher gas for check()
      if (CONFIG.ALCHEMY_KEY) {
        alchemyProvider = new ethers.JsonRpcProvider(`https://arb-mainnet.g.alchemy.com/v2/${CONFIG.ALCHEMY_KEY}`);
        ok(`Alchemy HTTP provider ready for eth_call`);
      } else {
        alchemyProvider = readProvider;
      }

      mc3           = new ethers.Contract(MC3_ADDR, MC3_ABI, alchemyProvider);
      MIN_PROFIT    = ethers.parseUnits(CONFIG.MIN_PROFIT_USD.toString(), 6);

      // S1: Wire up Searcher if address is configured
      if (CONFIG.SEARCHER_ADDR) {
        searcher          = new ethers.Contract(CONFIG.SEARCHER_ADDR, SEARCHER_ABI, alchemyProvider);
        searcherAvailable = true;
        ok(`S1 Searcher: ${CONFIG.SEARCHER_ADDR}`);
      } else {
        info('SEARCHER_ADDR not set — running Multicall3 fallback path only');
      }

      blockListener = blockNum => scan(blockNum);
      readProvider.on('block', blockListener);
      readProvider.on('error', () => scheduleReconnect());

      try {
        readProvider.websocket.addEventListener('close', () => {
          warn('WS closed — scheduling reconnect');
          scheduleReconnect();
        });
      } catch {}

      usingHTTPFallback = false;
      wsEndpointIndex   = 0;
      reconnectCount    = 0;
      ok(`WS connected — ${displayUrl}`);
      // G4: Log ETH balance on startup
      const ethBal = await checkEthBalance();
      if (ethBal !== null) info(`ETH balance: ${ethers.formatEther(ethBal)} ETH`);
      return;

    } catch (e) {
      warn(`WS failed — ${e.message?.slice(0, 60)}`);
    }
  }

  warn('All WS endpoints failed — switching to HTTP polling (M6)');

  for (let i = 0; i < HTTP_ENDPOINTS.length; i++) {
    const httpUrl = HTTP_ENDPOINTS[(httpEndpointIndex + i) % HTTP_ENDPOINTS.length];
    info(`Trying HTTP [${i + 1}/${HTTP_ENDPOINTS.length}]: ${httpUrl}`);

    try {
      const hp = new ethers.JsonRpcProvider(httpUrl);
      await Promise.race([
        hp.getBlockNumber(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('5s timeout')), 5_000)),
      ]);

      readProvider  = hp;
      wallet        = new ethers.Wallet(CONFIG.PRIVATE_KEY, readProvider);
      contract      = new ethers.Contract(CONFIG.CONTRACT_ADDR, CONTRACT_ABI, wallet);
      mc3           = new ethers.Contract(MC3_ADDR, MC3_ABI, readProvider);
      MIN_PROFIT    = ethers.parseUnits(CONFIG.MIN_PROFIT_USD.toString(), 6);

      if (CONFIG.SEARCHER_ADDR) {
        searcher          = new ethers.Contract(CONFIG.SEARCHER_ADDR, SEARCHER_ABI, readProvider);
        searcherAvailable = true;
      }

      usingHTTPFallback = true;
      startHTTPPolling();
      ok(`HTTP fallback connected — ${httpUrl} (polling every ${ARB_BLOCK_TIME_MS + 50}ms)`);
      // G4: Log ETH balance on startup
      const ethBal = await checkEthBalance();
      if (ethBal !== null) info(`ETH balance: ${ethers.formatEther(ethBal)} ETH`);
      return;

    } catch (e) {
      warn(`HTTP failed — ${e.message?.slice(0, 60)}`);
      httpEndpointIndex = (httpEndpointIndex + 1) % HTTP_ENDPOINTS.length;
    }
  }

  err('All RPC endpoints exhausted — scheduling retry');
  scheduleReconnect();
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectCount++;
  const delay = Math.min(30_000, 2_000 * Math.pow(1.5, reconnectCount));
  warn(`Reconnect in ${(delay / 1_000).toFixed(1)}s (attempt ${reconnectCount})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer  = null;
    wsEndpointIndex = 0;
    connect();
  }, delay);
}

// ── M2: SUBMIT PROVIDER ───────────────────────────────────────────────────
function initSubmitProvider() {
  submitProvider = new ethers.JsonRpcProvider(SEQUENCER_ENDPOINT);
  submitWallet   = new ethers.Wallet(CONFIG.PRIVATE_KEY, submitProvider);
  submitContract = new ethers.Contract(CONFIG.CONTRACT_ADDR, CONTRACT_ABI, submitWallet);
  ok(`M2 Submit provider: ${SEQUENCER_ENDPOINT}`);
}

// ── HEARTBEAT ─────────────────────────────────────────────────────────────
setInterval(async () => {
  const up      = Math.floor((Date.now() - startTime) / 60_000);
  const ethStr  = ethPriceUSDC > 0n
    ? '$' + parseFloat(ethers.formatUnits(ethPriceUSDC, 6)).toFixed(0)
    : 'unknown';
  const wbtcStr = wbtcPriceUSDC > 0n
    ? '$' + parseFloat(ethers.formatUnits(wbtcPriceUSDC, 6)).toFixed(0)
    : 'unknown';
  const mode     = usingHTTPFallback ? 'HTTP-POLL' : 'WS';
  const scanMode = searcherAvailable ? `SEARCHER(${searcherHits})` : `MULTICALL3`;
  const ethBal   = await checkEthBalance(); // G4: check ETH balance each heartbeat
  info(
    `HEARTBEAT | up: ${up}m | rpc: ${mode} | scan: ${scanMode} | fallback: ${fallbackHits} | ` +
    `scans: ${totalScans} | trades: ${totalTrades} | failed: ${totalFailedTxs} | ` +
    `ETH: ${ethStr} | WBTC: ${wbtcStr} | gas_base: ${fmtGas(rollingGasBaseline)} | ${fmtTotal()} | ` +
    `fail: ${consecFailures}/${CONFIG.MAX_CONSEC_FAILURES} | daily_gas: ${fmt(dailyGasUsdc, 6)} | ` +
    `eth_bal: ${ethers.formatEther(ethBal ?? 0n)}`
  );
  info(`Capture — ${fmtCapture()}`);
  const simpleHist = historicalGasEstimate('SIMPLE');
  const triHist    = historicalGasEstimate('TRIANGULAR');
  info(`Gas history — simple: ${simpleHist ? simpleHist.toLocaleString() : 'building'} | tri: ${triHist ? triHist.toLocaleString() : 'building'} | samples: ${gasHistory.SIMPLE.samples.length}S/${gasHistory.TRIANGULAR.samples.length}T`);
}, 10 * 60 * 1_000);

// ── GRACEFUL SHUTDOWN ─────────────────────────────────────────────────────
function shutdown(signal) {
  info(`${signal} — shutting down`);
  if (readProvider)   try { readProvider.destroy();  } catch {}
  if (submitProvider) try { submitProvider.destroy(); } catch {}
  info(`Final | trades: ${totalTrades} | failed: ${totalFailedTxs} | ${fmtTotal()}`);
  if (tradeLogStream) tradeLogStream.end();
  process.exit(0);
}
process.on('SIGTERM',            () => shutdown('SIGTERM'));
process.on('SIGINT',             () => shutdown('SIGINT'));
process.on('SIGUSR1', () => {
  killed         = false;
  consecFailures = 0;
  dailyGasUsdc   = 0n;
  info('Risk governor reset via SIGUSR1 — bot resumed');
});
process.on('uncaughtException',  e  => err(`Uncaught: ${e.message}`));
process.on('unhandledRejection', r  => err(`Rejection: ${r}`));

// ── START ──────────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════');
console.log('  UNCHAINED9 — Flash Arbitrage [v10 — Phase 5: Latency Hardening]');
console.log('  Network  : Arbitrum One');
console.log('  DEXes    : SushiSwap, Camelot (V2) · Uniswap V3, PancakeSwap V3, SushiSwap V3');
console.log('  Scanning : Searcher.sol (on-chain, zero gas) → Multicall3 fallback');
console.log('  Fixes    : amountOutMinimum (S3) · deadline 30s (S4) · confirmQuote (S5/S6) · tri V3 detection+scaling (F1/F2)');
console.log('  Upgrades : tri scaling (U1) · SushiV3 (U2) · tri slippage (U3) · desc sync (U4) · confirmTri (U5)');
console.log('  Phase 2  : profit-tip (G1) · scaled floor (G2) · ETH monitor (G4) · spike-retry (G5)');
console.log('  Phase 3  : WBTC base asset (G3) · checkWBTC entry point · dynamic size ladder · USDC-normalised comparison');
console.log('  Phase 4  : Trade telemetry/JSONL (P4-F1) · Capture rate funnel (P4-F2) · Historical gas P90 filter (P4-F3)');
console.log('  Phase 5  : QuickNode-first RPC (L1) · nonce pre-cache (L2) · gas price threading (L3) · SushiV3 flag (L4)');
console.log(`  Risk     : max ${CONFIG.MAX_CONSEC_FAILURES} consec failures | max $${CONFIG.MAX_DAILY_GAS_USDC}/day gas`);
console.log(`  Min $    : $${CONFIG.MIN_PROFIT_USD} net after gas`);
console.log(`  Slippage : ${CONFIG.SLIPPAGE_BPS}bps (${CONFIG.SLIPPAGE_BPS / 100}%)`);
console.log('  RPC read : Multi-endpoint WS · HTTP fallback polling (M1/M6)');
console.log('  RPC sub  : Direct to Arbitrum sequencer (M2)');
console.log('  Gas      : EIP-1559 · spike guard · rolling baseline (M3/M4)');
console.log('  Monitor  : Block lag (M5) · BigInt P&L · 10m heartbeat · ETH balance (G4)');
console.log('══════════════════════════════════════════════════════════\n');

if (!CONFIG.SEARCHER_ADDR) {
  warn('SEARCHER_ADDR not set — add to .env to enable the zero-gas Searcher scanning path');
  warn('Running Multicall3 fallback path — all features functional but higher per-block RPC load');
}

if (!CONFIG.QUICKNODE_WSS && !CONFIG.QUICKNODE_HTTP && !CONFIG.ALCHEMY_KEY) {
  warn('No private RPC endpoints configured — running on public nodes only');
  warn('Public nodes rate-limit aggressively at 250ms/block cadence — configure QuickNode or Alchemy');
}

initSubmitProvider();

// P4: Open trade log in append mode — never overwrites existing history
try {
  tradeLogStream = fs.createWriteStream(TRADE_LOG_FILE, { flags: 'a' });
  info(`Trade log: ${TRADE_LOG_FILE}`);
} catch (e) {
  warn(`Could not open trade log — ${e.message}`);
}

connect();
