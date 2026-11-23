/*!
 * HTML Modularizer Pro - runtime loader
 *
 * Strict sequence:
 *   1. install lifecycle shim (captures DOMContentLoaded / load listeners + window.onload)
 *   2. fetch every body partial (in order) and mount them into <body>
 *   3. execute every script one-by-one (external + local), awaiting each one
 *   4. dispatch the captured DOMContentLoaded and load callbacks
 *   5. on file:// / fetch failure show a helpful banner
 */
(function () {
  'use strict';

  var selfEl = document.currentScript || document.querySelector('script[data-modularizer-loader]');
  var ROOT = '';
  try {
    ROOT = new URL('../', selfEl.src).href;
  } catch (e) {
    ROOT = new URL('./', document.baseURI).href;
  }

  var ET = EventTarget.prototype;
  var nativeAdd = ET.addEventListener;
  var nativeRemove = ET.removeEventListener;

  /* ------------------------------------------------------------ 1. lifecycle shim */
  var cap = { on: true, q: [], onload: null };
  var onloadDesc = null;
  var shimInstalled = false;

  function captureFlag(o) {
    return typeof o === 'boolean' ? o : !!(o && o.capture);
  }

  function patchTarget(target, types) {
    target.addEventListener = function (type, fn, opts) {
      if (cap.on && fn && types.indexOf(type) !== -1) {
        var cf = captureFlag(opts);
        for (var i = 0; i < cap.q.length; i++) {
          var e = cap.q[i];
          if (e.t === target && e.type === type && e.fn === fn && captureFlag(e.opts) === cf) return;
        }
        cap.q.push({ t: target, type: type, fn: fn, opts: opts });
        return;
      }
      return nativeAdd.apply(this, arguments);
    };
    target.removeEventListener = function (type, fn, opts) {
      if (types.indexOf(type) !== -1) {
        var cf = captureFlag(opts);
        cap.q = cap.q.filter(function (e) {
          return !(e.t === target && e.type === type && e.fn === fn && captureFlag(e.opts) === cf);
        });
      }
      return nativeRemove.apply(this, arguments);
    };
  }

  function installShim() {
    try {
      patchTarget(document, ['DOMContentLoaded']);
      patchTarget(window, ['DOMContentLoaded', 'load']);
      // <body onload="..."> compiles to window.onload - take it over so it fires AFTER our scripts
      cap.onload = window.onload;
      window.onload = null;
      onloadDesc = Object.getOwnPropertyDescriptor(window, 'onload') || null;
      Object.defineProperty(window, 'onload', {
        configurable: true,
        enumerable: true,
        get: function () { return cap.onload; },
        set: function (v) { cap.onload = typeof v === 'function' ? v : null; },
      });
      shimInstalled = true;
    } catch (e) {
      /* shim is best-effort */
    }
  }

  function removeShim() {
    cap.on = false;
    try {
      delete document.addEventListener;
      delete document.removeEventListener;
      delete window.addEventListener;
      delete window.removeEventListener;
      if (shimInstalled) {
        if (onloadDesc) Object.defineProperty(window, 'onload', onloadDesc);
        else delete window.onload;
      }
    } catch (e) { /* ignore */ }
  }

  function fire(type, target, make) {
    var batch = cap.q.filter(function (e) { return e.type === type; });
    cap.q = cap.q.filter(function (e) { return e.type !== type; });
    batch.forEach(function (e) { nativeAdd.call(e.t, e.type, e.fn, e.opts); });
    var ev = make();
    try { target.dispatchEvent(ev); } catch (err) { console.error(err); }
    batch.forEach(function (e) { nativeRemove.call(e.t, e.type, e.fn, e.opts); });
  }

  function dispatchLifecycle() {
    var winOnload = cap.onload;
    // real listeners, real Event objects (target/currentTarget/once/handleEvent all behave natively)
    fire('DOMContentLoaded', document, function () {
      return new Event('DOMContentLoaded', { bubbles: true, cancelable: false });
    });
    // window.onload handler + captured load listeners
    var restored = false;
    try {
      removeShimPartial();
      restored = true;
    } catch (e) { /* ignore */ }
    if (restored && typeof winOnload === 'function') window.onload = winOnload;
    var loadBatch = cap.q.filter(function (e) { return e.type === 'load'; });
    cap.q = cap.q.filter(function (e) { return e.type !== 'load'; });
    loadBatch.forEach(function (e) { nativeAdd.call(e.t, e.type, e.fn, e.opts); });
    try { window.dispatchEvent(new Event('load')); } catch (err) { console.error(err); }
    loadBatch.forEach(function (e) { nativeRemove.call(e.t, e.type, e.fn, e.opts); });
    if (window.onload === winOnload) window.onload = null;
    removeShim();
  }

  // restore only the window.onload accessor so assigning the handler is native
  function removeShimPartial() {
    if (!shimInstalled) return;
    if (onloadDesc) Object.defineProperty(window, 'onload', onloadDesc);
    else delete window.onload;
  }

  /* ------------------------------------------------------------ helpers */
  function fetchText(path) {
    return fetch(ROOT + path).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' while loading ' + path);
      return r.text();
    });
  }

  function showBanner(err) {
    var isFile = location.protocol === 'file:';
    var box = document.createElement('div');
    box.setAttribute('role', 'alert');
    box.style.cssText =
      'position:fixed;left:0;right:0;top:0;z-index:2147483647;box-sizing:border-box;padding:16px 18px;' +
      'background:#7c2d12;color:#fff;font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;' +
      'box-shadow:0 8px 30px rgba(0,0,0,.45);max-height:100vh;overflow:auto';
    var h = isFile
      ? '<strong style="font-size:16px">This page must be served from a local web server.</strong>' +
        '<p style="margin:6px 0">You opened <code>index.html</code> via <code>file://</code>. Browsers block <code>fetch()</code> of local files, so the modular partials cannot be loaded.</p>'
      : '<strong style="font-size:16px">A project file failed to load.</strong>' +
        '<p style="margin:6px 0">' + String(err && err.message ? err.message : err).replace(/</g, '&lt;') + '</p>';
    var pre = 'style="background:rgba(0,0,0,.3);padding:3px 8px;border-radius:6px;display:inline-block;margin:2px 0;font:13px ui-monospace,Menlo,Consolas,monospace;user-select:all"';
    h +=
      '<p style="margin:6px 0 2px">Open a terminal <em>inside this folder</em> and run any one of:</p>' +
      '<div><code ' + pre + '>python3 -m http.server 8000</code></div>' +
      '<div><code ' + pre + '>npx serve .</code></div>' +
      '<div><code ' + pre + '>php -S localhost:8000</code></div>' +
      '<p style="margin:6px 0 0">Then visit <code>http://localhost:8000</code>. Or use the VS Code "Live Server" extension. ' +
      'On a phone, open <code>http://&lt;your-computer-LAN-IP&gt;:8000</code> on the same Wi-Fi.</p>';
    box.innerHTML = h;
    var close = document.createElement('button');
    close.textContent = 'Dismiss';
    close.style.cssText = 'margin-top:8px;padding:6px 12px;border:0;border-radius:6px;background:#fff;color:#7c2d12;font-weight:600;cursor:pointer';
    close.onclick = function () { box.remove(); };
    box.appendChild(close);
    (document.body || document.documentElement).appendChild(box);
  }

  function runScript(s, text) {
    return new Promise(function (resolve) {
      var attrs = s.attrs || [];
      var noModuleAttr = attrs.some(function (a) { return a[0].toLowerCase() === 'nomodule'; });
      if (noModuleAttr && 'noModule' in HTMLScriptElement.prototype) return resolve(); // modern browsers skip these
      var el = document.createElement('script');
      attrs.forEach(function (a) {
        if (a[0].toLowerCase() === 'src') return;
        try { el.setAttribute(a[0], a[1]); } catch (e) { /* ignore invalid attribute */ }
      });
      var parent = s.origin === 'head' ? document.head : document.body;
      if (typeof text === 'string') {
        // atomic mode: code was prefetched and runs synchronously (no network gap between chunks)
        el.text = text;
        parent.appendChild(el);
        return resolve();
      }
      el.onload = function () { resolve(); };
      el.onerror = function () {
        console.error('[modularizer] failed to load script: ' + s.src);
        resolve();
      };
      el.src = s.local ? ROOT + s.src : s.src; // set last: integrity/crossorigin/type are already in place
      parent.appendChild(el);
    });
  }

  /* ------------------------------------------------------------ main */
  async function main() {
    var manifest;
    var inline = document.getElementById('modularizer-manifest');
    if (inline) manifest = JSON.parse(inline.textContent);
    else manifest = JSON.parse(await fetchText('manifest.json'));

    installShim();

    // 2. partials, sequentially, exact order
    var html = '';
    for (var i = 0; i < manifest.partials.length; i++) {
      html += await fetchText(manifest.partials[i].path);
    }
    // one fragment parse == identical parser state to the original single document
    document.body.insertAdjacentHTML('beforeend', html);

    // 3. scripts, strictly sequential
    var atomic = !!(manifest.settings && manifest.settings.atomic);
    var prefetch = {};
    if (atomic) {
      manifest.scripts.forEach(function (s) {
        var isModule = (s.attrs || []).some(function (a) { return a[0].toLowerCase() === 'type' && String(a[1]).toLowerCase() === 'module'; });
        if (s.local && !isModule) prefetch[s.src] = fetchText(s.src);
      });
    }
    for (var k = 0; k < manifest.scripts.length; k++) {
      var s = manifest.scripts[k];
      var text;
      if (atomic && prefetch[s.src]) text = await prefetch[s.src];
      await runScript(s, text);
    }

    // 4. lifecycle
    dispatchLifecycle();
  }

  main().catch(function (err) {
    console.error('[modularizer]', err);
    removeShim();
    showBanner(err);
  });
})();
