/*
 * core/api.js — shared fetch wrapper (LeafTutor frontend).
 *
 * One place for JSON request plumbing: a request timeout (AbortController),
 * JSON parsing, and consistent error handling. A non-2xx response throws an
 * Error carrying `.status` and `.data` so callers can `try/catch` uniformly.
 * A 2xx response with an `{error: ...}` body is returned as-is (callers that
 * already branch on `data.error` keep working unchanged).
 *
 * Exposed as window.LT.api so classic page scripts can use it:
 *     const data = await LT.api.getJson('/api/student/threads?...');
 *     const res  = await LT.api.postJson('/ask', { question });
 */
(function (global) {
  "use strict";

  var DEFAULT_TIMEOUT_MS = 60000;

  async function apiFetch(url, opts) {
    opts = opts || {};
    var timeout = opts.timeout != null ? opts.timeout : DEFAULT_TIMEOUT_MS;
    var rest = {};
    for (var k in opts) { if (k !== "timeout") rest[k] = opts[k]; }

    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, timeout);
    // Honor a caller-supplied signal in addition to the timeout.
    if (rest.signal && rest.signal.addEventListener) {
      rest.signal.addEventListener("abort", function () { controller.abort(); });
    }
    rest.signal = controller.signal;
    try {
      return await fetch(url, rest);
    } finally {
      clearTimeout(timer);
    }
  }

  async function apiJson(url, opts) {
    var r = await apiFetch(url, opts);
    var data = null;
    try { data = await r.json(); } catch (e) { /* non-JSON / empty body */ }
    if (!r.ok) {
      var err = new Error((data && data.error) || ("Request failed: " + r.status));
      err.status = r.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function _bodyOpts(method, body, opts) {
    var o = {};
    for (var k in (opts || {})) o[k] = opts[k];
    o.method = method;
    o.headers = Object.assign({ "Content-Type": "application/json" }, o.headers || {});
    o.body = JSON.stringify(body);
    return o;
  }

  function getJson(url, opts)        { return apiJson(url, Object.assign({ method: "GET" }, opts || {})); }
  function postJson(url, body, opts) { return apiJson(url, _bodyOpts("POST", body, opts)); }
  function patchJson(url, body, opts){ return apiJson(url, _bodyOpts("PATCH", body, opts)); }

  global.LT = global.LT || {};
  global.LT.api = { fetch: apiFetch, json: apiJson, getJson: getJson, postJson: postJson, patchJson: patchJson };
})(window);
