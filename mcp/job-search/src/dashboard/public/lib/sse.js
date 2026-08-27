// @ts-check
/**
 * SSE client with a 5 s polling fallback (pr3-spec-decisions.md section 5). A "failure" is either the
 * `error` event firing while `readyState === CLOSED`, or 40 s of total silence (no event of any kind,
 * including `ping`) while nominally open. Two such failures in a rolling session stop retrying SSE and
 * switch to 5 s polling; a later successful reconnect (an `open` followed by any message) clears the
 * banner and cancels the polling timer.
 */

const SILENCE_TIMEOUT_MS = 40000;
const POLL_INTERVAL_MS = 5000;
const FAILURE_THRESHOLD = 2;

/**
 * @param {{ url: string, onRun: (data:any)=>void, onChanged: (data:{kind:string})=>void, onPollTick: () => void, onDegraded: (degraded: boolean) => void }} opts
 */
export function createSseClient(opts) {
  let source = null;
  let silenceTimer = null;
  let pollTimer = null;
  let failureCount = 0;
  let degraded = false;
  let stopped = false;

  function clearSilenceTimer() {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = null;
  }

  function armSilenceTimer() {
    clearSilenceTimer();
    silenceTimer = setTimeout(() => {
      handleFailure();
    }, SILENCE_TIMEOUT_MS);
  }

  function startPolling() {
    if (pollTimer) return;
    degraded = true;
    opts.onDegraded(true);
    opts.onPollTick();
    pollTimer = setInterval(() => opts.onPollTick(), POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    if (degraded) {
      degraded = false;
      opts.onDegraded(false);
    }
  }

  function handleFailure() {
    if (stopped) return;
    failureCount += 1;
    clearSilenceTimer();
    if (source) {
      try {
        source.close();
      } catch {
        /* already closed */
      }
    }
    source = null;
    if (failureCount >= FAILURE_THRESHOLD) {
      startPolling();
      return;
    }
    // First failure: retry SSE once more (EventSource's own retry: line already governs backoff timing
    // for a plain drop; this schedules a fresh connection attempt after a short delay for the CLOSED case).
    setTimeout(connect, 1000);
  }

  function connect() {
    if (stopped) return;
    try {
      source = new EventSource(opts.url);
    } catch {
      handleFailure();
      return;
    }
    armSilenceTimer();
    source.addEventListener('open', () => {
      armSilenceTimer();
    });
    source.addEventListener('error', () => {
      if (source && source.readyState === EventSource.CLOSED) {
        handleFailure();
      }
      // CONNECTING (native retry in flight) is not itself a failure; the silence timer is the backstop.
    });
    source.addEventListener('ping', () => {
      armSilenceTimer();
      onAnyMessage();
    });
    source.addEventListener('run', (ev) => {
      armSilenceTimer();
      onAnyMessage();
      try {
        opts.onRun(JSON.parse(/** @type {MessageEvent} */ (ev).data));
      } catch {
        /* malformed payload: ignore this event, keep the connection */
      }
    });
    source.addEventListener('changed', (ev) => {
      armSilenceTimer();
      onAnyMessage();
      try {
        opts.onChanged(JSON.parse(/** @type {MessageEvent} */ (ev).data));
      } catch {
        /* malformed payload: ignore this event, keep the connection */
      }
    });
  }

  function onAnyMessage() {
    // A successful reconnect (any message received after being degraded) clears the banner and cancels
    // the polling fallback, returning to SSE-driven updates. failureCount resets so a later drop still
    // needs two fresh failures before falling back again.
    failureCount = 0;
    if (degraded) stopPolling();
  }

  connect();

  return {
    stop() {
      stopped = true;
      clearSilenceTimer();
      stopPolling();
      if (source) {
        try {
          source.close();
        } catch {
          /* already closed */
        }
      }
      source = null;
    },
    isDegraded: () => degraded,
  };
}
