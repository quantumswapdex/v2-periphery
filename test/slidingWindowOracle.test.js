// Ported (reduced) from test/ExampleSlidingWindowOracle.spec.ts. The original
// suite drove block timestamps directly; on a live devnet we use a short
// window (24s, granularity 4, period 6s) and real elapsed time instead.
// Because the pair price is constant during the test, the windowed TWAP
// equals the spot price exactly, which keeps the consult assertion exact.
const { test, before } = require("node:test");
const {
  assert,
  getContext,
  deploy,
  send,
  expectRevert,
  staticCall,
  scalar,
  expandTo18Decimals,
  sleep,
} = require("./helpers");
const { artifacts, createPair } = require("./fixtures");

const overrides = { gasLimit: 6_000_000n };
const WINDOW_SIZE = 24n; // seconds
const GRANULARITY = 4n;
const PERIOD_SIZE = WINDOW_SIZE / GRANULARITY; // 6 seconds

const token0Amount = expandTo18Decimals(5);
const token1Amount = expandTo18Decimals(10);

let provider;
let wallet;
let factory;
let fixture;
let oracle;
before(async () => {
  ({ provider, wallet } = await getContext());
  factory = await deploy(artifacts.factory(), [wallet.address]);
  fixture = await createPair(factory);
  await send(fixture.token0.transfer(fixture.pair.target, token0Amount, overrides));
  await send(fixture.token1.transfer(fixture.pair.target, token1Amount, overrides));
  await send(fixture.pair.mint(wallet.address, overrides));
  oracle = await deploy(artifacts.slidingWindowOracle(), [factory.target, WINDOW_SIZE, GRANULARITY]);
});

test("constructor validation", async () => {
  // granularity must be > 1
  await expectRevert(deploy(artifacts.slidingWindowOracle(), [factory.target, WINDOW_SIZE, 1n]));
  // window size must be evenly divisible by granularity
  await expectRevert(deploy(artifacts.slidingWindowOracle(), [factory.target, 25n, GRANULARITY]));
});

test("immutables", async () => {
  assert.equal(BigInt(scalar(await oracle.windowSize())), WINDOW_SIZE);
  assert.equal(BigInt(scalar(await oracle.granularity())), GRANULARITY);
  assert.equal(BigInt(scalar(await oracle.periodSize())), PERIOD_SIZE);
});

test("observationIndexOf", async () => {
  for (const timestamp of [0n, 6n, 12n, 18n, 24n, 36n, 1721399999n]) {
    const expected = (timestamp / PERIOD_SIZE) % GRANULARITY;
    assert.equal(BigInt(scalar(await oracle.observationIndexOf(timestamp))), expected, `observationIndexOf(${timestamp})`);
  }
});

test("update records an observation for the current epoch period", async () => {
  const { token0, token1, pair } = fixture;
  const receipt = await send(oracle.update(token0.target, token1.target, overrides));
  // QuantumCoin executes a block's transactions with block.timestamp = parent header time + the
  // block period. That is earlier than the block's own header time whenever the block is late, so
  // the stored timestamp is bounded by the two headers rather than equal to the containing one,
  // and its slot can differ from observationIndexOf(header time).
  const block = await provider.getBlock(receipt.blockNumber);
  const parent = await provider.getBlock(Number(receipt.blockNumber) - 1);
  let index;
  let observation;
  for (let i = 0n; i < GRANULARITY; i++) {
    const candidate = await oracle.pairObservations(pair.target, i);
    const ts = BigInt(candidate[0]);
    if (ts > BigInt(parent.timestamp) && ts <= BigInt(block.timestamp)) {
      index = i;
      observation = candidate;
    }
  }
  assert.ok(observation, "observation timestamp within the update's block");
  assert.equal(BigInt(scalar(await oracle.observationIndexOf(BigInt(observation[0])))), index, "observation slot");

  // a second update within the same period must not overwrite the observation
  await send(oracle.update(token0.target, token1.target, overrides));
  const after = await oracle.pairObservations(pair.target, index);
  assert.equal(BigInt(after[0]), BigInt(observation[0]), "observation unchanged within period");
});

test("consult reverts before enough observations, then matches spot price exactly", async () => {
  const { token0, token1 } = fixture;

  // only one epoch observed so far: the first observation in the window is
  // either missing or too recent, so consult must revert
  await expectRevert(staticCall(oracle, "consult", [token0.target, expandTo18Decimals(1), token1.target]));

  // keep recording observations (update is a no-op within an already-observed
  // period) until the window has enough history for consult to succeed
  const deadline = Date.now() + 150_000;
  let amountOut;
  for (;;) {
    await send(oracle.update(token0.target, token1.target, overrides));
    try {
      amountOut = scalar(await oracle.consult(token0.target, expandTo18Decimals(1), token1.target));
      break;
    } catch {
      if (Date.now() > deadline) {
        assert.fail("consult did not become available within 150s of updates");
      }
      await sleep(2000);
    }
  }

  // constant 1:2 price -> TWAP equals spot price exactly
  assert.equal(BigInt(amountOut), expandTo18Decimals(2));
  const amountOutReverse = scalar(await oracle.consult(token1.target, expandTo18Decimals(2), token0.target));
  assert.equal(BigInt(amountOutReverse), expandTo18Decimals(1));
});
