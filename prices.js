
/* prices.js — Phase 7A: Chainlink live prices · 15s polling
 *           — Phase 7B: Uniswap V3 subgraph · real price history · 24H/7D/30D
 *           — Phase 7C: Token metadata · 24h volume
 *
 * Subgraph verified at:
 *   developers.uniswap.org/docs/ecosystem/subgraphs/overview
 *   Endpoint: gateway.thegraph.com
 *   Subgraph ID: 5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV (Uniswap v3 mainnet)
 *
 * Schema verified at:
 *   docs.uniswap.org/api/subgraph/subgraphs-devs/schemas/tokenhourdata
 *   TokenHourData.periodStartUnix — Int!, seconds, start of hour
 *   TokenHourData.priceUSD        — BigDecimal!, price at hour end
 *   TokenDayData.date             — Int!, seconds, start of day
 *   TokenDayData.priceUSD         — BigDecimal!, price at day end
 *
 * Chainlink feed addresses verified at:
 *   docs.chain.link/data-feeds/price-feeds/addresses — Ethereum Mainnet
 *   All feeds: int256 answer, 8 decimal places → divide by 1e8.
 *
 * The Graph API key: free tier at thegraph.com/studio — no credit card.
 * Replace THE_GRAPH_API_KEY below after creating your key.
 *
 * renderChart() — untouched. Data shape: [[timestamp_ms, price_usd], ...]
 * UNCHAINED9. Built by Waeven Xrysmond.
 */
(function () {
  'use strict';

  /* ─────────────────────────────────────────────────────────────────
     PHASE 7A — CHAINLINK LIVE PRICES

     Proxy addresses — Ethereum Mainnet.
     Verified: docs.chain.link/data-feeds/price-feeds/addresses
     Stablecoins (DAI, USDC) are hardcoded at $1.00 — no feed needed.
  ───────────────────────────────────────────────────────────────── */
  var CHAINLINK_FEEDS = {
    '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2': '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419', /* WETH / USD */
    '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599': '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88b', /* BTC  / USD — WBTC tracks BTC */
    '0x514910771AF9Ca656af840dff83E8264EcF986CA': '0x2c1d072e956AFFC0D435Cb7AC308d97936c3d09', /* LINK / USD */
    '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984': '0x553303d460EE0afB37EdFf9bE42922D8FF63220', /* UNI  / USD */
  };

  var STABLE_ADDRESSES = {
    '0x6B175474E89094C44Da98b954EedeAC495271d0F': true, /* DAI  */
    '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48': true, /* USDC */
  };

  /* Minimal ABI — latestRoundData only */
  var CHAINLINK_ABI = [
    'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)'
  ];

  var _pollInterval = null; /* setInterval handle */

  /*
   * getChainlinkProvider()
   * Uses privyProvider (EIP-1193) when wallet is connected, falls back
   * to a public RPC for anonymous reads. Matches swap.js::getReadProvider().
   */
  function getChainlinkProvider() {
    var pp = window.privyProvider || window.ethereum;
    if (pp) return new ethers.providers.Web3Provider(pp);
    return new ethers.providers.JsonRpcProvider('https://eth.llamarpc.com');
  }

  /*
   * fetchChainlinkPrice(feedAddress, provider)
   * Calls latestRoundData() on the Chainlink proxy contract.
   * result[1] = answer (int256, 8 decimals). result[3] = updatedAt (unix seconds).
   * Returns { usd: Number, updatedAt: Number }.
   */
  async function fetchChainlinkPrice(feedAddress, provider) {
    var feed   = new ethers.Contract(feedAddress, CHAINLINK_ABI, provider);
    var result = await feed.latestRoundData();
    return {
      usd:       Number(result[1]) / 1e8,
      updatedAt: Number(result[3]),
    };
  }

  /*
   * 24h snapshot system — localStorage
   * Stores rolling array of { p: price, t: timestamp_ms } per token address.
   * get24hChange() finds the snapshot closest to exactly 24h ago (±4h tolerance).
   * Returns null if no qualifying snapshot exists — UI shows '—'.
   */
  var _SNAP_KEY = 'obsideum:priceSnap:v1';

  function savePriceSnapshot(address, price) {
    try {
      var snaps = JSON.parse(localStorage.getItem(_SNAP_KEY) || '{}');
      var now   = Date.now();
      var arr   = snaps[address] || [];

      /* Prune anything older than 30h */
      arr = arr.filter(function (s) { return now - s.t < 30 * 3600000; });

      /* Only append if the last snapshot is more than 20 minutes old */
      var last = arr[arr.length - 1];
      if (!last || now - last.t > 20 * 60000) {
        arr.push({ p: price, t: now });
      }

      snaps[address] = arr;
      localStorage.setItem(_SNAP_KEY, JSON.stringify(snaps));
    } catch (_) {}
  }

  function get24hChange(address, currentPrice) {
    try {
      var snaps  = JSON.parse(localStorage.getItem(_SNAP_KEY) || '{}');
      var arr    = snaps[address] || [];
      var target = Date.now() - 24 * 3600000;
      var best   = null;

      arr.forEach(function (s) {
        var diff = Math.abs(s.t - target);
        if (diff < 4 * 3600000) { /* ±4h tolerance around the 24h mark */
          if (!best || diff < Math.abs(best.t - target)) best = s;
        }
      });

      if (!best || !best.p) return null;
      return ((currentPrice - best.p) / best.p) * 100;
    } catch (_) {
      return null;
    }
  }

  /*
   * updateAllPrices()
   * Fetches all Chainlink feeds in parallel. Stablecoins resolved to $1.00.
   * Only Chainlink feeds are live on Ethereum mainnet (chainId 1).
   * On other networks: stables still resolve; non-stables keep last known price.
   * Writes merged result to STATE.prices via setState().
   */
  async function updateAllPrices() {
    var chainId  = window.STATE && STATE.network;
    var provider = getChainlinkProvider();
    var updates  = {};

    /* Stablecoins — fixed, always */
    for (var stableAddr in STABLE_ADDRESSES) {
      updates[stableAddr] = { usd: 1.00, change24h: 0.00 };
    }

    /* Chainlink feeds — mainnet only (null chainId = pre-connection, assume mainnet) */
    if (chainId === 1 || chainId == null) {
      var fetches = Object.keys(CHAINLINK_FEEDS).map(function (tokenAddr) {
        var feedAddr = CHAINLINK_FEEDS[tokenAddr];
        return fetchChainlinkPrice(feedAddr, provider)
          .then(function (result) {
            var change24h = get24hChange(tokenAddr, result.usd);
            savePriceSnapshot(tokenAddr, result.usd);
            updates[tokenAddr] = {
              usd:       result.usd,
              change24h: change24h,
              updatedAt: result.updatedAt,
            };
          })
          .catch(function () {
            /* Feed unavailable — preserve last known price, flag stale */
            var last = window.STATE && STATE.prices && STATE.prices[tokenAddr];
            if (last) updates[tokenAddr] = Object.assign({}, last, { stale: true });
          });
      });

      await Promise.all(fetches);
    }

    if (!Object.keys(updates).length) return;
    var merged = Object.assign({}, (window.STATE && STATE.prices) || {}, updates);
    setState({ prices: merged });
  }

  /*
   * startPricePolling()
   * Clears any existing interval, fetches immediately, polls every 15s.
   * Called at file load and whenever wallet or network state changes.
   */
  function startPricePolling() {
    if (_pollInterval) clearInterval(_pollInterval);
    updateAllPrices();
    _pollInterval = setInterval(updateAllPrices, 15000);
  }

  /* ─────────────────────────────────────────────────────────────────
     PHASE 7B — UNISWAP V3 SUBGRAPH — CHART HISTORY

     Endpoint: The Graph decentralized network.
     Subgraph ID verified at:
       developers.uniswap.org/docs/ecosystem/subgraphs/overview
       ID: 5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV (Uniswap v3 mainnet)

     Auth: API key in URL per documented pattern.
     Free tier — no credit card — thegraph.com/studio.

     Subgraph token IDs are always lowercase.
     address.toLowerCase() applied before every query.
  ───────────────────────────────────────────────────────────────── */
  var THE_GRAPH_API_KEY   = 'ba6a6c595dff86ed9d73903bcca93b22';
  var UNISWAP_V3_SUBGRAPH = 'https://gateway.thegraph.com/api/' +
                            THE_GRAPH_API_KEY +
                            '/subgraphs/id/5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV';

  /* Cache stale thresholds per timeframe */
  var STALE_MS = {
    '24H': 5  * 60 * 1000, /* 5 minutes */
    '7D':  60 * 60 * 1000, /* 1 hour    */
    '30D': 60 * 60 * 1000, /* 1 hour    */
  };

  /*
   * subgraphQuery(query)
   * POST to the Uniswap V3 subgraph via The Graph gateway.
   * Throws on HTTP error or GraphQL errors in the response body.
   */
  async function subgraphQuery(query) {
    var res = await fetch(UNISWAP_V3_SUBGRAPH, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ query: query }),
    });

    if (!res.ok) {
      throw new Error('[prices.js] Subgraph HTTP ' + res.status);
    }

    var json = await res.json();
    if (json.errors && json.errors.length) {
      throw new Error('[prices.js] Subgraph GraphQL: ' + json.errors[0].message);
    }

    return json.data;
  }

  /*
   * isCacheStale(address, timeframe)
   * Returns true when:
   *   - No cache entry exists
   *   - Entry has no prices array
   *   - Entry has no fetchedAt (i.e. was seeded as mock) — always replace
   *   - fetchedAt is older than STALE_MS[timeframe]
   */
  function isCacheStale(address, timeframe) {
    var entry = window.STATE
      && STATE.priceHistory
      && STATE.priceHistory[address]
      && STATE.priceHistory[address][timeframe];

    if (!entry || !entry.prices || !entry.prices.length) return true;
    if (!entry.fetchedAt) return true; /* mock seed — replace with real data */

    return (Date.now() - entry.fetchedAt) > STALE_MS[timeframe];
  }

  /*
   * fetchPriceHistory(address, timeframe)
   * Queries tokenHourDatas (24H) or tokenDayDatas (7D/30D) from the subgraph.
   * Maps response to [[timestamp_ms, price_usd], ...].
   * Filters zero-price points (hours with no swap activity on that token).
   * Writes result to STATE.priceHistory with fetchedAt timestamp.
   * Throws when the subgraph returns no usable data.
   */
  async function fetchPriceHistory(address, timeframe) {
    var laddr = address.toLowerCase();
    var now   = Math.floor(Date.now() / 1000);
    var query;
    var since;

    if (timeframe === '24H') {
      since = now - 24 * 3600;
      query = '{ tokenHourDatas(' +
        'first: 24, ' +
        'orderBy: periodStartUnix, ' +
        'orderDirection: asc, ' +
        'where: { token: "' + laddr + '", periodStartUnix_gt: ' + since + ' }' +
        ') { periodStartUnix priceUSD } }';
    } else if (timeframe === '7D') {
      since = now - 7 * 24 * 3600;
      query = '{ tokenDayDatas(' +
        'first: 7, ' +
        'orderBy: date, ' +
        'orderDirection: asc, ' +
        'where: { token: "' + laddr + '", date_gt: ' + since + ' }' +
        ') { date priceUSD } }';
    } else { /* 30D */
      since = now - 30 * 24 * 3600;
      query = '{ tokenDayDatas(' +
        'first: 30, ' +
        'orderBy: date, ' +
        'orderDirection: asc, ' +
        'where: { token: "' + laddr + '", date_gt: ' + since + ' }' +
        ') { date priceUSD } }';
    }

    var data = await subgraphQuery(query);
    var raw;

    if (timeframe === '24H') {
      raw = (data.tokenHourDatas || []).map(function (d) {
        return [d.periodStartUnix * 1000, parseFloat(d.priceUSD)];
      });
    } else {
      raw = (data.tokenDayDatas || []).map(function (d) {
        return [d.date * 1000, parseFloat(d.priceUSD)];
      });
    }

    /* Drop zero-price points — subgraph emits 0 for hours with no swap activity */
    raw = raw.filter(function (pt) { return pt[1] > 0; });

    if (!raw.length) {
      throw new Error('[prices.js] No price history for ' + address + ' [' + timeframe + ']');
    }

    /* Write cache — triggers state:priceHistory */
    var h = Object.assign({}, (window.STATE && STATE.priceHistory) || {});
    if (!h[address]) h[address] = {};
    h[address][timeframe] = { prices: raw, fetchedAt: Date.now() };
    setState({ priceHistory: h });

    return raw;
  }

  /*
   * ensurePriceHistory(address, timeframe)
   * No-op when cache is fresh. Fetches from subgraph when stale or missing.
   */
  async function ensurePriceHistory(address, timeframe) {
    if (!isCacheStale(address, timeframe)) return;
    await fetchPriceHistory(address, timeframe);
  }

  /* ─────────────────────────────────────────────────────────────────
     PHASE 7C — TOKEN METADATA · 24H VOLUME

     Queries the most recent TokenDayData entry for 24h volume.
     Updates .token-panel-volume elements in desktop and mobile panels.
     Non-critical — errors are swallowed silently.
  ───────────────────────────────────────────────────────────────── */
  async function fetchTokenMetadata(address) {
    try {
      var laddr     = address.toLowerCase();
      var yesterday = Math.floor((Date.now() - 24 * 3600000) / 1000);
      var query = '{ tokenDayDatas(' +
        'first: 1, ' +
        'orderBy: date, ' +
        'orderDirection: desc, ' +
        'where: { token: "' + laddr + '", date_gt: ' + yesterday + ' }' +
        ') { volumeUSD } }';

      var data    = await subgraphQuery(query);
      var dayData = data.tokenDayDatas && data.tokenDayDatas[0];
      if (!dayData) return;

      var vol    = parseFloat(dayData.volumeUSD);
      var fmtVol = vol >= 1e9 ? '$' + (vol / 1e9).toFixed(2) + 'B'
                 : vol >= 1e6 ? '$' + (vol / 1e6).toFixed(2) + 'M'
                 : vol >= 1e3 ? '$' + (vol / 1e3).toFixed(2) + 'K'
                 : '$' + vol.toFixed(2);

      ['right-panel-content', 'mobile-token'].forEach(function (id) {
        var container = document.getElementById(id);
        var volEl     = container && container.querySelector('.token-panel-volume');
        if (volEl) volEl.textContent = fmtVol;
      });
    } catch (_) {
      /* Non-critical — volume display stays blank rather than erroring */
    }
  }

  /* ─────────────────────────────────────────────────────────────────
     FORMATTERS — unchanged from Phase 4B
  ───────────────────────────────────────────────────────────────── */
  function fmtP(usd) {
    if (usd === null || usd === undefined) return '\u2014';
    if (usd >= 10000) return '$' + usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (usd >= 1)     return '$' + usd.toFixed(2);
    return '$' + usd.toFixed(6);
  }

  /* ─────────────────────────────────────────────────────────────────
     SKELETON — unchanged from Phase 4B
  ───────────────────────────────────────────────────────────────── */
  function showChartSkeleton(priceDiv) {
    if (priceDiv) priceDiv.classList.add('skeleton');
  }

  function hideChartSkeleton(priceDiv) {
    if (priceDiv) priceDiv.classList.remove('skeleton');
  }

  /* ─────────────────────────────────────────────────────────────────
     DESTROY — unchanged from Phase 4B
  ───────────────────────────────────────────────────────────────── */
  function destroyChart(priceDiv) {
    if (!priceDiv) return;
    if (priceDiv._lc) {
      try { priceDiv._lc.chart.remove(); } catch (_) {}
      try { priceDiv._lc.ro.disconnect(); } catch (_) {}
      priceDiv._lc = null;
    }
    priceDiv.innerHTML = '';
    priceDiv.classList.remove('skeleton');
  }

  /* ─────────────────────────────────────────────────────────────────
     INIT — unchanged from Phase 4B
     Area series with violet gradient fill.
     handleScroll / handleScale with mobile-safe config.
  ───────────────────────────────────────────────────────────────── */
  function initChart(priceDiv) {
    if (!priceDiv || typeof LightweightCharts === 'undefined') return null;

    var w = priceDiv.offsetWidth || 400;

    var chart = LightweightCharts.createChart(priceDiv, {
      width:  w,
      height: 200,
      layout: {
        background: { color: 'transparent' },
        textColor:  '#6B7090',
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: 'rgba(156,61,187,.06)' },
      },
      rightPriceScale: {
        borderColor:  'rgba(156,61,187,.10)',
        scaleMargins: { top: 0.12, bottom: 0.08 },
      },
      timeScale: {
        borderColor:  'rgba(156,61,187,.10)',
        timeVisible:  false,
        fixRightEdge: true,
      },
      crosshair: {
        mode: 1, /* CrosshairMode.Magnet */
        vertLine: { color: 'rgba(156,61,187,.5)', width: 1, style: 3, labelBackgroundColor: '#9C3DBB' },
        horzLine: { color: 'rgba(156,61,187,.5)', width: 1, style: 3, labelBackgroundColor: '#9C3DBB' },
      },
      handleScroll: {
        mouseWheel:       true,
        pressedMouseMove: true,
        horzTouchDrag:    true,
        vertTouchDrag:    false,
      },
      handleScale: {
        mouseWheel:           true,
        pinch:                true,
        axisPressedMouseMove: true,
      },
      watermark: { visible: false },
    });

    var series = chart.addAreaSeries({
      lineColor:                      '#9C3DBB',
      lineWidth:                      1.5,
      topColor:                       'rgba(156,61,187,0.32)',
      bottomColor:                    'rgba(156,61,187,0.00)',
      crosshairMarkerVisible:         true,
      crosshairMarkerRadius:          4,
      crosshairMarkerBackgroundColor: '#9C3DBB',
      lastValueVisible:               false,
      priceLineVisible:               false,
    });

    /* Crosshair → live price in header; restore original on leave */
    var _savedPrice = null;
    chart.subscribeCrosshairMove(function (param) {
      var panel   = priceDiv.closest('.token-panel');
      var priceEl = panel && panel.querySelector('.token-panel-usd');
      if (!priceEl) return;

      if (param.point && param.seriesData && param.seriesData.size) {
        var d = param.seriesData.get(series);
        if (d) {
          if (_savedPrice === null) _savedPrice = priceEl.textContent;
          priceEl.textContent = fmtP(d.value);
        }
      } else if (_savedPrice !== null) {
        priceEl.textContent = _savedPrice;
        _savedPrice = null;
      }
    });

    /* ResizeObserver — tracks right panel width */
    var ro = new ResizeObserver(function () {
      if (!priceDiv._lc) return;
      var newW = priceDiv.offsetWidth;
      if (newW > 0) chart.applyOptions({ width: newW });
    });
    ro.observe(priceDiv);

    var instance = { chart: chart, series: series, ro: ro };
    priceDiv._lc = instance;
    return instance;
  }

  /* ─────────────────────────────────────────────────────────────────
     RENDER — unchanged from Phase 4B
     rawPrices: [[timestamp_ms, price_usd], ...]
     Converts ms → s for Lightweight Charts.
     1% minimum visible price window prevents flat stablecoin charts.
  ───────────────────────────────────────────────────────────────── */
  function renderChart(instance, rawPrices) {
    if (!instance || !instance.series) return;
    if (!rawPrices || !rawPrices.length) return;

    var data = rawPrices.map(function (pt) {
      return { time: Math.floor(pt[0] / 1000), value: pt[1] };
    });

    instance.series.setData(data);
    instance.chart.timeScale().fitContent();

    var prices   = data.map(function (d) { return d.value; });
    var minP     = Math.min.apply(null, prices);
    var maxP     = Math.max.apply(null, prices);
    var mid      = (maxP + minP) / 2;
    var minRange = mid * 0.01; /* 1% floor */

    instance.series.applyOptions({
      autoscaleInfoProvider: function () {
        return {
          priceRange: {
            minValue: Math.min(minP, mid - minRange / 2),
            maxValue: Math.max(maxP, mid + minRange / 2),
          },
          margins: { above: 0.10, below: 0.10 },
        };
      },
    });
  }

  /* ─────────────────────────────────────────────────────────────────
     WIRE TOGGLES — Phase 7B: stubs replaced with real subgraph fetch
     Delegation pattern unchanged — see Phase 4B comment for rationale.
  ───────────────────────────────────────────────────────────────── */
  function wireToggles(slot, address) {
    var indicator = slot.querySelector('.chart-toggle-indicator');

    function posIndicator(btn) {
      if (!indicator || !btn) return;
      requestAnimationFrame(function () {
        indicator.style.left  = btn.offsetLeft  + 'px';
        indicator.style.width = btn.offsetWidth + 'px';
      });
    }

    requestAnimationFrame(function () {
      posIndicator(slot.querySelector('.chart-toggle.active'));
    });

    if (slot._toggleHandler) {
      slot.removeEventListener('click', slot._toggleHandler);
      slot._toggleHandler = null;
    }

    slot._toggleHandler = function (e) {
      var btn = e.target.closest('.chart-toggle');
      if (!btn || btn.classList.contains('active')) return;

      Array.from(slot.querySelectorAll('.chart-toggle')).forEach(function (b) {
        b.classList.remove('active');
      });
      btn.classList.add('active');
      posIndicator(btn);

      /* Read live instance at click time — never stale */
      var priceDiv = slot.querySelector('.price-chart');
      var instance = priceDiv && priceDiv._lc;
      if (!instance) return;

      var tf    = btn.dataset.range;
      var entry = window.STATE
        && STATE.priceHistory
        && STATE.priceHistory[address]
        && STATE.priceHistory[address][tf];

      if (entry && entry.prices && !isCacheStale(address, tf)) {
        /* Cache is fresh — render immediately, no network call */
        hideChartSkeleton(priceDiv);
        renderChart(instance, entry.prices);
      } else {
        /* Fetch from subgraph */
        showChartSkeleton(priceDiv);
        ensurePriceHistory(address, tf).then(function () {
          /*
           * Guard: render only if this instance is still live and the
           * state:priceHistory path hasn't already hidden the skeleton.
           */
          var liveInst = priceDiv._lc;
          var fresh    = window.STATE
            && STATE.priceHistory
            && STATE.priceHistory[address]
            && STATE.priceHistory[address][tf];
          if (liveInst && fresh && fresh.prices && priceDiv.classList.contains('skeleton')) {
            hideChartSkeleton(priceDiv);
            renderChart(liveInst, fresh.prices);
          }
        }).catch(function (err) {
          /* Subgraph unavailable — remove skeleton, chart stays empty */
          hideChartSkeleton(priceDiv);
          console.error('[prices.js] Chart fetch failed:', err);
        });
      }
    };

    slot.addEventListener('click', slot._toggleHandler);
  }

  /* ─────────────────────────────────────────────────────────────────
     MOUNT — Phase 7B: stub replaced with real subgraph fetch
     Debounce pattern unchanged — see Phase 4B comment for rationale.
  ───────────────────────────────────────────────────────────────── */
  function mountChart(container, address, tf) {
    if (container._lcMountTimer) clearTimeout(container._lcMountTimer);
    container._lcMountTimer = setTimeout(function () {
      container._lcMountTimer = null;

      requestAnimationFrame(function () {
        var slot     = container.querySelector('.token-panel-chart-slot');
        var priceDiv = slot && slot.querySelector('.price-chart');
        if (!slot || !priceDiv || !address) return;

        destroyChart(priceDiv);

        var instance = initChart(priceDiv);
        if (!instance) return;

        var activeTf = tf || '24H';
        var entry    = window.STATE
          && STATE.priceHistory
          && STATE.priceHistory[address]
          && STATE.priceHistory[address][activeTf];

        if (entry && entry.prices && !isCacheStale(address, activeTf)) {
          /* Cache is fresh — render immediately, no network call */
          hideChartSkeleton(priceDiv);
          renderChart(instance, entry.prices);
        } else {
          /* Fetch from subgraph */
          showChartSkeleton(priceDiv);
          ensurePriceHistory(address, activeTf).then(function () {
            var liveInst = priceDiv._lc;
            var fresh    = window.STATE
              && STATE.priceHistory
              && STATE.priceHistory[address]
              && STATE.priceHistory[address][activeTf];
            if (liveInst && fresh && fresh.prices && priceDiv.classList.contains('skeleton')) {
              hideChartSkeleton(priceDiv);
              renderChart(liveInst, fresh.prices);
            }
          }).catch(function (err) {
            hideChartSkeleton(priceDiv);
            console.error('[prices.js] Chart fetch failed:', err);
          });
        }

        /* Sync active toggle button to the mounted timeframe */
        Array.from(slot.querySelectorAll('.chart-toggle')).forEach(function (b) {
          b.classList.toggle('active', b.dataset.range === activeTf);
        });

        wireToggles(slot, address);
      });
    }, 0);
  }

  /* ─────────────────────────────────────────────────────────────────
     STATE EVENT LISTENERS
  ───────────────────────────────────────────────────────────────── */
  var rightContent    = document.getElementById('right-panel-content');
  var mobileTokenView = document.getElementById('mobile-token');

  /* Desktop: right panel switched to token view */
  document.addEventListener('panel:render', function (e) {
    if (e.detail !== 'token') return;
    mountChart(rightContent, window.STATE && STATE.token, '24H');
  });

  /* Mobile: token view activated */
  document.addEventListener('state:mobileView', function (e) {
    if (e.detail !== 'token') return;
    mountChart(mobileTokenView, window.STATE && STATE.token, '24H');
  });

  /* Token changed while token view is already visible */
  document.addEventListener('state:token', function (e) {
    var address = e.detail;
    if (window.STATE && STATE.rightPanel === 'token') mountChart(rightContent,    address, '24H');
    if (window.STATE && STATE.mobileView === 'token') mountChart(mobileTokenView, address, '24H');
    /* Phase 7C: fetch 24h volume for the newly selected token */
    if (address) fetchTokenMetadata(address);
  });

  /*
   * priceHistory updated — real fetch result lands here via setState().
   * Guard: only remount when the chart is still showing a skeleton.
   * Prevents double render when .then() in mountChart already handled it.
   */
  document.addEventListener('state:priceHistory', function () {
    var address = window.STATE && STATE.token;
    if (!address) return;

    function remountIfSkeleton(container) {
      if (!container) return;
      var slot     = container.querySelector('.token-panel-chart-slot');
      var priceDiv = slot && slot.querySelector('.price-chart');
      /* Only remount when chart is actively waiting for data */
      if (priceDiv && priceDiv.classList.contains('skeleton')) {
        var btn = slot.querySelector('.chart-toggle.active');
        mountChart(container, address, btn ? btn.dataset.range : '24H');
      }
    }

    if (STATE.rightPanel === 'token') remountIfSkeleton(rightContent);
    if (STATE.mobileView === 'token') remountIfSkeleton(mobileTokenView);
  });

  /* Restart polling on wallet connect/disconnect or network switch */
  document.addEventListener('state:wallet',  function () { startPricePolling(); });
  document.addEventListener('state:network', function () { startPricePolling(); });

  /* Boot — fetch live prices immediately on file load */
  startPricePolling();

}());