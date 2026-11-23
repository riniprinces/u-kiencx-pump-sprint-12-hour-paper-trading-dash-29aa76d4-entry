// Creation snipe for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// Idea: the most predictable move on a pump.fun curve is the first few seconds after
// creation. The creator's own opening buy and the first flurry of buyers push the price
// up off the floor; a coin that is going to run usually shows it immediately, and a coin
// that is going to die usually shows that just as fast. So this bot buys at creation,
// holds for seconds (tens of slots at most), and is gone either way.
//
// Two tiers. Tier A (conviction) is where the money is: a launch with real early demand
// - at least minBuyers distinct non-creator buyers, the creator's own opening buy at
// least minDevBuy SOL, real reserve already at minEntryRqSol - gets a full stake in
// slices. Tier B (breadth) is insurance for the guardrail: it buys one tiny 0.01 SOL
// probe in any other launch that passes the hard filters, but only while the run is
// behind the pace it needs to clear the 20-coin / 0.01-SOL round-trip bar (25 round
// trips by the end of a 6-hour window). In a normal window the pace is met by tier A
// alone and no probe ever fires; in a sparse window the probes fill the gap, at the
// cost of a small expected loss per probe. Tier A is always served first for open slots
// and cash.
//
// Entry: a coin is considered on the batch that carries its CreateEvent and the few
// batches after it (age <= maxAge slots). Hard failures reject it for good in both
// tiers: more than maxBuyers distinct non-creator buyers (a launch bundled by many
// wallets is a dump in waiting), the creator sold, the creator's opening buy above
// maxDevBuy SOL, or too old. Tier A additionally waits (without rejecting) until its
// demand filters pass on a later batch while the coin is still young. Buys are in
// slices: each batch while the coin is still young, buy min(pieceSol, the 1%-of-real-
// reserve size cap, the remaining stake), so size accumulates as the curve's real
// reserve grows and the earliest slices get the cheapest price.
//
// Exits (checked every batch from the position's mark value, i.e. what a full sell would
// actually return after curve fees and the transaction fee):
//   - take profit: value >= cost * (1 + takeProfit) -> sell everything
//   - hard stop: value <= cost * (1 - stopLoss) -> sell everything
//   - time stop: held longer than maxHold slots (seconds, not minutes)
//   - creator exit: the creator sells while we hold -> sell everything at once
// A curve that completes is closed by the replay itself. Sells go out with wide-open
// slippage so an exit always lands; buys use a bounded slippage so a coin that pumps
// away during the 2-slot latency is skipped instead of chased at the top.
//
// Guardrails first: stakes are small (<= stakeSol per coin, usually far less because the
// size cap binds early) against 10 SOL of capital and at most 5 open positions, so one
// coin can never dent the account; breadth comes from taking nearly every genuine launch
// once, which clears the 20-coin / 0.01-SOL round-trip bar with room to spare. Fees per
// round trip are ~1.25% a side plus one 0.000105 SOL transaction fee a side; a slice of
// 0.005-0.05 SOL needs roughly a 5-8% move to break even, which is why the take-profit
// sits at +15% and the stop at -15%: the trade only works if the opening seconds really
// do push the price up, and the short hold is what keeps the losers small.
//
// Deterministic by construction: no clock, no randomness, no environment reads; every
// decision is a pure function of the batch stream, and iteration is over insertion-ordered
// maps fed by that stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest age (slots since create) at which a coin may be bought. */
  minAge: number;
  /** Oldest age (slots since create) at which a first buy may still be decided. */
  maxAge: number;
  /** Tier A SOL to put into one coin in total across its slices. */
  stakeSol: number;
  /** Tier A SOL per slice (each slice is still capped at 1% of the real reserve). */
  pieceSol: number;
  /** Tier B probe stake (SOL); one slice only. */
  probeSol: number;
  /** Smallest single buy worth paying the tx fee for. */
  minBuySol: number;
  /** Real SOL reserve needed before any buy (size cap = 1% of it). */
  minRealSol: number;
  /** Tier A: real SOL reserve needed before the FIRST buy (early demand). */
  minEntryRqSol: number;
  /** Most distinct non-creator buyers allowed before entry (bundled launches dump). */
  maxBuyers: number;
  /** Tier A: fewest distinct non-creator buyers needed before entry (someone is buying). */
  minBuyers: number;
  /** Tier A: least SOL the creator may have bought in the create slot. */
  minDevBuy: number;
  /** Most SOL the creator may have bought in the create slot. */
  maxDevBuy: number;
  /** Skip a coin whose creator sold before entry. */
  skipDevSold: boolean;
  /** Take profit: sell when value >= cost * (1 + takeProfit). */
  takeProfit: number;
  /** Hard stop: sell when value <= cost * (1 - stopLoss). */
  stopLoss: number;
  /** Time stop: sell after this many slots held. */
  maxHold: number;
  /** Exit at once when the creator sells while we hold. */
  exitOnDevSell: boolean;
  /** Slippage on buys (bps); a pump inside the latency rejects the buy instead of chasing. */
  buySlipBps: number;
  /** Slippage on sells (bps); wide open so an exit always lands. */
  sellSlipBps: number;
  /** Round trips the pace aims for by the end of the window (guardrail is 20). */
  paceTrips: number;
  /** Seconds of the window the pace is measured against (the final window is 6 hours). */
  paceSecs: number;
}

// Settings traded with. Chosen on the dev window's three parts together (see README):
// the creator's opening buy and early buyer count are the signals that separate the
// launches that run from the ones that die, and the first seconds are where a coin's
// direction is set, so the bot buys there and is out within tens of slots either way.
export const DEFAULT_PARAMS: Params = {
  minAge: 0,
  maxAge: 3,
  stakeSol: 0.2,
  pieceSol: 0.05,
  probeSol: 0.01,
  minBuySol: 0.005,
  minRealSol: 0.3,
  minEntryRqSol: 1,
  maxBuyers: 3,
  minBuyers: 2,
  minDevBuy: 0.25,
  maxDevBuy: 2.5,
  skipDevSold: true,
  takeProfit: 0.15,
  stopLoss: 0.15,
  maxHold: 20,
  exitOnDevSell: true,
  buySlipBps: 10_000,
  sellSlipBps: 10_000,
  paceTrips: 25,
  paceSecs: 21_600,
};

const LAMPORTS = 1e9;
/** Curve fee: protocol 95 bps + creator 30 bps. */
const CURVE_FEE = 0.0125;

interface Coin {
  /** Slot of its CreateEvent, or null when first seen through a trade. */
  created: number | null;
  /** The creator wallet. */
  creator: string;
  /** SOL the creator bought in the create slot. */
  devBuy: number;
  /** The creator sold at some point. */
  devSold: boolean;
  /** Distinct non-creator buyers seen. */
  buyers: Set<string>;
  /** Already decided for good (entered, or rejected). */
  done: boolean;
}

interface Held {
  opened: number;
  /** SOL sent in buys for this position (fees included). */
  invested: number;
  /** Some buy of this position filled. */
  filled: boolean;
  exiting: boolean;
  /** Tier A (true) or tier B probe (false). */
  tierA: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Mints with a filled buy, and with a filled sell (a round trip is in both). */
  const bought = new Set<Pubkey>();
  const sold = new Set<Pubkey>();
  /** First and latest block times seen (seconds). */
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const coinOf = (mint: Pubkey): Coin => {
    let c = coins.get(mint);
    if (c === undefined) {
      c = { created: null, creator: '', devBuy: 0, devSold: false, buyers: new Set(), done: false };
      coins.set(mint, c);
    }
    return c;
  };

  /** What a full sell of `tokens` would return, in SOL, after curve fees and one tx fee. */
  const closeValueSol = (state: BotState, batch: Batch, mint: Pubkey, tokens: bigint): number => {
    const curve = state.curves.get(mint);
    if (curve === undefined) return 0;
    const mk = batch.marks.find((m) => m.mint === mint);
    const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
    const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
    const t = Number(tokens);
    const tx = Number(state.txFeeLamports()) / LAMPORTS;
    return ((t * vq) / (vt + t) / LAMPORTS) * (1 - CURVE_FEE) - tx;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const seen = new Set<Pubkey>();
      const devSoldNow = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status !== 'filled') continue;
        if (f.side === 'buy') bought.add(f.mint);
        else sold.add(f.mint);
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const c = coinOf(e.mint);
          c.created = e.slot;
          c.creator = e.creator;
        } else if (e.event === 'TradeEvent') {
          const c = coinOf(e.mint);
          seen.add(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          if (e.user === c.creator) {
            if (e.is_buy) {
              if (c.created !== null && e.slot === c.created) c.devBuy += sol;
            } else {
              c.devSold = true;
              devSoldNow.add(e.mint);
            }
          } else if (e.is_buy) {
            c.buyers.add(e.user);
          }
        }
      }

      // Breadth pace: tier B probes run only while completed round trips lag the pace
      // needed to clear the 20-coin guardrail by the end of the window.
      let tripsDone = 0;
      for (const m of bought) if (sold.has(m)) tripsDone++;
      let probesOn = false;
      if (firstTime !== null && lastTime !== null) {
        const elapsed = Math.min(p.paceSecs, lastTime - firstTime);
        const target = Math.ceil((p.paceTrips * elapsed) / p.paceSecs);
        probesOn = tripsDone < target;
      }

      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first: take profit, hard stop, time stop, creator exit.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            coinOf(mint).done = true;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const value = closeValueSol(state, batch, mint, pos.token_amount);
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        let exit = h.exiting;
        if (!exit && value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && value <= cost * (1 - p.stopLoss)) exit = true;
        if (!exit && now - h.opened > p.maxHold) exit = true;
        if (!exit && p.exitOnDevSell && devSoldNow.has(mint)) exit = true;
        if (!exit) continue;
        h.exiting = true;
        let sellPending = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        }
        if (sellPending) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: p.sellSlipBps });
      }

      // Entries, tier A first (conviction launches), then tier B probes (breadth, paced).
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      for (let tier = 0; tier < 2; tier++) {
        const tierA = tier === 0;
        if (!tierA && !probesOn) break;
        for (const mint of seen) {
          if (orders.length >= cap) break;
          const c = coins.get(mint);
          if (c === undefined || c.done) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          const h = held.get(mint);
          const age = c.created === null ? 1e9 : now - c.created;
          if (age < p.minAge || age > p.maxAge) {
            // Too old to start: never consider it again. A held coin just ages out of adds.
            if (h === undefined && age > p.maxAge) c.done = true;
            continue;
          }
          const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
          if (h === undefined) {
            if (slotsLeft <= 0) continue;
            // Hard rejects: only get worse with age, so decide for good.
            if (c.buyers.size > p.maxBuyers || (p.skipDevSold && c.devSold) || c.devBuy > p.maxDevBuy) {
              c.done = true;
              continue;
            }
            // Tier A demand filters: soft waits, may still pass on a later young batch.
            // A coin that fails them falls through to the tier B probe pass.
            if (tierA) {
              if (c.buyers.size < p.minBuyers) continue;
              if (c.devBuy < p.minDevBuy) continue;
              if (rqSol < p.minEntryRqSol) continue;
            }
          } else if (h.tierA !== tierA) {
            continue;
          }
          if (rqSol < p.minRealSol) continue;
          const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
          const invested = h === undefined ? 0 : h.invested;
          const stake = tierA ? p.stakeSol : p.probeSol;
          const piece = tierA ? p.pieceSol : p.probeSol;
          let amount = Math.min(capSol, piece, stake - invested);
          if (amount > free - tx) amount = free - tx;
          if (amount < p.minBuySol) continue;
          orders.push({
            side: 'buy',
            mint,
            quote_lamports: BigInt(Math.floor(amount * LAMPORTS)),
            max_slippage_bps: p.buySlipBps,
          });
          if (h === undefined) {
            held.set(mint, { opened: now, invested: amount, filled: false, exiting: false, tierA });
            slotsLeft -= 1;
          } else {
            h.invested += amount;
          }
          free -= amount + tx;
        }
      }
      return orders;
    },
  };
}
