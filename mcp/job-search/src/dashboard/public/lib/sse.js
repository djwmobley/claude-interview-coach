// @ts-check
/**
 * SSE client with a 5 s polling fallback (pr3-spec-decisions.md section 5). A "failure" is either the
 * `error` event firing while `readyState === CLOSED`, or 40 s of total silence (no event of any kind,
 * including `ping`) while nominally open. Two such failures in a rolling session stop retrying SSE and
 * switch to 5 s polling; a later successful reconnect (an `open` followed by any message) clears the
 * banner and cancels the polling timer.
 *
 * Section 5 rule 4: a 503 STREAM_CAPACITY response to `GET /api/stream` itself counts as an immediate
 * failure and skips straight to the polling fallback, without waiting for a second attempt. `EventSource`
 * gives script no access to the HTTP status of a failed connection, so a literal "was it a 503"
 * check is not implementable; what IS observable is whether the connection ever reached `open` (or
 * received any message) before this error. A rejection on the very first attempt, before ever
 * connecting even once, covers the 503-capacity case (a 503 response never fires `open`) along with
 * every other immediate-rejection shape (connection refused, DNS failure), and matches the decision's
 * own reasoning: "one [immediate failure] already proves SSE is unavailable right now" -- no reason to
 * spend a whole extra retry-and-wait cycle when the very first attempt already failed outright.
 */

const SILENCE_TIMEOUT_MS = 40000;
const POLL_INTERVAL_MS = 5000;
const FAILURE_THRESHOLD = 2;

/**
 * @param {{ url: string, onRun: (data:any)=>void, onChanged: (data:{kind:string})=>void, onPollTick: () => void, onDegraded: (degraded: boolean) => void, EventSourceImpl?: typeof EventSource }} opts
 */
export function createSseClient(opts) {
  // Injectable for tests (node:test has no global EventSource); the browser always uses the real one.
  const EventSourceImpl = opts.EventSourceImpl ?? /** @type {typeof EventSource} */ (globalThis.EventSource);
  let source = null;
  let silenceTimer = null;
  let pollTimer = null;
  let failureCount = 0;
  let degraded = false;
  let stopped = false;
  // True once this connection attempt has ever reached `open` or received any message. A 503 (or any
  // other immediate rejection) never fires `open`, so this stays false and the very first failure
  // skips straight to polling (rule 4); a later drop of a connection that DID successfully open still
  // gets the normal two-failure grace period.
  let everConnected = false;

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
    if (!everConnected) {
      // Rule 4: an immediate rejection before this connection ever opened once (a 503 STREAM_CAPACITY
      // response, a refused connection, etc.) already proves SSE is unavailable right now -- go straight
      // to polling without waiting for a second attempt.
      startPolling();
      return;
    }
    if (failureCount >= FAILURE_THRESHOLD) {
      startPolling();
      return;
    }
    // First failure of a connection that HAD been open: retry SSE once more (EventSource's own retry:
    // line already governs backoff timing for a plain drop; this schedules a fresh connection attempt
    // after a short delay for the CLOSED case).
    setTimeout(connect, 1000);
  }

  function connect() {
    if (stopped) return;
    try {
      source = new EventSourceImpl(opts.url);
    } catch {
      handleFailure();
      return;
    }
    armSilenceTimer();
    source.addEventListener('open', () => {
      everConnected = true;
      armSilenceTimer();
    });
    source.addEventListener('error', () => {
      if (source && source.readyState === EventSourceImpl.CLOSED) {
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
    // needs two fresh failures before falling back again. Defensive: `open` normally fires before any
    // message, but a message is itself conclusive proof the connection is (or was) live.
    everConnected = true;
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
