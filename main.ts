// pumpfun-paper-sprint-01: a pump.fun hot-launch sniper for the make.fun replay
// (agent-fun/replay/v2). It buys only launches that are hot in their first 3 slots
// (at least 8 trades from at least 5 distinct buyers, creator not yet sold), takes
// profit fast (+10%), cuts losers (-12%), never holds past 30 slots, and leaves at
// once when the creator sells. Run by the grader as `node /bot/main.ts`; the
// strategy lives in strategy.ts, the protocol in the vendored SDK shim
// (vendor/makefun-bot.ts, a byte-identical copy of the kit's sdk/ts file).

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

const strategy = createStrategy(DEFAULT_PARAMS);

await runBot({
  onBatch: (state, batch) => strategy.onBatch(state, batch),
});
