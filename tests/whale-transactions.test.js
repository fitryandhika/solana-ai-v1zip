const test = require("node:test");
const assert = require("node:assert/strict");

const { parseSwapFromTransaction } = require("../lib/solana/whale-parser");

const TOKEN_MINT = "TokenMint11111111111111111111111111111111";
const WALLET = "BuyerWallet1111111111111111111111111111111";
const POOL_ATA = "PoolTokenAccount111111111111111111111111111";

function buildMockTx({ preAmount, postAmount, preLamports, postLamports, err = null, mint = TOKEN_MINT }) {
  return {
    blockTime: 1700000000,
    meta: {
      err,
      preTokenBalances: [{ accountIndex: 1, mint, owner: WALLET, uiTokenAmount: { uiAmount: preAmount } }],
      postTokenBalances: [{ accountIndex: 1, mint, owner: WALLET, uiTokenAmount: { uiAmount: postAmount } }],
      // Index 0 = WALLET's own account (fee payer) — this is where its SOL
      // balance change is read from. Index 1 = the pool's token account,
      // an unrelated PDA that just needs a placeholder value.
      preBalances: [preLamports, 2039280],
      postBalances: [postLamports, 2039280]
    },
    transaction: {
      message: {
        header: { numRequiredSignatures: 1 },
        accountKeys: [{ pubkey: { toBase58: () => WALLET } }, { pubkey: { toBase58: () => POOL_ATA } }]
      }
    }
  };
}

test("parseSwapFromTransaction returns null for a failed transaction", () => {
  const tx = buildMockTx({ preAmount: 0, postAmount: 100, preLamports: 2000000000, postLamports: 1000000000, err: "some error" });
  assert.equal(parseSwapFromTransaction(tx, TOKEN_MINT, 150), null);
});

test("parseSwapFromTransaction returns null when no signer balance changed", () => {
  const tx = buildMockTx({ preAmount: 50, postAmount: 50, preLamports: 2000000000, postLamports: 2000000000 });
  assert.equal(parseSwapFromTransaction(tx, TOKEN_MINT, 150), null);
});

test("parseSwapFromTransaction detects a buy (token balance increased)", () => {
  // Wallet's token balance went 0 -> 100 (bought), SOL went down by 2 SOL.
  const tx = buildMockTx({ preAmount: 0, postAmount: 100, preLamports: 2000000000, postLamports: 0 });
  const result = parseSwapFromTransaction(tx, TOKEN_MINT, 150); // SOL price $150

  assert.equal(result.wallet, WALLET);
  assert.equal(result.direction, "buy");
  assert.equal(result.tokenAmount, 100);
  assert.equal(result.usdValue, 300); // 2 SOL * $150
});

test("parseSwapFromTransaction detects a sell (token balance decreased)", () => {
  const tx = buildMockTx({ preAmount: 100, postAmount: 0, preLamports: 0, postLamports: 1000000000 });
  const result = parseSwapFromTransaction(tx, TOKEN_MINT, 200);

  assert.equal(result.direction, "sell");
  assert.equal(result.tokenAmount, 100);
  assert.equal(result.usdValue, 200); // 1 SOL * $200
});

test("parseSwapFromTransaction returns null usdValue when SOL price is unavailable", () => {
  const tx = buildMockTx({ preAmount: 0, postAmount: 100, preLamports: 2000000000, postLamports: 0 });
  const result = parseSwapFromTransaction(tx, TOKEN_MINT, null);

  assert.equal(result.direction, "buy");
  assert.equal(result.usdValue, null);
});

test("parseSwapFromTransaction ignores balance changes for a different mint", () => {
  const tx = buildMockTx({ preAmount: 0, postAmount: 100, preLamports: 2000000000, postLamports: 0, mint: "SomeOtherMint" });
  assert.equal(parseSwapFromTransaction(tx, TOKEN_MINT, 150), null);
});
