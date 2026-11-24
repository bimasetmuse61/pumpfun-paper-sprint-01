// Hot-launch sniper for the pump.fun paper sprint (agent-fun/replay/v2).
//
// The bot watches every new bonding curve for a few slots after creation and
// buys the ones that already show real, broad, non-creator demand. It then
// exits on a small take-profit, a wider stop-loss, a hold timeout, or the
// creator selling. Orders are split into pieces when the bot's own fill count
// lags a pace of 300 fills over 21,600 seconds of block time.
//
// Everything is deterministic: insertion-ordered maps only, no clock (only
// slot numbers and event block_time), no randomness, no network, no model
// calls. All money is bigint lamports (1 SOL = 1e9 lamports).

import type { Batch, BotState, OrderInput } from './vendor/makefun-bot.ts';

const BPS_DEN = 10_000n;
/** Curve fee for a sell valuation: protocol 95 bps + creator 30 bps = 1.25%. */
const SELL_PROTOCOL_BPS = 95n;
const SELL_CREATOR_BPS = 30n;

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

export interface Params {
  /** Minimum age (slots since CreateEvent) at which a coin may be bought. */
  minAge: number;
  /** Maximum age (slots since CreateEvent); older unbought coins are done forever. */
  maxAge: number;
  /** Target buy size in lamports. */
  stakeLamports: number;
  /** Smallest buy size in lamports. */
  minBuyLamports: number;
  /** Maximum committed positions (held + buys pending). */
  maxPositions: number;
  /** Real SOL reserve bounds for entry, in lamports. */
  minRealSolLamports: number;
  maxRealSolLamports: number;
  /** Creator's own buy total inside the create slot, in lamports. */
  minCreatorBuyLamports: number;
  maxCreatorBuyLamports: number;
  /** Minimum trades seen on the coin before entry. */
  minTrades: number;
  /** Minimum / maximum distinct non-creator buyers before entry. */
  minBuyers: number;
  maxBuyers: number;
  /** Max ratio of SOL sold by non-creators to SOL bought by non-creators, in bps. */
  maxSellRatioBps: number;
  /** Max single non-creator sell as bps of the real SOL reserve just before it. */
  maxBigSellBps: number;
  /** Price run-up vs the create price, in bps. */
  minRunUpBps: number;
  maxRunUpBps: number;
  /** Slots of recent trades used for the net-flow check. */
  flowWindowSlots: number;
  /** Net flow over the window must stay above this (lamports). */
  minFlowLamports: number;
  /** Max slippage on buys / sells, in bps. */
  buySlippageBps: number;
  sellSlippageBps: number;
  /** Take profit: sell when value is this far above basis, in bps. */
  tpBps: number;
  /** Stop loss: sell when value is this far below basis, in bps. */
  slBps: number;
  /** Maximum slots to hold a position. */
  maxHoldSlots: number;
  /** Exit when the creator sells while a position is held. */
  exitOnCreatorSell: boolean;
  /** Trailing stop / stale exit / flow exit / partial take-profit switches (all off). */
  useTrailingStop: boolean;
  useStaleExit: boolean;
  useFlowExit: boolean;
  usePartialTp: boolean;
  /** Fill-pacing target: this many own fills over this many seconds of block time. */
  fillTarget: number;
  fillWindowSeconds: number;
  /** Extra pieces kick in when the fill lag exceeds this many fills (15% of target). */
  paceLagExtraFills: number;
  /** Pieces per order: base, cap. */
  baseSplit: number;
  maxSplit: number;
  /** Smallest piece size, in lamports. */
  minPieceLamports: number;
  /** Free cash must cover the buy plus this many tx fees. */
  cashFeeMultiple: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 0,
  maxAge: 3,
  stakeLamports: 500_000_000, // 0.5 SOL
  minBuyLamports: 5_000_000, // 0.005 SOL
  maxPositions: 5,
  minRealSolLamports: 300_000_000, // 0.3 SOL
  maxRealSolLamports: 30_000_000_000, // 30 SOL
  minCreatorBuyLamports: 0,
  maxCreatorBuyLamports: 2_500_000_000, // 2.5 SOL
  minTrades: 8,
  minBuyers: 5,
  maxBuyers: 1_000_000_000, // no effective cap
  maxSellRatioBps: 10_000, // 100%
  maxBigSellBps: 10_000, // 100%
  minRunUpBps: 0,
  maxRunUpBps: 1_000_000,
  flowWindowSlots: 10,
  minFlowLamports: -1_000_000_000_000, // no effective constraint
  buySlippageBps: 10_000,
  sellSlippageBps: 10_000,
  tpBps: 1000, // +10%
  slBps: 1200, // -12%
  maxHoldSlots: 30,
  exitOnCreatorSell: true,
  useTrailingStop: false,
  useStaleExit: false,
  useFlowExit: false,
  usePartialTp: false,
  fillTarget: 300,
  fillWindowSeconds: 21_600,
  paceLagExtraFills: 45, // 15% of the 300 target
  baseSplit: 1,
  maxSplit: 6,
  minPieceLamports: 2_000_000, // 0.002 SOL
  cashFeeMultiple: 6,
};

interface RecentTrade {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: string;
}

interface Coin {
  mint: string;
  createSlot: number;
  creator: string;
  createVq: bigint;
  createVt: bigint;
  creatorBuy: bigint;
  trades: number;
  buyers: Set<string>;
  /** SOL bought by non-creators. */
  bought: bigint;
  /** SOL sold by non-creators. */
  sold: bigint;
  /** Largest single non-creator sell, bps of the real SOL reserve just before it. */
  biggestSellBps: bigint;
  creatorSold: boolean;
  lastTradeSlot: number;
  /** Recent trades, oldest first, pruned to the flow window. */
  recent: RecentTrade[];
  complete: boolean;
}

interface Held {
  mint: string;
  openedSlot: number;
  /** Tx fees paid on this position's fills. */
  txPaid: bigint;
  /** Best observed sell value (tracked for the trailing stop, which is off). */
  bestValue: bigint;
  creatorSoldAtOpen: boolean;
  /** Partial take-profit flag (unused; partial take-profit is off). */
  tookTp1: boolean;
}

export function createStrategy(params: Params = DEFAULT_PARAMS) {
  const p = params;
  // Coins in first-appearance order.
  const coins = new Map<string, Coin>();
  // Coins already bought or permanently passed over.
  const decided = new Set<string>();
  // Held positions with their bookkeeping.
  const held = new Map<string, Held>();
  // Mints with a sell currently in flight (rebuilt from pending each batch).
  let selling = new Set<string>();
  // Own filled orders (harness closes excluded) for the fill-pacing rule.
  let filledOwn = 0;
  // Block time of the first event seen; the pace clock starts here.
  let firstBlockTime: number | null = null;
  let lastBlockTime: number | null = null;

  /** Pieces per order from the fill pace: 1 normally, 2 when behind, 3 when far behind. */
  function splitCount(): number {
    if (firstBlockTime === null || lastBlockTime === null) return p.baseSplit;
    const elapsed = BigInt(lastBlockTime - firstBlockTime);
    if (elapsed <= 0n) return p.baseSplit;
    const expected = BigInt(p.fillTarget) * elapsed;
    const have = BigInt(filledOwn) * BigInt(p.fillWindowSeconds);
    if (have >= expected) return p.baseSplit;
    let pieces = p.baseSplit + 1;
    if (expected - have > BigInt(p.paceLagExtraFills) * BigInt(p.fillWindowSeconds)) {
      pieces = p.baseSplit + 2;
    }
    return Math.min(pieces, p.maxSplit);
  }

  /** Net SOL flow of a coin over the flow window (buys minus sells, lamports). */
  function netFlow(coin: Coin, slot: number): bigint {
    const from = slot - p.flowWindowSlots;
    let flow = 0n;
    for (const t of coin.recent) {
      if (t.slot < from) continue;
      flow += t.isBuy ? t.sol : -t.sol;
    }
    return flow;
  }

  /** Mark (or curve) reserves for a mint, as virtual quote / virtual token. */
  function markReserves(
    state: BotState,
    batch: Batch,
    mint: string,
  ): { vq: bigint; vt: bigint } | null {
    const mark = batch.marks.find((m) => m.mint === mint);
    if (mark !== undefined) {
      return { vq: BigInt(mark.virtual_quote_reserves), vt: BigInt(mark.virtual_token_reserves) };
    }
    const curve = state.curves.get(mint);
    if (curve === undefined) return null;
    return { vq: curve.virtual_quote_reserves, vt: curve.virtual_token_reserves };
  }

  /** Proceeds of selling `tokens` at the current mark, after 1.25% curve fees, minus one tx fee. */
  function sellValue(state: BotState, batch: Batch, mint: string, tokens: bigint, txFee: bigint): bigint {
    const r = markReserves(state, batch, mint);
    if (r === null || r.vt === 0n) return -txFee;
    const q = (tokens * r.vq) / (r.vt + tokens);
    const fee = ceilDiv(q * SELL_PROTOCOL_BPS, BPS_DEN);
    const creatorFee = ceilDiv(q * SELL_CREATOR_BPS, BPS_DEN);
    return q - fee - creatorFee - txFee;
  }

  /** Gross proceeds (before the tx fee) of selling `tokens` at the current mark. */
  function grossSellProceeds(state: BotState, batch: Batch, mint: string, tokens: bigint): bigint {
    const r = markReserves(state, batch, mint);
    if (r === null || r.vt === 0n) return 0n;
    const q = (tokens * r.vq) / (r.vt + tokens);
    return q - ceilDiv(q * SELL_PROTOCOL_BPS, BPS_DEN) - ceilDiv(q * SELL_CREATOR_BPS, BPS_DEN);
  }

  function onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    const txFee = state.txFeeLamports();
    const maxOrders = state.hello.caps.max_orders_per_batch;

    // --- 1. Fills ---------------------------------------------------------
    for (const f of batch.fills) {
      if (f.client_id.startsWith('_')) {
        // A harness close: the position is gone; drop its records.
        held.delete(f.mint);
        selling.delete(f.mint);
        continue;
      }
      if (f.status === 'filled') filledOwn += 1;
      if (f.status === 'rejected') continue;
      const fee = BigInt(f.tx_fee_lamports);
      if (f.side === 'buy' && f.status === 'filled') {
        const h = held.get(f.mint);
        if (h === undefined) {
          const coin = coins.get(f.mint);
          held.set(f.mint, {
            mint: f.mint,
            openedSlot: f.slot,
            txPaid: fee,
            bestValue: 0n,
            creatorSoldAtOpen: coin !== undefined && coin.creatorSold,
            tookTp1: false,
          });
        } else {
          h.txPaid += fee;
        }
      } else {
        const h = held.get(f.mint);
        if (h !== undefined) h.txPaid += fee;
      }
    }

    // --- 2. Events: track every coin --------------------------------------
    for (const e of batch.events) {
      if (e.block_time !== null && e.block_time !== undefined) {
        if (firstBlockTime === null) firstBlockTime = e.block_time;
        if (lastBlockTime === null || e.block_time > lastBlockTime) lastBlockTime = e.block_time;
      }
      if (e.event === 'CreateEvent') {
        if (!coins.has(e.mint)) {
          coins.set(e.mint, {
            mint: e.mint,
            createSlot: e.slot,
            creator: e.creator,
            createVq: BigInt(e.virtual_quote_reserves),
            createVt: BigInt(e.virtual_token_reserves),
            creatorBuy: 0n,
            trades: 0,
            buyers: new Set<string>(),
            bought: 0n,
            sold: 0n,
            biggestSellBps: 0n,
            creatorSold: false,
            lastTradeSlot: e.slot,
            recent: [],
            complete: false,
          });
        }
      } else if (e.event === 'TradeEvent') {
        let coin = coins.get(e.mint);
        if (coin === undefined) {
          // A trade before any CreateEvent we saw: seed the record from it.
          coin = {
            mint: e.mint,
            createSlot: e.slot,
            creator: e.creator,
            createVq: BigInt(e.virtual_quote_reserves),
            createVt: BigInt(e.virtual_token_reserves),
            creatorBuy: 0n,
            trades: 0,
            buyers: new Set<string>(),
            bought: 0n,
            sold: 0n,
            biggestSellBps: 0n,
            creatorSold: false,
            lastTradeSlot: e.slot,
            recent: [],
            complete: false,
          };
          coins.set(e.mint, coin);
        }
        const sol = BigInt(e.sol_amount);
        coin.trades += 1;
        coin.lastTradeSlot = e.slot;
        const isCreator = e.user === coin.creator;
        if (e.is_buy) {
          if (isCreator) {
            if (e.slot === coin.createSlot) coin.creatorBuy += sol;
          } else {
            coin.buyers.add(e.user);
            coin.bought += sol;
          }
        } else if (isCreator) {
          coin.creatorSold = true;
        } else {
          coin.sold += sol;
          // Real SOL just before this sell: post-trade reserves plus what left.
          const pre = BigInt(e.real_sol_reserves) + sol;
          const bps = pre > 0n ? (sol * BPS_DEN) / pre : 0n;
          if (bps > coin.biggestSellBps) coin.biggestSellBps = bps;
        }
        coin.recent.push({ slot: e.slot, isBuy: e.is_buy, sol, user: e.user });
        const pruneBefore = e.slot - p.flowWindowSlots;
        while (coin.recent.length > 0 && coin.recent[0]!.slot < pruneBefore) coin.recent.shift();
      } else {
        // CompleteEvent: the curve is done; never consider it again.
        const coin = coins.get(e.mint);
        if (coin !== undefined) coin.complete = true;
        decided.add(e.mint);
      }
    }

    // --- 3. Housekeeping ---------------------------------------------------
    const pendingBuy = new Set<string>();
    const pendingSell = new Set<string>();
    for (const po of state.pending.values()) {
      if (po.order.side === 'buy') pendingBuy.add(po.order.mint);
      else pendingSell.add(po.order.mint);
    }
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint) && !pendingBuy.has(mint)) held.delete(mint);
    }
    selling = new Set(pendingSell);

    const pieces = splitCount();
    const minPiece = BigInt(p.minPieceLamports);

    // --- 4. Exits first, in position iteration order -----------------------
    for (const [mint, pos] of state.positions) {
      if (orders.length >= maxOrders) break;
      let h = held.get(mint);
      if (h === undefined) {
        const coin = coins.get(mint);
        h = {
          mint,
          openedSlot: state.slot,
          txPaid: 0n,
          bestValue: 0n,
          creatorSoldAtOpen: coin !== undefined && coin.creatorSold,
          tookTp1: false,
        };
        held.set(mint, h);
      }
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (selling.has(mint)) continue;
      const value = sellValue(state, batch, mint, pos.token_amount, txFee);
      if (value > h.bestValue) h.bestValue = value;
      const basis = pos.cost_lamports + h.txPaid;
      const takeProfit = value * BPS_DEN >= basis * (BPS_DEN + BigInt(p.tpBps));
      const stopLoss = value * BPS_DEN <= basis * (BPS_DEN - BigInt(p.slBps));
      const heldLong = state.slot - h.openedSlot >= p.maxHoldSlots;
      const coin = coins.get(mint);
      const creatorDump =
        p.exitOnCreatorSell && coin !== undefined && coin.creatorSold && !h.creatorSoldAtOpen;
      // Trailing stop, stale exit and flow exit are off; partial take-profit is off.
      if (!takeProfit && !stopLoss && !heldLong && !creatorDump) continue;
      // Sell everything, split into equal pieces (last piece takes the remainder).
      const total = pos.token_amount;
      let n = pieces;
      const gross = grossSellProceeds(state, batch, mint, total);
      const byMinPiece = gross / minPiece;
      if (BigInt(n) > byMinPiece) n = byMinPiece < 1n ? 1 : Number(byMinPiece);
      if (orders.length + n > maxOrders) n = maxOrders - orders.length;
      if (n <= 0) continue;
      const per = total / BigInt(n);
      for (let i = 0; i < n; i++) {
        const amount = i < n - 1 ? per : total - per * BigInt(n - 1);
        if (amount <= 0n) continue;
        orders.push({
          side: 'sell',
          mint,
          token_amount: amount,
          max_slippage_bps: p.sellSlippageBps,
        });
      }
      selling.add(mint);
    }

    // --- 5. Entries, in first-appearance order ------------------------------
    const plannedBuys = new Set<string>();
    let reserved = 0n; // lamports committed by orders planned in this reply
    const stake = BigInt(p.stakeLamports);
    const minBuy = BigInt(p.minBuyLamports);
    const minReal = BigInt(p.minRealSolLamports);
    const maxReal = BigInt(p.maxRealSolLamports);
    const minCreatorBuy = BigInt(p.minCreatorBuyLamports);
    const maxCreatorBuy = BigInt(p.maxCreatorBuyLamports);
    const minFlow = BigInt(p.minFlowLamports);

    for (const [mint, coin] of coins) {
      if (orders.length >= maxOrders) break;
      if (decided.has(mint)) continue;
      const age = state.slot - coin.createSlot;
      if (age > p.maxAge) {
        decided.add(mint);
        continue;
      }
      if (age < p.minAge) continue;
      if (state.committedPositionCount() + plannedBuys.size >= p.maxPositions) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined) continue;
      if (curve.complete) {
        decided.add(mint);
        continue;
      }
      if (coin.creatorSold) continue;
      const realSol = curve.real_quote_reserves;
      if (realSol < minReal || realSol > maxReal) continue;
      if (coin.creatorBuy < minCreatorBuy || coin.creatorBuy > maxCreatorBuy) continue;
      if (coin.trades < p.minTrades) continue;
      if (coin.buyers.size < p.minBuyers || coin.buyers.size > p.maxBuyers) continue;
      // Sold by others vs bought by others: at most maxSellRatioBps.
      if (coin.sold * BPS_DEN > coin.bought * BigInt(p.maxSellRatioBps)) continue;
      if (coin.biggestSellBps > BigInt(p.maxBigSellBps)) continue;
      // Price run-up vs the create price, in bps (exact integer comparison).
      const lhs = curve.virtual_quote_reserves * coin.createVt;
      const rhs = coin.createVq * curve.virtual_token_reserves;
      if (lhs < rhs) continue; // below the create price
      if (lhs !== rhs) {
        if (
          (lhs - rhs) * BPS_DEN > BigInt(p.maxRunUpBps) * rhs ||
          (lhs - rhs) * BPS_DEN < BigInt(p.minRunUpBps) * rhs
        ) {
          continue;
        }
      } else if (p.minRunUpBps > 0) {
        continue; // flat: run-up 0 bps, below a positive minimum
      }
      // Recent net flow over the flow window.
      if (netFlow(coin, state.slot) <= minFlow) continue;
      // Size: the smaller of the stake and the per-order cap; at least minBuy.
      const cap = state.maxBuyLamports(mint);
      const amount = stake < cap ? stake : cap;
      if (amount < minBuy) continue;
      const free = state.freeCashLamports() - reserved;
      if (free < amount + BigInt(p.cashFeeMultiple) * txFee) continue;
      // Split into pieces, each at least minPiece.
      let n = pieces;
      const byMinPiece = amount / minPiece;
      if (BigInt(n) > byMinPiece) n = byMinPiece < 1n ? 1 : Number(byMinPiece);
      if (orders.length + n > maxOrders) n = maxOrders - orders.length;
      if (n <= 0) continue;
      const per = amount / BigInt(n);
      for (let i = 0; i < n; i++) {
        const piece = i < n - 1 ? per : amount - per * BigInt(n - 1);
        if (piece <= 0n) continue;
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: piece,
          max_slippage_bps: p.buySlippageBps,
        });
      }
      reserved += amount + BigInt(n) * txFee;
      plannedBuys.add(mint);
      decided.add(mint);
    }

    return orders;
  }

  return { onBatch };
}
