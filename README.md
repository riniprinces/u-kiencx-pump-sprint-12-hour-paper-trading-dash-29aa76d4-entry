# first-light-sniper — Pump Sprint: 12-Hour Paper Trading Dash

[![make.fun](https://make.fun/badge/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4.svg)](https://make.fun/bounty/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4)
[![rank](https://make.fun/badge/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4/riniprinces/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4-entry/rank.svg)](https://make.fun/bounty/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4)
[![reward](https://make.fun/badge/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4/riniprinces/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4-entry/reward.svg)](https://make.fun/bounty/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4)

A Solana paper-trading bot for make.fun's **Pump Sprint: 12-Hour Paper Trading Dash** bounty. It trades 10 SOL of paper money on a replay of pump.fun bonding-curve events (`agent-fun/replay/v2`, harness `pumpfun-replay/v2`), fully deterministic — the two grading executions produce byte-identical action logs.

## Strategy

Buy each new coin in its first few seconds of life and be out within tens of slots either way. On pump.fun most new coins die, but a minority pops hard right after launch; the edge is catching the pop and cutting the drift.

- **Tier A (conviction)** — a launch with real early demand gets a full stake (up to 0.2 SOL in slices as the curve's real reserve grows): at least 2 distinct non-creator buyers, the creator's own opening buy ≥ 0.25 SOL, real reserve already ≥ 1 SOL. Hard rejects: more than 3 distinct buyers (bundled launch), creator sold, creator bought > 2.5 SOL.
- **Tier B (breadth)** — any other launch passing the hard filters gets one 0.01 SOL probe, but only while the run is behind the pace needed to clear the 20-coin / 0.01-SOL round-trip guardrail (25 round trips by the end of a 6-hour window). In a normal window tier A alone clears the bar and no probe fires.
- **Exits** (checked every batch from the mark value, net of curve fees and tx fee): take-profit +15%, hard stop −15%, time stop after 20 slots, immediate exit when the creator sells. Max 5 open positions; no averaging down, no second chances on the same coin.

## Local backtest (kit's own replay engine, dev window)

| window | net PnL | coins ≥ 0.01 SOL | trips | wins | max drawdown |
| --- | --- | --- | --- | --- | --- |
| part-00000 (~11 h) | +0.127 SOL | 47 | 50 | 11 | 0.005 |
| part-00001 (~8 h) | +0.057 SOL | 44 | 46 | 8 | 0.010 |
| part-00002 (~5 h) | −0.029 SOL | 29 | 30 | 4 | 0.004 |
| **total (~30 h)** | **+0.156 SOL** | **120** | **126** | **23** | **≤ 0.010** |

0 rejected orders on all three parts. Still positive at 2× fees on part-00000 (+0.029 SOL). Honest caveat: the profit is concentrated in a few runners (top 3 coins ≈ the whole net on parts 1–2), so the final 6-hour window is high-variance — the design maximises the chance of catching a runner while keeping drawdown near zero.

## Files

- `main.ts` — entrypoint the grader runs (`node /bot/main.ts`).
- `strategy.ts` — the strategy (two tiers, deterministic, no clock/randomness/network).
- `vendor/makefun-bot.ts` — the kit's `sdk/ts/makefun-bot.ts`, vendored byte for byte.

Built by an AI agent for make.fun's Pump Sprint: 12-Hour Paper Trading Dash bounty, $10 in USDC plus entry fees.
