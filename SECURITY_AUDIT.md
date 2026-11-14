# Security Audit: Findings Index

This document records an internal security review of **v2-periphery**, the QuantumSwap V2
periphery contracts (`QuantumSwapV2Router02` and its libraries). It covers the code this fork
changed from Uniswap V2 periphery for QuantumCoin (Solidity 0.7.6, 32-byte addresses, no
`ecrecover`/permit, `INIT_CODE_HASH` read from the factory at runtime). It also covers the
libraries and the WQ contract the router depends on, the toolchain that builds and tests it, and
how the deployed router is used by the QuantumSwap web app and the `quantumcoin` SDK.

It is the companion to the v2-core review (`SECURITY_AUDIT.md` in the v2-core repository) and
uses the same dual-axis method, taken from the
[circl security audit](https://github.com/quantumcoinproject/circl/blob/main/SECURITY_AUDIT.md).
Each finding has a **severity** (how bad the defect is in the code itself) and a separate
**reachability** (whether anyone can trigger it in practice).

## Contents

- [Summary](#summary)
- [Scope and method](#scope-and-method)
- [Methodology](#methodology)
- [**Findings**](#findings)
  - [QSV2P-01: Devnet bootstrap fails open on hash verification, and checks the wrong files](#qsv2p-01)
  - [QSV2P-02: Six router entry points have no test, and CI never runs](#qsv2p-02)
  - [QSV2P-03: Router interfaces declare `factory()` and `WETH()` as state-changing](#qsv2p-03)
- [Fork-delta verification (no defect found)](#fork-delta-verification-no-defect-found)
- [Deployed contract verification (QuantumCoin mainnet)](#deployed-contract-verification-quantumcoin-mainnet)
- [Router execution on mainnet state (no defect found)](#router-execution-on-mainnet-state-no-defect-found)
- [Repository test suite on a local devnet](#repository-test-suite-on-a-local-devnet)
- [QuantumCoin block clock](#quantumcoin-block-clock)
- [Inherited upstream behaviour](#inherited-upstream-behaviour)
- [External caller-side invariants](#external-caller-side-invariants)
- [Revisions assessed](#revisions-assessed)
- [Reproduction](#reproduction)
- [Status](#status)
- [Standards referenced](#standards-referenced)

## Summary

**No defect was found in contract logic.** Apart from the deliberate fork changes, the router and
libraries match upstream Uniswap V2 periphery line for line, and each fork change was checked by
executing it. This review adds three results the v2-core review could not provide:

- **The deployed mainnet router is byte-identical to this source** built with the production
  settings. WQ is byte-identical to `@quantumcoin/wq@1.0.0`.
- **All 14 state-changing router entry points were executed through the deployed router against
  live mainnet state.** This used read-only `eth_call` with state overrides; nothing was signed or
  broadcast. The run also covered 11 negative paths, router-driven creation of a new pair, and
  32-byte recipients. Every path behaved as specified and left the router holding nothing.
- **`@quantumcoin/solidity-lib` is identical to upstream `@uniswap/lib@4.0.1-alpha`** in every
  file the router and libraries import, including `TransferHelper`.

This repository's own test suite was also run on a local devnet: **28 of 29 tests pass** at
`779aedc`, and **29 of 29** with the test fixed (the fix is applied in the working tree but not
committed). The one failure is a test defect. The test assumes that `block.timestamp` equals the timestamp in the block
header, which QuantumCoin does not guarantee. A transaction executes with the **parent** header's
time plus the block period, so the EVM clock lags the block's own header whenever a block is late
(up to 342 s in a recent mainnet sample). See [QuantumCoin block clock](#quantumcoin-block-clock).
The router uses that clock consistently and is unaffected, but deadlines and off-chain oracle code
must allow for it ([INV-P3](#external-caller-side-invariants), INV-P8).

**Three findings are open.** None is in a code path that moves funds:

| ID | Title | Severity | Reachability | CWE |
|:---|:---|:---|:---|:---|
| [QSV2P-01](#qsv2p-01) | Devnet bootstrap fails open on hash verification and executes the unverified archive; the check also compares against the wrong files, so no platform can complete a verified install (same code as v2-core QSV2-01) | Medium | Exploitable (conditional) | [CWE-636], [CWE-494] |
| [QSV2P-02](#qsv2p-02) | Six of the 14 router entry points have no test, CI never runs, and one test cannot pass on a QuantumCoin node | Low | Not Reachable (assurance) | none applies |
| [QSV2P-03](#qsv2p-03) | Router interfaces declare `factory()` and `WETH()` as state-changing | Low | Not Reachable | none applies |

None of them permits loss, theft or freezing of trader or liquidity-provider funds.

## Scope and method

**Reviewed.**
- `contracts/`: `QuantumSwapV2Router02`, `QuantumSwapV2Library`, `QuantumSwapV2OracleLibrary`,
  `QuantumSwapV2LiquidityMathLibrary`, `SafeMath` and the interfaces. `contracts/examples/` and
  `contracts/test/` were reviewed for fork deltas only: [SECURITY.md](SECURITY.md) puts them out of
  scope, and neither is published to npm.
- The dependencies compiled into the router:
  - `@quantumcoin/solidity-lib@1.0.0`: `TransferHelper`, plus `FixedPoint`, `FullMath` and
    `Babylonian` for the libraries;
  - the `@quantumswap/v2-core@1.0.1` interfaces;
  - `@quantumcoin/wq@1.0.0`, the WQ contract the router wraps native Q with.
- `scripts/`, `test/` and `.github/workflows/`.
- Every difference from upstream Uniswap V2 periphery at `2efa12e`, diffed with the Uniswap names
  normalized so that only semantic changes remain.

**Fork deltas.** The changes from upstream are:
1. `pragma =0.7.6` (from `=0.6.6`).
2. Six `assert`s became `require`s with short codes: `QSR:b1` (the `receive()` sender check),
   `QSR:b2` (`_addLiquidity`) and `QSR:b3`–`QSR:b6` (WQ `transfer` results).
3. Permit removed: `removeLiquidityWithPermit`, `removeLiquidityETHWithPermit`,
   `removeLiquidityETHWithPermitSupportingFeeOnTransferTokens` and their interface entries.
4. `QuantumSwapV2Library.pairFor` reads `INIT_CODE_HASH()` from the factory instead of using
   Uniswap's hard-coded hash, and is therefore `view` instead of `pure`.
5. `IQuantumSwapV2Router01.factory()` and `WETH()` lost their `pure` qualifier
   ([QSV2P-03](#qsv2p-03)).
6. `UniswapV2Router01`, `UniswapV2Migrator`, the V1 interfaces and `ExampleFlashSwap` were deleted.
   `ExampleOracleSimple.PERIOD` became a constructor argument.

`_addLiquidity`, `_swap`, `_swapSupportingFeeOnTransferTokens`, every public function body and all
amount math are otherwise unchanged.

**Consumers.** Reachability was assessed against:
- the QuantumSwap web app at `app.quantumswap.com`, through its shipped bundle (the same
  `index-B2v-1s0P.js` the v2-core review analysed);
- `quantumcoin` (quantumcoin.js) 8.0.2;
- `v2-core/scripts/build-production.js`, which builds the production router and its Go bindings
  from this repository;
- QuantumCoin mainnet (chain id 123123), through the public RPC.

**Verification standard.** Every finding and every "no defect" result below was confirmed by
executing code:
- production-settings bytecode compared with `eth_getCode`;
- the deployed router driven by a harness contract placed with an `eth_call` state override at a
  32-byte address, against live pair state at a pinned block;
- this repository's own scripts run with every path redirected to a scratch directory;
- this repository's test suite (`npm test`) run unmodified against a local devnet;
- the SDK probed read-only.

Anything that could not be reproduced is not listed.

**Not performed.**
- The mainnet node accepts `eth_call` state overrides but not block overrides, so `block.timestamp` could
  not be moved. The uint32 rollover was exercised by overriding pair storage instead (D9).
- The web app was analysed only for the arguments it passes to the router.

## Methodology

### Severity: the defect in the code itself

Judged independently of whether anything can reach it. The levels follow the recognition table in
[SECURITY.md](SECURITY.md), with circl's criterion for defects that silently void a control.

| Level | Criterion |
|---|---|
| **Critical** | Direct loss or permanent freezing of user funds or approvals, at a practical cost. |
| **High** | Temporary freezing of funds, or theft that needs unlikely user action. |
| **Medium** | Incorrect behaviour that harms users without direct loss of funds, **or** silently voids a security control the system depends on. |
| **Low** | No path to fund loss under any examined configuration: robustness, availability, assurance, defence in depth. |
| **Informational** | Documentation, conformance or structural observations with no security effect. |

### Reachability: exploitability through the consumers

| Level | Criterion | VEX status |
|---|---|---|
| **Exploitable** | An exploit path exists through a supported consumer or workflow. Conditions, if any, are stated. | `affected` |
| **Requires Caller-Side Invariant Violation** | Triggerable only if a consumer breaks an invariant in the [index](#external-caller-side-invariants). | `not_affected`, `inline_mitigations_already_exist`, while the invariant holds |
| **Not Reachable** | No supported path triggers it. The preventing property is named. | `not_affected` with a justification code |

The two-axis structure is standard practice in risk assessment ([SP 800-30r1], [OWASP Risk Rating
Methodology][owasp-rr], [CVSS v4.0][cvss4]). The reachability axis corresponds to VEX
([CSAF 2.0][csaf], [OpenVEX][openvex]). The severity levels are a house scale; they carry no
external authority.

### Governing rules

1. **Severity is never adjusted for reachability.** The two axes are independent; the pair of
   them is the triage state.
2. **Formal statements outrank labels.** Where a label and the stated mechanism seem to conflict,
   the mechanism governs.
3. **CWE is classification, not severity.** Where no CWE fits, the finding is left unclassified.

## Findings

<a id="qsv2p-01"></a>
### QSV2P-01: Devnet bootstrap fails open on hash verification and executes the unverified archive, and checks the wrong files

- **CWE Classification:** [CWE-636] Not Failing Securely ('Failing Open'); consequence [CWE-494] Download of Code Without Integrity Check
- **Location:**
  - `scripts/devnet.js:95-111` `verifyHash(archiveBuffer)`
  - `:132-139` cache reuse in `ensureInstalled()`
  - `:160-188` `launchNode()`
  - run by `npm test` (`package.json:34`) before any test
- **Axis 1: Technical Severity:** Medium. It silently voids the only integrity control in front of code execution.
- **Axis 2: Consumer Reachability:** Exploitable, conditionally (VEX `affected`). Two conditions must both hold:
  - (a) the attacker can create the cache file `os.tmpdir()/<release>-<asset>` before the first run. On Linux this is the world-writable `/tmp`. On macOS `$TMPDIR` is per-user, so another local user cannot.
  - (b) fetching the hash fails: the host is offline, rate-limited or gets a 5xx error, or `QC_DEVNET_RELEASE` names a release with no `releasehash-*` file.

  There is no on-chain impact.

**Technical Summary.** `scripts/devnet.js` is byte-identical to `v2-core/scripts/devnet.js`, so
this is v2-core's QSV2-01. It is listed again because this repository runs its own copy, and a fix
to one copy does not fix the other. `verifyHash` catches every error and re-throws only those whose
text contains `"mismatch"`. Any failure to fetch or parse the hash file logs
`hash verification skipped`, and execution continues. `ensureInstalled` then extracts the archive,
and `launchNode` runs `connectvalidator.sh` from it. A cached archive in `os.tmpdir()` is trusted
for reuse on its filename alone. Even when the check succeeds, the hash comes from the same GitHub
release as the archive, so it detects corruption but not a tampered release.

**The check also compares against the wrong files.** Each release hash file describes the
`qc-release-<platform>-devnet-<release>` archive. The script downloads differently named assets,
which were uploaded separately (01:10–01:12 UTC, against 01:01–01:02 UTC for the `qc-release-…`
archives), have different contents, and are covered by no hash file. Hashes below are for
`test-v2.0.74`; GitHub's own asset digests agree with the hash files.

| Platform | Script downloads | Hash file describes | Result with the hash file reachable (executed) |
|:---|:---|:---|:---|
| Linux | `ubuntu-devnet.tar.gz` (`c7f2e650…`) | `qc-release-ubuntu-devnet-test-v2.0.74.tar.gz` (`2cf60b00…`) | `sha256 mismatch` on the genuine asset |
| Windows | `windows-devnet.zip` (`4a40fe6e…`) | `qc-release-windows-devnet-test-v2.0.74.zip` (`46335272…`) | `sha256 mismatch` on the genuine asset |
| macOS | `mac-devnet.tar.gz` | `qc-release-mac-devnet-test-v2.0.74.tar.gz` (`963edf1c…`) | HTTP 404: no such asset |

So no platform can complete a verified install of the pinned release. On Linux and Windows, the
script installs only when the hash fetch fails, which is the fail-open path. The download is
also written to `os.tmpdir()` before it is checked and is not removed after a mismatch, so every
later run reuses it and fails the same way. The devnet used for this review's test run was
installed by hand instead (see [Repository test suite](#repository-test-suite-on-a-local-devnet)
and [Revisions assessed](#revisions-assessed)).

**Attack Vector & Execution Steps.**
1. The attacker plants `/tmp/test-v2.0.74-ubuntu-devnet.tar.gz`, containing `dp` and a malicious
   `connectvalidator.sh`.
2. A developer or CI job runs `npm test` in this repository. `ensureInstalled` finds no `dp` in
   `QC_DEVNET_DIR` and reuses the planted file.
3. The hash fetch fails, so the script prints a warning and continues.
4. `launchNode` spawns `bash connectvalidator.sh` in the background, and the attacker's code runs as
   the developer. That account holds the devnet keystore. The same checkout is the
   `v2-periphery` input that `v2-core/scripts/build-production.js` compiles into the production
   router artifacts.

**Proof of Concept (PoC) Blueprint.** This was executed against this repository's unmodified
script, with all paths in a scratch directory. The commands are the same as v2-core's QSV2-01 PoC,
with `scripts/devnet.js` resolved in this repository.

Observed:

```
devnet: reusing cached download …/tmp/test-v2.0.74-mac-devnet.tar.gz
devnet: hash verification skipped (fetch failed)
devnet: extracting to …/devnet
devnet: installed
devnet: launched connectvalidator (pid 56071), log: …/devnet/devnet-node.log
PLANTED connectvalidator.sh executed: uid=501 args=18599
```

Control, with the hash reachable (no proxy):
`Error: sha256 mismatch: expected 963edf1c32bb98253eb957a92106d733917f5101b60164491cdcc93ac5015906, got 9ac70215…`.
The payload was not executed.

Wrong-file check. The genuine release assets were run through the unmodified script on the Linux
and Windows code paths. A preload set `process.platform`, every path was in scratch, and the RPC
check pointed at a live node so nothing could be launched:

```
linux:  Error: sha256 mismatch: expected 2cf60b00e8728adca311a57169b3b93279fd246211e690405df539d1e1f46e8e, got c7f2e650a477dcdd9ad1d26901c0763ef57d9bb7c0b611d6e6835edf91bce8f1
win32:  Error: sha256 mismatch: expected 463352720C851E6D5DD58051B65F0D739E9C988527F1E0316987BE4678AF1215, got 4a40fe6ed5b0e1b0f4da9a1cdccf1a0bfe165bcb64ba8b937bf1743e17e3b611
```

**Remediation.** Apply v2-core's QSV2-01 remediation, and download the archive the hashes
describe:

```js
// scripts/devnet.js: fetch the qc-release-… archive, pin its hash in-repo, fail closed on any error
const PLATFORMS = {
  win32:  { tag: "windows", ext: "zip",    binary: "dp.exe" },
  darwin: { tag: "mac",     ext: "tar.gz", binary: "dp" },
  linux:  { tag: "ubuntu",  ext: "tar.gz", binary: "dp" },
};
const ASSET = `qc-release-${PLATFORM.tag}-devnet-${RELEASE}.${PLATFORM.ext}`;
const PINNED_SHA256 = {
  "test-v2.0.74": {
    mac:     "963edf1c32bb98253eb957a92106d733917f5101b60164491cdcc93ac5015906",
    ubuntu:  "2cf60b00e8728adca311a57169b3b93279fd246211e690405df539d1e1f46e8e",
    windows: "463352720c851e6d5dd58051b65f0d739e9c988527f1e0316987be4678af1215",
  },
};
// Verify the buffer before writing it anywhere; cache only inside DEVNET_DIR (mode 0o700);
// delete any cached file that fails verification.
```

Apply the change to both copies at once, or move the script into a shared package so the copies
cannot drift.

---

<a id="qsv2p-02"></a>
### QSV2P-02: Six of the 14 router entry points have no test, CI never runs, and one test cannot pass on a QuantumCoin node

- **CWE Classification:** none applies (governing rule 3).
- **Location:**
  - `test/router02.test.js`, the only router test file
  - `test/slidingWindowOracle.test.js:66-69`, which compares an on-chain timestamp with a header timestamp
  - upstream `test/UniswapV2Router01.spec.ts` (734 lines), deleted and not ported; it ran every
    case against both routers
  - `.github/workflows/CI.yml:3-7,13,37`
  - `test/helpers.js:142-165` `expectRevert`, identical to v2-core's
  - `contracts/test/QuantumAddressTest.sol`, which is compiled but used by no test
- **Axis 1: Technical Severity:** Low.
- **Axis 2: Consumer Reachability:** Not Reachable (VEX `not_affected` /
  `vulnerable_code_not_in_execute_path`). Test and CI code are never deployed. This is an
  assurance item. The router is immutable, and [SECURITY.md](SECURITY.md) says confirmed critical
  issues are handled by deploying a fixed router, so this suite is the gate for that redeployment.

**Technical Summary.** Four verified gaps compound one another. The suite itself was run on a
local devnet: 28 of 29 tests pass, and the 28 passing tests leave the coverage gaps below
unchanged ([details](#repository-test-suite-on-a-local-devnet)).

1. **Six entry points are never executed by any test.** Three of them are called by the
   production web app for every exact-output swap.

   | Entry point | Tested | Called by the web app |
   |:---|:---|:---|
   | `addLiquidity`, `addLiquidityETH` | directly (as fixture setup) | yes |
   | `removeLiquidity` | indirectly, via `removeLiquidityETHSupportingFeeOnTransferTokens` | yes |
   | `swapExactTokensForTokens` | indirectly, via `ExampleSwapToPrice` | no |
   | `removeLiquidityETHSupportingFeeOnTransferTokens` and the three `swap…SupportingFeeOnTransferTokens` | directly | yes |
   | `swapTokensForExactTokens`, `swapETHForExactTokens`, `swapTokensForExactETH` | **never** | **yes** |
   | `removeLiquidityETH`, `swapExactETHForTokens`, `swapExactTokensForETH` | **never** | no |

   Nothing tests the fork-specific behaviour either: `EXPIRED`, `INVALID_PATH` on the native-coin
   functions, the `QSR:b1` receive guard, 32-byte recipients, or router-driven pair creation
   through the runtime `INIT_CODE_HASH`. `QuantumAddressTest.sol` was written for the address
   checks but is never deployed by any test.
2. **CI never reaches the tests.** The workflow triggers on pushes to `master`, but this
   repository's only branch is `add-stale`, so pushes never run it. A pull request would run it, but
   it runs on Node 10/12, while the suite needs Node 18 or later. It also runs `yarn lint`, which
   fails because no such script exists (`npm error Missing script: "lint"`), and there is no
   `yarn.lock`. The workflow has not changed since 2020-04-15 (`7fa2cca`).
3. **`expectRevert` is too permissive.** `test/helpers.js` is identical to v2-core's, so v2-core
   QSV2-02 item 3 applies unchanged. Any rejection whose message lacks "revert" passes, including a
   client-side `invalid address`, and reasons are matched as bare substrings.
4. **One test can never pass on a QuantumCoin node.** `update records an observation for the
   current epoch period` expects the oracle's stored `block.timestamp` to equal the header timestamp
   of the receipt's block. On QuantumCoin, a transaction executes with the parent header's time
   plus the block period ([QuantumCoin block clock](#quantumcoin-block-clock)), so the two differ
   whenever a block is late. On the test-v2.0.85 devnet, every block is late: the period is 1 s
   and blocks arrive every 3–4 s. The test failed in both runs:

   | Run | Block | Parent header | Stored by the oracle | Header (expected by the test) |
   |:---|:---|:---|:---|:---|
   | 2 | 468 | 1794637806 | 1794637807 (= parent + 1) | 1794637809 |
   | 1 | — | — | 1794636330 | 1794636333 |

   The contract is correct. A suite with a permanent red test cannot act as a release gate, because
   a real regression looks the same as the known failure.

**Attack Vector & Execution Steps.** This is a regression path, not an attacker path.
1. A source change, or a compiler release within `^0.7.6`, alters an exact-output or native-coin
   path.
2. CI does not run. Locally, no test executes the changed function.
3. `v2-core/scripts/build-production.js` builds the router, and it is deployed immutably. The web
   app then routes every exact-output swap through the untested function.

**Proof of Concept (PoC) Blueprint.** The harness described in
[Router execution on mainnet state](#router-execution-on-mainnet-state-no-defect-found) executes
all 14 entry points with no devnet and no keys. It is the coverage this suite lacks.

**Remediation.**
1. Port the upstream `UniswapV2Router01.spec.ts` cases for the six functions. Add cases for
   `EXPIRED`, `INVALID_PATH`, `QSR:b1`, a recipient whose high 12 bytes are non-zero, and a pair
   created by the router. Use `QuantumAddressTest.sol` or delete it.
2. Add a read-only mainnet job to CI. It should compare `eth_getCode(router)` with the production
   build, with immutables spliced, and run the state-override harness at `latest`. It needs no keys
   and sends nothing.
3. Fix `CI.yml` and `expectRevert` as in v2-core QSV2-02. Trigger on `add-stale` as well as on
   pull requests.
4. Make the observation test clock-independent. Find the slot whose stored timestamp lies after
   the parent header and no later than the containing header, then check that the timestamp maps
   to that slot. Do not derive the slot from the header time, because the parent + period time and
   the header time can fall in different 6 s periods:

   ```js
   const block = await provider.getBlock(receipt.blockNumber);
   const parent = await provider.getBlock(Number(receipt.blockNumber) - 1);
   let index;
   let observation;
   for (let i = 0n; i < GRANULARITY; i++) {
     const candidate = await oracle.pairObservations(pair.target, i);
     const ts = BigInt(candidate[0]);
     if (ts > BigInt(parent.timestamp) && ts <= BigInt(block.timestamp)) { index = i; observation = candidate; }
   }
   assert.ok(observation, "observation timestamp within the update's block");
   assert.equal(BigInt(scalar(await oracle.observationIndexOf(BigInt(observation[0])))), index, "observation slot");
   ```

   **Applied** to `test/slidingWindowOracle.test.js` in the working tree (not committed). The test
   still fails if `update` writes nothing, writes a time outside the update's block, or writes to
   the wrong slot. Verified: the file passed 5/5 in two runs, and the full suite passed 29/29
   ([results](#repository-test-suite-on-a-local-devnet)).

---

<a id="qsv2p-03"></a>
### QSV2P-03: Router interfaces declare `factory()` and `WETH()` as state-changing

- **CWE Classification:** none applies (governing rule 3).
- **Location:**
  - `contracts/interfaces/IQuantumSwapV2Router01.sol:6-7`, inherited by `IQuantumSwapV2Router02`
  - published in `@quantumswap/v2-periphery@1.0.1`, whose `files` ship `contracts/interfaces/`
- **Axis 1: Technical Severity:** Low. Integrations built on the shipped interface misbehave, but
  they fail closed.
- **Axis 2: Consumer Reachability:** Not Reachable (VEX `not_affected` /
  `vulnerable_code_cannot_be_controlled_by_adversary`). No adversary gains anything; every failure
  is a compile error or a refused call. The deployed router's own ABI marks both getters `view`.
  The production Go bindings (abigen over the contract ABI in `build-production.js`) and the web
  app (`QuantumSwapV2Router02.abi`) both use that ABI.

**Technical Summary.** Upstream declares both getters `pure`. Under 0.7.6 that is a compile error
against `address public immutable override factory`:
`TypeError: Overriding public state variable changes state mutability from "pure" to "view"`. The
fork removed the qualifier instead of changing it to `view`, which is what v2-core did for its own
interfaces. The interface ABI therefore marks both getters `nonpayable`.

| Consumer | Result |
|:---|:---|
| A Solidity integrator: a `view` function returning `IQuantumSwapV2Router02(router).WETH()` | compile error: `Function declared as view, but this expression (potentially) modifies the state` |
| quantumcoin 8.0.2 `Contract` built from the interface ABI, provider only | `WETH()` throws `missing signer (operation="send")`: the getter is routed to the transaction path |
| The same `Contract`, built from the contract ABI | returns `0x45BD01BE…9Ac44D92` |

**Remediation.** Declare both getters `external view returns (address)`. Verified: with that
change, the router compiles to runtime bytecode byte-identical to the deployed build, so no
redeployment is needed. Publish the change as `@quantumswap/v2-periphery@1.0.2`.

## Fork-delta verification (no defect found)

All checks below used the production settings (`@quantumcoin/solc` 0.7.6, optimizer runs 999999,
`bytecodeHash: none`). D1–D9 executed on QuantumCoin mainnet state at block 5039592.

| ID | Property | Result | Why it matters |
|:---|:---|:---|:---|
| D1 | `pairFor` (source library) == `factory.getPair` for all mainnet pairs, both token orders | **16/16** | The runtime `INIT_CODE_HASH` lookup resolves every live pair. |
| D2 | A new pair created through `router.addLiquidity`: node `CREATE2` vs `pairFor` | both `0x2cba12bc…9644f983a`; first-mint LP = √(1000e18 × 4000e18) − 1000 | Router-driven creation on the node agrees with the router's own address derivation. |
| D3 | Deployed `router.getAmountsOut` == x·997·R_out / (R_in·1000 + x·997) on every funded pair, both directions | **28/28** | The quote and `pairFor` paths are correct on the deployed bytecode. |
| D4 | A token equal to QD in its low 20 bytes but with its high 12 bytes zeroed | reverts: no code at the computed pair | No 160-bit aliasing of pairs. |
| D5 | A recipient sharing the harness's low 20 bytes, high 12 bytes zero | it received exactly the quoted output; the harness received 0 | The router delivers to the exact 32-byte word and never truncates (INV-P1). |
| D6 | `QSR:b1`: native coin sent to the router by anyone other than WQ | reverts `QSR:b1` | Replaces upstream's gas-consuming `assert`. |
| D7 | `QSR:b2`–`QSR:b6` | unreachable | `b2`: if `amountBOptimal > amountBDesired`, then `amountAOptimal < amountADesired`. `b3`–`b6`: WQ `transfer` returns `true` or reverts (WQ bytecode verified). Switching `assert` to `require` changes only gas on failure. |
| D8 | Permit surface | 0 `…WithPermit` functions in the router ABI | Upstream's three permit paths are gone. Pairs have no `permit` either (v2-core P1–P5). |
| D9 | `QuantumSwapV2OracleLibrary.currentCumulativePrices` with pair storage overridden: `blockTimestampLast` = 2³² − 10, `price0CumulativeLast` = 2²⁵⁶ − 5 | elapsed 1,794,379,390 s (wrapped); both accumulators equal the expected value mod 2²⁵⁶; `price0` wrapped to `413844507794339522380270661425438317698106885` | The published oracle library survives the 2106 uint32 rollover and accumulator overflow. |
| D10 | `@quantumcoin/solc` 0.7.7 (what `^0.7.6` resolves to today) vs 0.7.6 | router, WQ, factory and pair: creation and runtime bytecode identical | No compiler drift today. |
| D11 | `@quantumcoin/solidity-lib@1.0.0` vs `@uniswap/lib@4.0.1-alpha` | `TransferHelper`, `FixedPoint`, `FullMath`, `Babylonian`, `BitMath` identical. `AddressStringUtil` and `SafeERC20Namer` widened to 64 hex characters. | The widened files are imported by no periphery contract. |
| D12 | npm `@quantumswap/v2-core@1.0.1` vs `v2-core@29ab87e` | identical apart from CRLF line endings | The v2-core review's conclusions apply to what this repository compiles against. |
| D13 | npm `@quantumswap/v2-periphery@1.0.1` vs this repository | `contracts/` identical | Integrators receive the reviewed source. The published `gitHead` is `91f56e9`; `779aedc` only adds SECURITY.md. |

The comment above `pairFor`, "calculates the CREATE2 address for a pair without making any
external calls" (`QuantumSwapV2Library.sol:23`), is now stale: every call reads the hash from the
factory. The trust consequence is recorded as [INV-P4](#external-caller-side-invariants).

## Deployed contract verification (QuantumCoin mainnet)

These were read-only checks against `https://public.rpc.quantumcoinapi.com` (chain id 123123) at
block 5039588 (2026-11-11T06:41:30Z), for the deployment listed in [SECURITY.md](SECURITY.md).

| Check | Result |
|:---|:---|
| Router `0xc3666584…5d861e` runtime vs. this source (0.7.6, production settings; `factory` and `WETH` spliced at their 49 immutable reference sites) | **identical** (18,385 bytes) |
| Router `factory()` / `WETH()` | factory `0x95085766…a99754` / WQ `0x45bd01be…c44d92` |
| WQ `0x45bd01be…c44d92` runtime vs. `@quantumcoin/wq@1.0.0` `wrappedq.sol` (production settings) | **identical** (2,175 bytes) |
| Factory runtime vs. npm `@quantumswap/v2-core@1.0.1` | **identical** |
| `INIT_CODE_HASH()` | `0xe9e4e94e…5f34b69` = keccak256(pair creation code) |
| Router holdings at block 5039592: native Q, the 20 tokens in the 16 pairs, the 16 LP tokens | **all 0** |

This closes the v2-core review's open item "Router runtime vs source: not compared". Its
"router allowance scope" conclusion now holds for the deployed router: all ten `transferFrom` call
sites (`QuantumSwapV2Router02.sol:75,76,96,115,189,203,233,250,302,348`) pull from `msg.sender`.

## Router execution on mainnet state (no defect found)

**Method.**
- A harness contract was compiled with the production settings. It was placed by state override at
  `0x5eeda1a1…a1a1`, an address whose high 12 bytes are non-zero, with an overridden native balance.
- Balances of cat, tig, Lio and pant (`balanceOf` at slot 0) and of QD (slot 5) were set by storage
  override. Each slot was found by probing.
- Each scenario was one `eth_call` at block 5039592 against the **deployed** router and live pairs.
- The harness asserts every amount, reverts on any mismatch, and finally asserts that the router
  holds 0 native Q and 0 of every token touched.

| Entry point | Path | Observed |
|:---|:---|:---|
| `swapExactETHForTokens` | WQ → QD, 1 Q | received 99,690,060,900 QD = quoted |
| `swapETHForExactTokens` | WQ → QD, 1 Q sent | spent exactly `amounts[0]` (0.500074928730540740 Q); the rest refunded; received exactly the requested 49,845,030,450 QD |
| `swapExactTokensForETH` | QD → WQ | received 0.745600164764194951 Q = quoted |
| `swapTokensForExactETH` | QD → WQ | received exactly 0.372800082382097475 Q; spent 37,387,962,067 QD = quoted `amounts[0]` |
| `swapExactTokensForTokens` | tig → cat → Lio, 1 tig | received 1.234721553594971237 Lio = quoted |
| `swapTokensForExactTokens` | Lio → cat → tig, 0.333… tig out | received exactly; spent 0.416527295628969966 Lio = quoted |
| `addLiquidity` / `removeLiquidity` | cat/tig, 100 + 100 desired | used 100 cat + 24.992026986683834476 tig; LP 49.992014373855371288; removal returned both amounts less 1 wei of rounding |
| `addLiquidityETH` / `removeLiquidityETH` | QD/WQ, 1,000,000 Q sent | used 10 Q and refunded the rest; removal returned 999,999,999,999 QD + 9.999999999999998954 Q |
| `swapExactETHForTokensSupportingFeeOnTransferTokens` | WQ → HSN → cat; WQ → HSN → cat → Y2Q | 5.588747476125240622 cat; 0.331669433172278953 Y2Q |
| `swapExactTokensForTokensSupportingFeeOnTransferTokens` | HSN → cat | 21.938947221355265434 cat |
| `swapExactTokensForETHSupportingFeeOnTransferTokens` | HSN → WQ | 24.800566994439758450 Q |
| `removeLiquidityETHSupportingFeeOnTransferTokens` | HSN/WQ | 6.218796684395749361 Q, equal to the returned `amountETH` |
| A new pair through the router | two new ERC-20s; then a new `DeflatingERC20` with `addLiquidityETH` and a fee-on-transfer sale | all succeeded (D2) |

Plain functions fail closed on a fee-on-transfer token (HSN burns 0.1% per transfer):

| Call | Result |
|:---|:---|
| `swapExactTokensForETH` HSN → WQ | reverts `QuantumSwapV2: K` |
| `removeLiquidityETH` HSN | reverts `TransferHelper::safeTransfer: transfer failed` |
| `swapExactETHForTokens` WQ → HSN → cat | reverts `QuantumSwapV2: K` |

Negative paths:

| Input | Result |
|:---|:---|
| `deadline` = `block.timestamp − 1` | `QuantumSwapV2Router: EXPIRED` |
| `deadline` = `block.timestamp` | accepted |
| `swapExactETHForTokens` with `path[0]` ≠ WQ | `QuantumSwapV2Router: INVALID_PATH` |
| path of length 1 | `QuantumSwapV2Library: INVALID_PATH` |
| identical tokens | `QuantumSwapV2Library: IDENTICAL_ADDRESSES` |
| zero-address token | `QuantumSwapV2Library: ZERO_ADDRESS` |
| `amountOutMin` = 2²⁵⁶ − 1 | `QuantumSwapV2Router: INSUFFICIENT_OUTPUT_AMOUNT` |
| native coin sent directly to the router | `QSR:b1` |
| no pair exists (WQ, Y2Q) | reverts, no reason (no code at the computed address) |
| pair exists but was never funded (Y2Q/HSN) | `QuantumSwapV2Library: INSUFFICIENT_LIQUIDITY` |
| QD with its high 12 bytes zeroed | reverts, no reason (D4) |

A recipient with non-zero high bytes (`0x68e84f68…5ac7d36b`) received exactly the quoted token
output, and exactly the quoted native output through `swapExactTokensForETH`.

## Repository test suite on a local devnet

`npm test` was run unmodified (compile, `scripts/devnet.js ensure`, `node --test`) against a local
QuantumCoin devnet:
- release `test-v2.0.85`, installed by hand because `devnet.js` cannot install its pinned release
  ([QSV2P-01](#qsv2p-01)); the archive's SHA-256 matches both the release hash file and GitHub's
  digest;
- node `Geth/v1.10.7-unstable/darwin-arm64/go1.26.3`, chain id 123123, HTTP RPC on
  `127.0.0.1:8545` (`QC_RPC_URL`), with `QC_DEVNET_DIR` pointing at the install, so `devnet.js`
  detected the running node and changed nothing;
- dependencies from `package-lock.json` (`npm ci --ignore-scripts`), compiler
  `0.7.6+commit.6da11747`.

Results (2026-11-14 UTC, about 14 min per run):

| File | Tests | At `779aedc` | With the QSV2P-02 item 4 fix |
|:---|:---|:---|:---|
| `test/computeLiquidityValue.test.js` | 6 | pass | pass |
| `test/oracleSimple.test.js` | 1 | pass | pass |
| `test/router02.test.js` | 10 | pass | pass |
| `test/slidingWindowOracle.test.js` | 5 | 4 pass, **1 fail** ([QSV2P-02](#qsv2p-02) item 4) | pass |
| `test/swapToPrice.test.js` | 5 | pass | pass |
| `test/fixtures.js`, `test/helpers.js` (picked up as test files) | 2 | pass | pass |
| **Total** | **29** | **28 pass, 1 fail** | **29 pass** |

An earlier run at `779aedc` gave the same oracle failure. Its four swap-to-price failures were HTTP 502 errors
from a temporary local RPC bridge while the node was being restarted. All four passed in the final
run. The passing tests execute only the router entry points marked as tested in
[QSV2P-02](#qsv2p-02).

## QuantumCoin block clock

The failing test exposed a chain behaviour that affects the router's deadline check and every
timestamp the pairs and oracles store. These checks are read-only.

| Chain | Evidence | Result |
|:---|:---|:---|
| Devnet `test-v2.0.85` | last `Sync` of 10 test pairs, plus the oracle test's block 468 | `block.timestamp` seen by the transaction = parent header + 1 s in 11/11; never equal to the containing header, which is 2–3 s later |
| Mainnet | last `Sync` of the 14 funded QuantumSwap pairs | equal to the containing header in 11/14. In the other 3 it is exactly parent header + 6 s, and the containing header is 48, 84 and 48 s later |
| Mainnet | header intervals, blocks 5052450–5055450 (2026-11-13 16:46 → 2026-11-14 06:23 UTC) | 2,230 of 3,000 exactly 6 s; 770 longer; maximum 348 s |
| Both | `eth_call` at block N, with code returning `TIMESTAMP` | block N's own header time, not parent + period |

A mined transaction therefore sees `block.timestamp` = parent header time + the block period
(6 s on mainnet, 1 s on this devnet). That equals the block's own header time only when the block
is on schedule; otherwise the EVM clock lags the header, and the wall clock, by the block's delay.
The clock stays in seconds and keeps increasing, because header times increase, so v2-core INV-07
still holds. This review observed the behaviour but did not review the node code that produces it.
Confirm with the QuantumCoin project that it is intended.

Effects:
- **Router deadlines.** `ensure(deadline)` compares against this clock. A transaction can be
  included in a block whose header time is past its deadline by up to that block's delay (342 s in
  the sample) and still pass. The minimum and maximum amount bounds still apply.
- **Oracles.** On-chain TWAP math stays consistent, because both ends of every interval use the
  same clock. Off-chain code that mixes stored timestamps (`blockTimestampLast`, oracle
  observations) with header timestamps computes wrong intervals; QSV2P-02 item 4 is an instance.
- **Simulation.** `eth_call` and gas estimation use the header clock, so a simulation and the mined
  execution can see different `block.timestamp` values.

## Inherited upstream behaviour

These are upstream Uniswap V2 design properties, unchanged in this fork. They are recorded with
what was executed; none is a finding.

- **The router pays out whatever it holds.** `removeLiquidityETHSupportingFeeOnTransferTokens`
  sends the router's entire token balance, and `swapExactTokensForETHSupportingFeeOnTransferTokens`
  withdraws its entire WQ balance. Executed: after 5 WQ were sent directly to the router, the next
  `swapExactTokensForETHSupportingFeeOnTransferTokens` paid its `to` 5.994009595442348614 Q for a
  sale worth 0.994009595442348614 Q. The router holds nothing on mainnet today (INV-P6).
- **The first deposit sets the price.** When both reserves are 0, `_addLiquidity` uses the desired
  amounts unchanged. Two mainnet pairs are empty: pant/Lio `0xa228d7d5…` and Y2Q/HSN `0xa8ad6907…`.
- **The router enforces only the bounds the caller passes:** `amountOutMin`, `amountInMax`,
  `amountAMin`/`amountBMin` and `deadline` (INV-P2, INV-P3).
- **Native coin is sent with all gas forwarded.** `safeTransferETH` to `to` or to `msg.sender` is
  always the last step, and the residue checks above show the router holds nothing at that point,
  so re-entry gains nothing.
- **WQ differs from WETH9 in one respect.** `withdraw` uses `call{value:}` instead of `transfer`.
  It updates the balance before the call, and the router's `receive()` only checks the sender.

## External caller-side invariants

These are properties the router relies on but cannot check itself. Each "Status" records what was
verified and where. The v2-core invariants INV-01 to INV-08 also apply.

| Invariant ID | Component/Contract | Required External Behavior / Guardrail | Consequence if Broken |
| :--- | :--- | :--- | :--- |
| INV-P1 | Router `to` (all 14 entry points) | Clients must pass exactly 32 bytes and never left-pad a shorter value. The router delivers to the exact word (D5). **Status:** holds in the web app. **Partially broken** in quantumcoin 8.0.2, whose encode-by-fragment path left-pads (v2-core INV-01, C-02). | Output goes to an address no key controls, and is permanently lost. |
| INV-P2 | `amountOutMin`, `amountInMax`, `amountAMin`, `amountBMin` | Derive the bounds from the user's expected amounts; never pass 0 or `MaxUint256`. **Status:** holds in the web app. `addLiquidity`, `addLiquidityETH`, `removeLiquidity` and `removeLiquidityETHSupportingFeeOnTransferTokens` all pass desired × (1 − slippage), and the helper (`Ca`) never returns 0 for a non-zero amount. Exact-output swaps pass a computed `amountInMax`. Price impact itself is not shown (v2-core C-03). | Sandwich losses. On the two empty pairs, a front-runner sets the first price. |
| INV-P3 | `deadline` | Use the current time plus a bounded window, never `MaxUint256`. Allow for the router checking the deadline against the EVM clock, which can lag the including block's header by that block's delay (up to 342 s observed; [block clock](#quantumcoin-block-clock)). **Status:** holds in the web app: latest header timestamp + 1200 s (`Ta`). | A delayed transaction executes later, at a worse price within its bounds. |
| INV-P4 | `QuantumSwapV2Library` / `QuantumSwapV2LiquidityMathLibrary` `factory` argument | Pass only the canonical factory, never a caller-supplied one. `pairFor` takes `INIT_CODE_HASH` from the factory, so a hostile factory can point it at any code. Upstream's hard-coded hash limited a fake factory to genuine Pair bytecode. **Status:** the router and the examples use an immutable constructor value, and the deployed router's is the verified factory. Both libraries ship in the npm package. | Integrators send funds to, or price from, attacker contracts. |
| INV-P5 | Fee-on-transfer tokens | Use the `…SupportingFeeOnTransferTokens` functions. Plain functions fail closed (verified with HSN). **Status:** the web app uses the Supporting functions for every exact-input swap and for every WQ-pair removal. Exact-output swaps are simulated first and fall back to exact-input. | The plain-function call reverts; no loss. |
| INV-P6 | Router balance | Nothing may be sent to the router outside a router call. **Status:** the router holds 0 native Q, 0 of the 20 listed tokens and 0 of the 16 LP tokens at block 5039592. | The next caller takes it (executed). |
| INV-P7 | Toolchain (`@quantumcoin/solc`) | v2-core INV-06 applies to the router build and to `QuantumSwapV2OracleLibrary` (D9). **Status:** 0.7.6 and 0.7.7 produce identical output. `package.json` allows `^0.7.6`, but `package-lock.json` pins 0.7.6. | Under checked arithmetic, oracle consumers of the library revert after the uint32 timestamp wraps. |
| INV-P8 | Off-chain code that reads `blockTimestampLast`, oracle observations or deadlines | Treat on-chain `block.timestamp` as the parent header time plus the block period, not the including block's header time, and never compare the two directly. **Status:** broken in this repository's `test/slidingWindowOracle.test.js` at `779aedc` ([QSV2P-02](#qsv2p-02) item 4); fixed in the working tree, not committed. The route API indexer was not reviewed. | Wrong elapsed times and TWAPs off-chain, false test failures, and deadline expectations off by the block's delay. |

## Revisions assessed

Every "Not Reachable" verdict and every invariant status applies to these exact revisions. Each
must be re-checked when any of them changes.

| Component | Revision | Notes |
|:---|:---|:---|
| `v2-periphery` (this repo) | `779aedc68a77c61e605cd32e65a4d7d61a524bf6` | clean tree apart from this document and the uncommitted QSV2P-02 item 4 fix to `test/slidingWindowOracle.test.js` |
| npm `@quantumswap/v2-periphery` | 1.0.1 (`sha512-0mgz3akU…yqJZnw==`, `gitHead` `91f56e9`) | `contracts/` identical to this repo |
| `v2-core` | `29ab87e`; npm `@quantumswap/v2-core` 1.0.1 (`sha512-nBB43sMe…jX/pQ==`) | identical apart from CRLF |
| `@quantumcoin/solidity-lib` | 1.0.0 (`sha512-xRUDmu0o…UawD2g==`) | as pinned in `package-lock.json` |
| `@quantumcoin/wq` | 1.0.0 (`sha512-TGhnM3wH…XAb6mg==`) | matches mainnet WQ |
| `@quantumcoin/solc` | 0.7.6 (`sha512-voV0/84e…bH/VA==`) and 0.7.7 | identical output |
| `quantumcoin` | 8.0.2 | as pinned |
| Upstream | Uniswap v2-periphery `2efa12e`; `@uniswap/lib` 4.0.1-alpha | |
| Web app bundle | `assets/index-B2v-1s0P.js` (138,781 bytes), fetched 2026-11-10 | same bundle as the v2-core review |
| QuantumCoin mainnet | blocks 5039588–5039592 (2026-11-11T06:41:30Z – 06:43:00Z) | chain id 123123; bytecode, router execution, D1–D9 |
| QuantumCoin mainnet (block clock) | blocks 5052450–5055457 (2026-11-13T16:46Z – 2026-11-14T06:24Z) | header intervals, pair timestamps, `eth_call` clock |
| Devnet release pinned by `scripts/devnet.js` | `test-v2.0.74` | no platform can complete a verified install ([QSV2P-01](#qsv2p-01)) |
| Devnet used for the test run | `test-v2.0.85`, installed by hand: `qc-release-mac-devnet-test-v2.0.85.tar.gz` SHA-256 `a6b8fd62e6181a8988cbabb938306b7dae93b05e1ba8b7d72b2839a2bc7eb459`, matching both the release hash file and GitHub's digest | node `Geth/v1.10.7-unstable/darwin-arm64/go1.26.3`, chain id 123123, HTTP RPC on `127.0.0.1:8545`; test run 2026-11-14 UTC |

## Reproduction

The harness scripts used for this review are not committed with this document. Each item below
states what to execute.

**Dependencies.** Reproduce the locked tree outside the repository with install scripts disabled:
copy `package.json` and `package-lock.json` to a scratch directory and run
`npm ci --ignore-scripts`. For D10, also install `@quantumcoin/solc@0.7.7`.

**Deployed bytecode.**
1. Compile `contracts/QuantumSwapV2Router02.sol` with the settings in `scripts/qc-solc.js`, adding
   `evm.deployedBytecode.immutableReferences` to `outputSelection`.
2. Write the factory address into every reference of the first immutable (`factory`) and the WQ
   address into every reference of the second (`WETH`).
3. Compare the result with `eth_getCode(0xc3666584…5d861e)`. Repeat with
   `@quantumcoin/wq/wrappedq.sol` for WQ.

**Mainnet execution (D1–D9 and the router tables).**
1. Write a harness contract that imports this repository's `QuantumSwapV2Library`,
   `QuantumSwapV2OracleLibrary`, interfaces and test tokens, and that calls the router at its
   constant address. The QuantumCoin compiler checksums 32-byte address literals.
2. Compile it with the production settings and run each scenario as:

```sh
RPC=https://public.rpc.quantumcoinapi.com
P=0x5eeda1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1
curl -s -X POST $RPC -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[
  {"from":"'$P'","to":"'$P'","data":"<selector+args>","gas":"0x2faf080"}, "<block>",
  {"'$P'":{"code":"<harness runtime>","balance":"0x33b2e3c9fd0803ce8000000"},
   "<token>":{"stateDiff":{"<keccak256(P ‖ slot)>":"<balance>"}}}]}'
```

3. For D9, override the pair's slot 6 (top 32 bits: `blockTimestampLast`) and slot 7
   (`price0CumulativeLast`), then compare with the expected value computed modulo 2²⁵⁶.

**QSV2P-01.**
- Fail-open: run v2-core's QSV2-01 PoC block from this repository's root. For the control, remove
  the two proxy variables.
- Wrong files: in a scratch directory, preload
  `Object.defineProperty(process, "platform", { value: process.env.FAKE_PLATFORM })` and run
  `FAKE_PLATFORM=linux TMPDIR=<scratch>/tmp/ QC_DEVNET_DIR=<scratch>/devnet QC_RPC_URL=<a live RPC> node -r <preload> scripts/devnet.js ensure`.
  For Windows, use `FAKE_PLATFORM=win32` and also set `TEMP=<scratch>/tmp`. Pointing the RPC check
  at a live node stops the script from launching anything if verification ever passed.
- Compare each release's `releasehash-<platform>-devnet-<release>.txt` with GitHub's asset digests
  (`GET /repos/quantumcoinproject/quantum-coin-go/releases/tags/<release>`).

**QSV2P-02.**
- Search `test/` for each router function name to rebuild the coverage table.
- `npm run lint` shows the missing script.
- `git branch -a` shows that no `master` branch exists.
- Test suite: start a `test-v2.0.85` devnet with `./connectvalidator.sh 8545`, then run
  `npm ci --ignore-scripts` and
  `QC_RPC_URL=http://127.0.0.1:8545 QC_DEVNET_DIR=<devnet dir> npm test`.

**Block clock.**
- For each pair, compare `getReserves().blockTimestampLast` with the header timestamps of the
  block that holds the pair's last `Sync` log and of that block's parent.
- For the `eth_call` clock, call any address at block N with the code override
  `0x4260005260206000f3`, which returns `TIMESTAMP`, and compare the result with block N's header.
- For intervals, read the headers of a recent block range and take the differences.

**QSV2P-03.**
- Compile a `view` function that returns `IQuantumSwapV2Router02(r).WETH()`.
- With quantumcoin 8.0.2, build `new Contract(router, interfaceAbi, provider)` and call `WETH()`.
- To verify the fix, change both getters to `view` and compare the router's runtime bytecode with
  the deployed build.

## Status

| | |
|:---|:---|
| Open findings | 3 (QSV2P-01 Medium, QSV2P-02 Low, QSV2P-03 Low) |
| Defects in contract logic | 0 |
| Findings enabling loss, theft or freezing of funds | 0 |
| Requiring emergency action | 0 |
| Deployed bytecode matches audited source | router: yes; WQ: yes; factory: yes |
| Router entry points executed on mainnet state | 14/14, plus 11 negative paths |
| Repository test suite (devnet `test-v2.0.85`) | 28/29 pass at `779aedc` (the failure is a test defect, [QSV2P-02](#qsv2p-02) item 4); 29/29 with that test fixed (uncommitted) |
| Invariants verified holding in the web app | INV-P1, INV-P2, INV-P3, INV-P5 |
| Invariants broken in a consumer | INV-P1 (quantumcoin 8.0.2, partial; v2-core C-02); INV-P8 (this repository's oracle test) |
| Shared with v2-core | QSV2P-01 (= QSV2-01, including the wrong-file check); QSV2P-02 item 3 (= QSV2-02 item 3) |
| To raise with the QuantumCoin project | the [block clock](#quantumcoin-block-clock) behaviour; devnet release assets with no matching hash file ([QSV2P-01](#qsv2p-01)) |

Last verified by execution against `v2-periphery@779aedc`: bytecode, mainnet execution and tooling
on 2026-11-10; the devnet test suite and block-clock checks on 2026-11-13.

## Standards referenced

- [CWE] — MITRE Common Weakness Enumeration, used for classification only.
- [SP 800-30r1] — *Guide for Conducting Risk Assessments*, Rev. 1: separate likelihood and impact scales.
- [OWASP Risk Rating Methodology][owasp-rr] — likelihood × impact with explicit factors.
- [CVSS v4.0][cvss4] — separates the Exploitability and Impact metric groups.
- [OASIS CSAF 2.0][csaf] and [OpenVEX][openvex] — VEX, the standardized form of the reachability axis.
- [EIP-1014] — `CREATE2`; QuantumCoin keeps all 32 bytes of the hash.
- [EIP-2612] — `permit`, removed in this fork.
- [Uniswap V2 Periphery][uni-v2p] — upstream source (`2efa12e`); router, library and fee-on-transfer design inherited here.

[CWE]: https://cwe.mitre.org/
[CWE-494]: https://cwe.mitre.org/data/definitions/494.html
[CWE-636]: https://cwe.mitre.org/data/definitions/636.html
[SP 800-30r1]: https://doi.org/10.6028/NIST.SP.800-30r1
[owasp-rr]: https://owasp.org/www-community/OWASP_Risk_Rating_Methodology
[cvss4]: https://www.first.org/cvss/v4.0/specification-document
[csaf]: https://docs.oasis-open.org/csaf/csaf/v2.0/csaf-v2.0.html
[openvex]: https://github.com/openvex/spec
[EIP-1014]: https://eips.ethereum.org/EIPS/eip-1014
[EIP-2612]: https://eips.ethereum.org/EIPS/eip-2612
[uni-v2p]: https://github.com/Uniswap/v2-periphery
