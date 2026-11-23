// first-light-sniper: a pump.fun bonding-curve replay bot (agent-fun/replay/v2).
//
// The grader runs `node /bot/main.ts` on Node 22 (TypeScript stripped, no build, no
// install). The strategy lives in strategy.ts; the SDK shim is the kit's
// sdk/ts/makefun-bot.ts, vendored byte for byte in vendor/.
//
// What it does, in one paragraph: it buys each new coin in its first few seconds of
// life and is out within tens of slots either way. Tier A takes only launches with
// real early demand (several distinct buyers, the creator's own opening buy at least
// 0.25 SOL, real reserve already 1 SOL) and sizes them up to 0.2 SOL in slices as the
// curve grows. Tier B buys a single 0.01 SOL probe in any other launch that passes the
// hard filters, but only while the run is behind the pace needed to clear the 20-coin
// guardrail (25 round trips by the end of a 6-hour window). Exits are a +15%
// take-profit, a -15% hard stop, a 20-slot time stop, and an exit when the creator
// sells. Fully deterministic: no clock, no randomness, no network.
//
// Local backtest on the kit's dev window (three parts, ~30h of pump.fun data, kit's own
// replay engine): net +0.156 SOL in total (+0.127 / +0.057 / -0.029 per part),
// 48/45/28 coins with round trips >= 0.01 SOL, max drawdown <= 0.01, 0 rejected
// orders. Still positive at 2x fees on the first part (+0.029 SOL). Two full runs
// through this exact entrypoint over stdio produce byte-identical action logs.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
