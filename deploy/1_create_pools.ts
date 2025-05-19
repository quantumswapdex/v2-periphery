import UniswapV3Pool from "@uniswap/v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json";
import { TickMath, nearestUsableTick } from "@uniswap/v3-sdk";
import { parseUnits } from "ethers/lib/utils";
import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { getNamedAccounts } = hre;

  const { deployer } = await getNamedAccounts();

  const wmon = await ethers.getContractAt("WMON", "0x4a1b8c5d7f2e3c9f6a5b8e2c3f4d5e6f7a8b9c0d");
  const wbtc = await ethers.getContractAt("WBTC", "0x4a1b8c5d7f2e3c9f6a5b8e2c3f4d5e6f7a8b9c0d");
  const usdc = await ethers.getContractAt("USDC", "0x4a1b8c5d7f2e3c9f6a5b8e2c3f4d5e6f7a8b9c0d");
  const factory = await ethers.getContractAt("UniswapV2Factory", "0x4a1b8c5d7f2e3c9f6a5b8e2c3f4d5e6f7a8b9c0d");
  
  await deploy("UniswapV2Router02", {
    contract: "UniswapV2Router02",
    from: deployer,
    args: [factory.address, wmon.address],
  });

  const router = await ethers.getContract("UniswapV2Router02");

  // 1 WBTC = 85000 USDC
  let amount0 = parseUnits("1", 8);
  let amount1 = parseUnits("85000", 6);

  await factory.createPair(wbtc.address, usdc.address);

  await wbtc.mint(deployer, parseUnits("1", 8));
  await usdc.mint(deployer, parseUnits("85000", 6));
  await wbtc.approve(router.address, parseUnits("1", 8));
  await usdc.approve(router.address, parseUnits("85000", 6));
  await router.addLiquidity(wbtc.address, usdc.address, amount0, amount1, 0, 0, deployer, Math.floor(Date.now() / 1000) + 10000);

  // 1 MON = 1 USDC
  amount0 = parseUnits("1", 18);
  amount1 = parseUnits("1", 6);

  await factory.createPair(wmon.address, usdc.address);
  await wmon.mint(deployer, parseUnits("1", 18));
  await usdc.mint(deployer, parseUnits("1", 6));
  await wmon.approve(router.address, parseUnits("1", 18));
  await usdc.approve(router.address, parseUnits("1", 6));
  await router.addLiquidity(wmon.address, usdc.address, amount0, amount1, 0, 0, deployer, Math.floor(Date.now() / 1000) + 10000);
};

export default func;
func.tags = ["pools"];
