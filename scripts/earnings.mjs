import { setTimeout as delay } from "node:timers/promises";
import { requirement } from "../src/metadata.js";

const rpcUrl = process.env.BASE_RPC_URL ?? "https://base-rpc.publicnode.com";
const payee = requirement.payTo.toLowerCase();
const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const toTopic = `0x${payee.slice(2).padStart(64, "0")}`;
const zeroAddress = `0x${"0".repeat(40)}`;
const blockRange = 10_000;
const launchBlock = 59_784_121; // 2026-11-20 03:59:59 UTC, before the first public preview.

async function rpc(method, params) {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      if (!Object.hasOwn(body, "result")) throw new Error(body.error?.message ?? "Missing result");
      return body.result;
    } catch (error) {
      if (attempt === 3) throw new Error(`${method} failed: ${error.message}`);
      await delay(1000 * 2 ** attempt);
    }
  }
}

const hex = (value) => `0x${value.toString(16)}`;
const usdc = (units) => `${units / 1_000_000n}.${String(units % 1_000_000n).padStart(6, "0")}`;

async function main() {
  if (await rpc("eth_chainId", []) !== "0x2105") throw new Error("Expected Base mainnet");
  const firstBlock = Number(process.env.BASE_FROM_BLOCK ?? launchBlock);
  const head = await rpc("eth_getBlockByNumber", ["latest", false]);
  if (head?.number == null) throw new Error("Base RPC did not return the latest block");
  const lastBlock = Number(head.number);
  if (!Number.isSafeInteger(firstBlock) || firstBlock < 0 || firstBlock > lastBlock) {
    throw new Error(`BASE_FROM_BLOCK must be an integer between 0 and ${lastBlock}`);
  }
  let nextBlock = firstBlock;
  const logs = [];

  async function scan() {
    while (nextBlock <= lastBlock) {
      const start = nextBlock;
      nextBlock += blockRange;
      const end = Math.min(nextBlock - 1, lastBlock);
      try {
        logs.push(...await rpc("eth_getLogs", [{
          fromBlock: hex(start), toBlock: hex(end),
          address: requirement.asset, topics: [transferTopic, null, toTopic],
        }]));
      } catch (error) {
        throw new Error(`Base blocks ${start}–${end}: ${error.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: 4 }, () => scan()));
  const receipts = logs.map(log => ({ ...log, from: `0x${log.topics[1].slice(-40).toLowerCase()}`, amount: BigInt(log.data) }))
    .filter(receipt => receipt.amount > 0n && receipt.from !== payee)
    .sort((a, b) => Number(b.blockNumber) - Number(a.blockNumber) || Number(b.logIndex) - Number(a.logIndex));
  const payers = new Set(receipts.map(receipt => receipt.from).filter(from => from !== zeroAddress));
  const recent = await Promise.all(receipts.slice(0, 5).map(async ({ blockNumber, transactionHash, logIndex, from, amount }) => {
    const block = await rpc("eth_getBlockByNumber", [blockNumber, false]);
    const time = new Date(Number(block.timestamp) * 1000).toISOString();
    return `${time}  ${usdc(amount)} USDC  ${from}  https://basescan.org/tx/${transactionHash}#eventlog  (log ${Number(logIndex)})`;
  }));

  const asOf = new Date(Number(head.timestamp) * 1000).toISOString();
  console.log(`Base native USDC receipts to ${requirement.payTo}, blocks ${firstBlock}–${lastBlock} (through ${asOf})`);
  console.log(`Total received: ${usdc(receipts.reduce((total, receipt) => total + receipt.amount, 0n))} USDC`);
  console.log(`Distinct payers: ${payers.size}`);
  console.log(`Last payments (${recent.length} of ${receipts.length} inbound transfers):`);
  console.log(recent.join("\n") || "None");
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
