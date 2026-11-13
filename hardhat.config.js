require("@nomicfoundation/hardhat-toolbox");
const { subtask, extendEnvironment } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");

// Use the pinned npm compiler; compilation needs no compiler download.
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD).setAction(async ({ solcVersion }) => {
  const longVersion = require("solc").version();
  if (solcVersion !== "0.8.20" || !longVersion.startsWith("0.8.20+")) {
    throw new Error("Only the pinned Solidity 0.8.20 compiler is allowed.");
  }
  return {
    compilerPath: require.resolve("solc/soljson.js"),
    isSolcJs: true,
    version: solcVersion,
    longVersion
  };
});

extendEnvironment((hre) => {
  if (hre.network.name !== "hardhat") {
    throw new Error("Local in-process Hardhat Network only.");
  }
});

module.exports = {
  defaultNetwork: "hardhat",
  solidity: {
    version: "0.8.20",
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "paris" }
  },
  networks: { hardhat: { chainId: 31337, hardfork: "shanghai" } },
  gasReporter: { enabled: false },
  mocha: { timeout: 40000 }
};
