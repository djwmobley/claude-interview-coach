// Used by resume-runner.test.js and review-runner.test.js (event-loop keep-alive regression tests): a real
// child process (never the fake EventEmitter double the rest of those suites use) that sleeps briefly, then
// prints a `--output-format json`-shaped stdout payload and exits 0. Exercises actual Node child-process /
// timer ref-counting semantics -- a synthetic EventEmitter stand-in cannot reproduce an event-loop drain,
// since nothing about it participates in the real event loop's reference counting.
setTimeout(() => {
  process.stdout.write(JSON.stringify({
    result: 'fixture done', total_cost_usd: 0, num_turns: 1, is_error: false, session_id: 'fixture',
  }));
  process.exit(0);
}, 3000);
