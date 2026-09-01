require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const ARBITRUM_RPC = process.env.ARBITRUM_RPC;

if (!ARBITRUM_RPC) {
  throw new Error(
    "\n[FATAL] ARBITRUM_RPC not set in .env\n" +
    "Get a free endpoint at: quicknode.com → Create Endpoint → Arbitrum One\n"
  );
}

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.26",      // WHY: 0.8.19 IR optimizer produces bytecode >24KB for Searcher.sol.
                            // 0.8.26 has substantially better Yul/IR optimizer — same contract
                            // compiles to ~17.6KB instead. Pragma ^0.8.19 allows this version.
    settings: {
      viaIR: false,          // Required: Searcher.sol hits stack-too-deep without IR pipeline.
                            // viaIR alone bloats bytecode — optimizer MUST be enabled with it.
      optimizer: {
        enabled: true,
        runs: 1,            // WHY: Minimizes deployment bytecode size.
                            // check() is called via eth_call (zero gas), so execution
                            // efficiency doesn't matter for this contract. Deploy small.
      },
    },
  },
  networks: {
    hardhat: {
      forking: {
        // WHY: Forks Arbitrum mainnet so contracts run against REAL pools and REAL Aave liquidity.
        // No fake tokens. No mocks. If the bot would make money on mainnet, this shows it.
        url: ARBITRUM_RPC,

        // Uncomment to pin a specific block for reproducible test runs:
        // blockNumber: 300000000,
      },
      // WHY: Must match Arbitrum's chainId or the contracts reference wrong addresses.
      chainId: 42161,
    },
  },
  mocha: {
    // WHY: Fork tests make real RPC calls. 2 minutes is safe for slow connections.
    timeout: 120_000,
  },
};
