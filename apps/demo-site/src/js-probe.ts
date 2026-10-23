/**
 * The inline script of /js-heavy.
 *
 * It uses five Web APIs that some engines lack (Lightpanda in particular). It never checks
 * whether an API exists: it just calls it. On an engine without the API the call throws a real
 * ReferenceError or TypeError, which is what the collector should see as a page error.
 *
 * Each probe runs inside try/catch only so that one missing API does not hide the others. The
 * original error is recorded in #js-result and then thrown again, uncaught, so the engine
 * reports it like any other page error.
 *
 * Plain ES5-style syntax on purpose (var, function), apart from async/await for the sequencing.
 */
export const JS_PROBE_SCRIPT = `
(async function () {
  var PROBE_TIMEOUT_MS = 3000;
  var results = {};
  var failures = [];

  function probe(name, run) {
    return new Promise(function (resolve) {
      var timer = setTimeout(function () {
        results[name] = { ok: false, error: "timeout after " + PROBE_TIMEOUT_MS + "ms" };
        resolve();
      }, PROBE_TIMEOUT_MS);
      Promise.resolve()
        .then(run)
        .then(
          function (detail) {
            clearTimeout(timer);
            results[name] = { ok: true, detail: detail };
          },
          function (error) {
            clearTimeout(timer);
            results[name] = { ok: false, error: error.name + ": " + error.message };
            failures.push(error);
          }
        )
        .then(resolve);
    });
  }

  await probe("intersectionObserver", function () {
    return new Promise(function (resolve) {
      var observer = new IntersectionObserver(function (entries) {
        observer.disconnect();
        resolve(entries.length + " entry, isIntersecting=" + entries[0].isIntersecting);
      });
      observer.observe(document.getElementById("probe-target"));
    });
  });

  await probe("resizeObserver", function () {
    return new Promise(function (resolve) {
      var observer = new ResizeObserver(function (entries) {
        observer.disconnect();
        resolve(entries.length + " entry, width=" + Math.round(entries[0].contentRect.width));
      });
      observer.observe(document.getElementById("probe-target"));
    });
  });

  await probe("cryptoSubtleDigest", async function () {
    var bytes = new TextEncoder().encode("fleetscope");
    var digest = await crypto.subtle.digest("SHA-256", bytes);
    var hex = Array.prototype.map.call(new Uint8Array(digest), function (b) {
      return b.toString(16).padStart(2, "0");
    }).join("");
    return "sha256=" + hex.slice(0, 16);
  });

  await probe("webWorker", function () {
    return new Promise(function (resolve, reject) {
      var source = "self.onmessage = function (e) { self.postMessage(e.data * 2); };";
      var url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
      var worker = new Worker(url);
      worker.onmessage = function (e) {
        worker.terminate();
        URL.revokeObjectURL(url);
        resolve("worker answered " + e.data);
      };
      worker.onerror = function (e) {
        worker.terminate();
        reject(new Error(e.message || "worker error"));
      };
      worker.postMessage(21);
    });
  });

  await probe("requestIdleCallback", function () {
    return new Promise(function (resolve) {
      requestIdleCallback(function (deadline) {
        resolve("didTimeout=" + deadline.didTimeout);
      }, { timeout: 1000 });
    });
  });

  var result = document.querySelector("[data-testid=js-result]");
  var failed = 0;
  Object.keys(results).forEach(function (name) {
    var row = document.querySelector("[data-probe=" + name + "]");
    var r = results[name];
    if (!r.ok) failed += 1;
    if (row) row.textContent = name + ": " + (r.ok ? "ok (" + r.detail + ")" : "FAILED " + r.error);
  });
  result.textContent = JSON.stringify(results);
  result.setAttribute("data-failed", String(failed));
  result.setAttribute("data-status", "done");

  failures.forEach(function (error) {
    setTimeout(function () { throw error; }, 0);
  });
})();
`;
