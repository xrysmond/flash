// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

// ════════════════════════════════════════════════════════════════════
// INTERFACES
// ════════════════════════════════════════════════════════════════════

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

// Uniswap V2 compatible — SushiSwap, Camelot
interface IV2Router {
    function swapExactTokensForTokens(
        uint    amountIn,
        uint    amountOutMin,   // FIX S3: was 0 in v1, now enforced per-leg
        address[] calldata path,
        address to,
        uint    deadline
    ) external returns (uint[] memory amounts);
}

// Uniswap V3
interface IV3Router {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24  fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;   // FIX S3: was 0 in v1, now enforced per-leg
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params)
        external payable returns (uint256 amountOut);
}

// Aave V3
interface IAavePool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16  referralCode
    ) external;
}

// ════════════════════════════════════════════════════════════════════
// FLASH ARBITRAGE v2
// Network  : Arbitrum One
// Supports : V2 + V3 DEXes, 2-leg simple, 3-leg triangular, N-leg
// Security : Reentrancy guard, USDT-safe approvals, owner-only,
//            per-leg slippage guard, tight deadlines, safe transfer
//
// Changes from v1:
//   FIX S3 — amountOutMinimum per leg (sandwich protection)
//   FIX S4 — deadline block.timestamp + 30 (was +300; 5 min too wide)
//   FIX S7 — safe transfer with return value check
// ════════════════════════════════════════════════════════════════════

contract FlashArbitrage {

    IAavePool public constant AAVE_POOL =
        IAavePool(0x794a61358D6845594F94dc1DB02A252b5b4814aD);

    address public immutable owner;

    uint256 private _status;
    uint256 private constant NOT_ENTERED = 1;
    uint256 private constant ENTERED     = 2;

    // ── One swap in the arbitrage chain ──────────────────────────
    // dexType 0 = V2 (use v2Path)
    // dexType 1 = V3 (use tokenIn/tokenOut/v3Fee)
    //
    // FIX S3: amountOutMinimum added — scanner sets this from quoted output
    // minus slippage tolerance before calling executeArbitrage().
    // A sandwicher that moves price enough to violate this floor causes
    // the swap to revert, reverting the entire flash loan atomically.
    struct Leg {
        uint8     dexType;
        address   router;
        address   tokenIn;
        address   tokenOut;
        uint24    v3Fee;
        address[] v2Path;
        uint256   amountOutMinimum;  // FIX S3: minimum acceptable output for this leg
    }

    event ArbitrageExecuted(
        address indexed asset,
        uint256 loan,
        uint256 profit
    );

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    modifier nonReentrant() {
        require(_status != ENTERED, "Reentrant");
        _status = ENTERED;
        _;
        _status = NOT_ENTERED;
    }

    constructor() {
        owner   = msg.sender;
        _status = NOT_ENTERED;
    }

    // ─────────────────────────────────────────────────────────────
    // ENTRY POINT
    //
    // borrowAsset  : token to flash-loan (e.g. USDC)
    // borrowAmount : how much to borrow
    // legs         : ordered swap chain — minimum 2
    //                Each leg.amountOutMinimum must be set by scanner
    //                to quoted output × (1 − slippage).
    // minProfit    : revert if profit below this (enforced on-chain)
    // ─────────────────────────────────────────────────────────────
    function executeArbitrage(
        address        borrowAsset,
        uint256        borrowAmount,
        Leg[] calldata legs,
        uint256        minProfit
    ) external onlyOwner nonReentrant {
        require(legs.length >= 2, "Need at least 2 legs");
        require(
            legs[legs.length - 1].tokenOut == borrowAsset,
            "Last leg must return borrow token"
        );
        bytes memory params = abi.encode(legs, minProfit);
        AAVE_POOL.flashLoanSimple(address(this), borrowAsset, borrowAmount, params, 0);
    }

    // ─────────────────────────────────────────────────────────────
    // AAVE CALLBACK
    // ─────────────────────────────────────────────────────────────
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        require(msg.sender == address(AAVE_POOL), "Caller not Aave");
        require(initiator == address(this),        "Bad initiator");

        (Leg[] memory legs, uint256 minProfit) =
            abi.decode(params, (Leg[], uint256));

        uint256 amountToRepay = amount + premium;
        uint256 currentAmount = amount;

        // FIX S4: deadline = block.timestamp + 30
        // Arbitrum blocks are ~250ms. Five minutes (+300) means a tx can sit
        // in queue for 1,200 blocks after your quote is stale — during which
        // a price move can make it unprofitable or negative. 30 seconds = ~120
        // blocks. Enough to land, not enough to be exploited on stale prices.
        uint256 deadline = block.timestamp + 30;

        // Execute each swap leg
        for (uint i = 0; i < legs.length; i++) {
            Leg memory leg = legs[i];

            // USDT-safe approve: reset to 0 before setting new allowance
            IERC20(leg.tokenIn).approve(leg.router, 0);
            IERC20(leg.tokenIn).approve(leg.router, currentAmount);

            if (leg.dexType == 0) {
                // FIX S3: V2 swap now passes leg.amountOutMinimum (was 0)
                uint[] memory amounts = IV2Router(leg.router)
                    .swapExactTokensForTokens(
                        currentAmount,
                        leg.amountOutMinimum,   // <── sandwich protection
                        leg.v2Path,
                        address(this),
                        deadline                // <── S4: tight deadline
                    );
                currentAmount = amounts[amounts.length - 1];
            } else {
                // FIX S3: V3 swap now passes leg.amountOutMinimum (was 0)
                currentAmount = IV3Router(leg.router).exactInputSingle(
                    IV3Router.ExactInputSingleParams({
                        tokenIn           : leg.tokenIn,
                        tokenOut          : leg.tokenOut,
                        fee               : leg.v3Fee,
                        recipient         : address(this),
                        deadline          : deadline,   // <── S4: tight deadline
                        amountIn          : currentAmount,
                        amountOutMinimum  : leg.amountOutMinimum, // <── S3
                        sqrtPriceLimitX96 : 0
                    })
                );
            }

            // Cleanup leftover approval
            IERC20(leg.tokenIn).approve(leg.router, 0);
        }

        // Enforce profit floor
        require(currentAmount > amountToRepay, "Trade unprofitable");
        uint256 profit = currentAmount - amountToRepay;
        require(profit >= minProfit, "Below min profit");

        // Approve Aave repayment
        IERC20(asset).approve(address(AAVE_POOL), 0);
        IERC20(asset).approve(address(AAVE_POOL), amountToRepay);

        emit ArbitrageExecuted(asset, amount, profit);
        return true;
    }

    // ─────────────────────────────────────────────────────────────
    // WITHDRAW ERC20
    // FIX S7: require() on transfer return value — some tokens (e.g.
    // non-standard ERC20s) return false instead of reverting. Without
    // this check, withdraw() silently fails and funds stay in the contract.
    // ─────────────────────────────────────────────────────────────
    function withdraw(address token) external onlyOwner {
        uint256 b = IERC20(token).balanceOf(address(this));
        require(b > 0, "Nothing to withdraw");
        bool ok = IERC20(token).transfer(owner, b);
        require(ok, "Transfer failed");
    }

    function withdrawAll(address[] calldata tokens) external onlyOwner {
        for (uint i = 0; i < tokens.length; i++) {
            uint256 b = IERC20(tokens[i]).balanceOf(address(this));
            if (b == 0) continue;
            bool ok = IERC20(tokens[i]).transfer(owner, b);
            require(ok, "Transfer failed");
        }
    }

    // ─────────────────────────────────────────────────────────────
    // WITHDRAW ETH
    // ─────────────────────────────────────────────────────────────
    function withdrawETH() external onlyOwner {
        uint256 b = address(this).balance;
        require(b > 0, "No ETH to withdraw");
        (bool ok, ) = owner.call{value: b}("");
        require(ok, "ETH transfer failed");
    }

    receive() external payable {}
}
