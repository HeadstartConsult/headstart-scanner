/*!
 * Free Document Scanner
 * © Headstartconsult. All rights reserved.
 * Everything below runs inside the visitor's browser. No image, page or PDF
 * is ever sent to a server, so Headstart Consult CC carries no per-use cost.
 */
(function () {
  'use strict';

  var MAX_SOURCE = 3000;   // longest side of a loaded photo, in pixels
  var MAX_OUTPUT = 2200;   // longest side of a cropped page (≈ 200 dpi on A4)
  var STORE_QUALITY = 0.92;

  var $ = function (id) { return document.getElementById(id); };
  var state = {
    queue: [],          // files still waiting to be processed
    queueTotal: 0,
    queueIndex: 0,
    src: null,          // canvas with the current photo
    srcData: null,      // cached ImageData of src
    quad: null,         // [TL, TR, BR, BL] in src pixels
    detected: false,
    warped: null,       // straightened page canvas
    filter: 'auto',
    filtered: null,
    pages: [],          // {blob, url, w, h}
    unsaved: false
  };

  $('yr').textContent = new Date().getFullYear();

  /* ------------------------------------------------------------------ *
   * Status panel. Every automated step reports: what started it, what it
   * did, and what the person must do next. It always appears in the same
   * box at the top of the page.
   * ------------------------------------------------------------------ */
  function setStatus(kind, title, trigger, result, next, busy) {
    var el = $('status');
    el.className = 'status ' + kind;
    var html = '<b>' + (busy ? '<span class="spinner" aria-hidden="true"></span>' : '') + esc(title) + '</b>';
    if (trigger || result || next) {
      html += '<dl>';
      if (trigger) html += '<dt>Started by</dt><dd>' + esc(trigger) + '</dd>';
      if (result) html += '<dt>What happened</dt><dd>' + esc(result) + '</dd>';
      if (next) html += '<dt>Your next step</dt><dd>' + esc(next) + '</dd>';
      html += '</dl>';
    }
    el.innerHTML = html;
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function scrollToStatus() { $('status').scrollIntoView({ behavior: 'smooth', block: 'start' }); }

  function show(view) {
    ['add', 'crop', 'enhance'].forEach(function (v) { $('view-' + v).classList.toggle('hidden', v !== view); });
    var order = ['add', 'crop', 'enhance', 'pdf'];
    var cur = order.indexOf(view);
    Array.prototype.forEach.call($('steps').children, function (li) {
      var i = order.indexOf(li.dataset.step);
      li.classList.toggle('on', i === cur);
      li.classList.toggle('done', i < cur || (li.dataset.step === 'pdf' && false));
    });
    if (view === 'add' && state.pages.length) $('steps').children[3].classList.add('on');
  }

  function idleStatus() {
    if (state.pages.length) {
      setStatus('ok', 'Ready for the next page or your PDF', null, 'Your document has ' + plural(state.pages.length, 'page') + '.',
        'Tap "Take photo" or "Choose images" to add more, or scroll down and tap "Save PDF".');
    } else {
      setStatus('info', 'Step 1: add a page', null, null,
        'Tap "Take photo" to use your camera, or "Choose images" to pick photos you already have. You can pick several at once.');
    }
  }
  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }

  /* ------------------------------------------------------------------ *
   * Step 1: load photos
   * ------------------------------------------------------------------ */
  function onFiles(files, how) {
    files = Array.prototype.filter.call(files, function (f) { return /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic|heif|gif|bmp)$/i.test(f.name); });
    if (!files.length) return;
    state.queue = files.slice();
    state.queueTotal = files.length;
    state.queueIndex = 0;
    state.trigger = how;
    nextInQueue();
  }
  $('camInput').addEventListener('change', function (e) { onFiles(e.target.files, 'You took a photo.'); e.target.value = ''; });
  $('fileInput').addEventListener('change', function (e) { onFiles(e.target.files, e.target.files.length > 1 ? 'You chose ' + e.target.files.length + ' images.' : 'You chose an image.'); e.target.value = ''; });

  // Drag and drop on desktop
  document.addEventListener('dragover', function (e) { e.preventDefault(); });
  document.addEventListener('drop', function (e) { e.preventDefault(); if (e.dataTransfer && e.dataTransfer.files.length) onFiles(e.dataTransfer.files, 'You dropped images on the page.'); });

  function nextInQueue() {
    if (!state.queue.length) { show('add'); idleStatus(); return; }
    var file = state.queue.shift();
    state.queueIndex++;
    var of = state.queueTotal > 1 ? ' (photo ' + state.queueIndex + ' of ' + state.queueTotal + ')' : '';
    setStatus('info', 'Reading your photo' + of + '…', state.trigger, null, 'Please wait a moment.', true);
    loadImage(file).then(function (img) {
      var s = Math.min(1, MAX_SOURCE / Math.max(img.width, img.height));
      var c = document.createElement('canvas');
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      if (img.close) img.close();
      setSource(c);
      runDetect(state.trigger, of);
    }).catch(function () {
      setStatus('err', 'That file could not be opened' + of, state.trigger,
        'Your browser could not read "' + file.name + '" as an image.',
        state.queue.length ? 'We will move on to the next photo automatically.' : 'Try a JPG or PNG photo instead.');
      if (state.queue.length) setTimeout(nextInQueue, 1800); else show('add');
    });
  }

  function loadImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(); };
      img.src = url;
    });
  }

  function setSource(c) {
    state.src = c;
    state.srcData = c.getContext('2d').getImageData(0, 0, c.width, c.height);
  }

  /* ------------------------------------------------------------------ *
   * Step 2: edge detection (automatic) and manual corner adjustment
   * ------------------------------------------------------------------ */
  function runDetect(trigger, of) {
    show('crop');
    setStatus('info', 'Finding the page edges' + (of || '') + '…', trigger, null, 'Please wait a moment.', true);
    setTimeout(function () {
      var r = detectQuad(state.src);
      state.quad = r.quad; state.detected = r.found;
      drawCrop();
      if (r.found) {
        setStatus('ok', 'Page edges found' + (of || ''), trigger,
          'We placed a blue frame on the edges of the page automatically.',
          'Check that the 4 round handles sit on the corners of the page. Drag any that are wrong, then tap "Crop page".');
      } else {
        setStatus('warn', 'We could not find the page edges' + (of || ''), trigger,
          'The page and background look too similar, so we placed the frame near the edges of the photo.',
          'Drag the 4 round handles onto the corners of the page, then tap "Crop page". A darker background helps next time.');
      }
      scrollToStatus();
    }, 30);
  }

  // Lightweight on-device detector: Otsu threshold + largest bright blob + extreme corners.
  function detectQuad(src) {
    var W = src.width, H = src.height;
    var fallback = insetQuad(W, H, 0.05);
    var s = 360 / Math.max(W, H);
    var w = Math.max(8, Math.round(W * s)), h = Math.max(8, Math.round(H * s));
    var c = document.createElement('canvas'); c.width = w; c.height = h;
    var ctx = c.getContext('2d'); ctx.drawImage(src, 0, 0, w, h);
    var d = ctx.getImageData(0, 0, w, h).data;
    var g = new Float32Array(w * h), i, x, y;
    for (i = 0; i < w * h; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    g = boxBlur(boxBlur(g, w, h, 2), w, h, 2);

    // Otsu threshold
    var hist = new Array(256).fill(0);
    for (i = 0; i < g.length; i++) hist[Math.min(255, g[i] | 0)]++;
    var total = g.length, sum = 0, sumB = 0, wB = 0, best = 0, t = 128;
    for (i = 0; i < 256; i++) sum += i * hist[i];
    for (i = 0; i < 256; i++) {
      wB += hist[i]; if (!wB) continue;
      var wF = total - wB; if (!wF) break;
      sumB += i * hist[i];
      var mB = sumB / wB, mF = (sum - sumB) / wF, v = wB * wF * (mB - mF) * (mB - mF);
      if (v > best) { best = v; t = i; }
    }

    // Try bright-on-dark first, then dark-on-bright.
    var tries = [true, false], bestQ = null, bestScore = 0;
    tries.forEach(function (bright) {
      var mask = new Uint8Array(w * h);
      for (var k = 0; k < g.length; k++) mask[k] = bright ? (g[k] > t ? 1 : 0) : (g[k] < t ? 1 : 0);
      var comp = largestComponent(mask, w, h);
      if (!comp) return;
      var frac = comp.area / (w * h);
      if (frac < 0.12 || frac > 0.97) return;
      var q = comp.quad;
      var qa = polyArea(q) / (w * h);
      if (qa < 0.12 || !isConvex(q)) return;
      var fill = comp.area / polyArea(q); // a real page fills its own frame
      var score = qa * fill * fill * (comp.touches > 2 ? 0.3 : 1) * (bright ? 1 : 0.8);
      if (fill > 0.8 && score > bestScore) { bestScore = score; bestQ = q; }
    });
    if (!bestQ) return { quad: fallback, found: false };
    return { quad: bestQ.map(function (p) { return { x: clamp(p.x / s, 0, W), y: clamp(p.y / s, 0, H) }; }), found: true };
  }

  function boxBlur(src, w, h, r) {
    var tmp = new Float32Array(w * h), out = new Float32Array(w * h), x, y, k, acc, n;
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      acc = 0; n = 0;
      for (k = -r; k <= r; k++) { var xx = x + k; if (xx >= 0 && xx < w) { acc += src[y * w + xx]; n++; } }
      tmp[y * w + x] = acc / n;
    }
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      acc = 0; n = 0;
      for (k = -r; k <= r; k++) { var yy = y + k; if (yy >= 0 && yy < h) { acc += tmp[yy * w + x]; n++; } }
      out[y * w + x] = acc / n;
    }
    return out;
  }

  function largestComponent(mask, w, h) {
    var label = new Int32Array(w * h), stack = new Int32Array(w * h), best = null, id = 0;
    for (var start = 0; start < w * h; start++) {
      if (!mask[start] || label[start]) continue;
      id++;
      var sp = 0, area = 0, tl = null, tr = null, br = null, bl = null, edges = { l: 0, r: 0, t: 0, b: 0 };
      var mTL = Infinity, mBR = -Infinity, mTR = -Infinity, mBL = Infinity;
      stack[sp++] = start; label[start] = id;
      while (sp) {
        var p = stack[--sp], x = p % w, y = (p / w) | 0;
        area++;
        if (x === 0) edges.l = 1; if (x === w - 1) edges.r = 1; if (y === 0) edges.t = 1; if (y === h - 1) edges.b = 1;
        var a = x + y, b = x - y;
        if (a < mTL) { mTL = a; tl = { x: x, y: y }; }
        if (a > mBR) { mBR = a; br = { x: x, y: y }; }
        if (b > mTR) { mTR = b; tr = { x: x, y: y }; }
        if (b < mBL) { mBL = b; bl = { x: x, y: y }; }
        if (x > 0 && mask[p - 1] && !label[p - 1]) { label[p - 1] = id; stack[sp++] = p - 1; }
        if (x < w - 1 && mask[p + 1] && !label[p + 1]) { label[p + 1] = id; stack[sp++] = p + 1; }
        if (y > 0 && mask[p - w] && !label[p - w]) { label[p - w] = id; stack[sp++] = p - w; }
        if (y < h - 1 && mask[p + w] && !label[p + w]) { label[p + w] = id; stack[sp++] = p + w; }
      }
      if (!best || area > best.area) best = { area: area, quad: [tl, tr, br, bl], touches: edges.l + edges.r + edges.t + edges.b };
    }
    return best;
  }

  function insetQuad(W, H, f) {
    return [{ x: W * f, y: H * f }, { x: W * (1 - f), y: H * f }, { x: W * (1 - f), y: H * (1 - f) }, { x: W * f, y: H * (1 - f) }];
  }
  function polyArea(q) { var a = 0; for (var i = 0; i < 4; i++) { var p = q[i], n = q[(i + 1) % 4]; a += p.x * n.y - n.x * p.y; } return Math.abs(a / 2); }
  function isConvex(q) {
    var sign = 0;
    for (var i = 0; i < 4; i++) {
      var a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
      var z = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (Math.abs(z) < 1e-9) return false;
      if (!sign) sign = Math.sign(z); else if (Math.sign(z) !== sign) return false;
    }
    return true;
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function orderQuad(pts) {
    var cx = 0, cy = 0; pts.forEach(function (p) { cx += p.x / 4; cy += p.y / 4; });
    var s = pts.slice().sort(function (a, b) { return Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx); });
    var k = 0; for (var i = 1; i < 4; i++) if (s[i].x + s[i].y < s[k].x + s[k].y) k = i;
    return s.slice(k).concat(s.slice(0, k));
  }

  // Crop canvas drawing and dragging
  var cropCanvas = $('cropCanvas'), dragging = -1;
  function drawCrop() {
    var src = state.src; if (!src) return;
    var maxW = Math.min($('stage').clientWidth || 800, 820), maxH = Math.max(320, window.innerHeight * 0.62);
    var sc = Math.min(maxW / src.width, maxH / src.height);
    var cw = Math.round(src.width * sc), ch = Math.round(src.height * sc), dpr = window.devicePixelRatio || 1;
    cropCanvas.style.width = cw + 'px'; cropCanvas.style.height = ch + 'px';
    cropCanvas.width = Math.round(cw * dpr); cropCanvas.height = Math.round(ch * dpr);
    var ctx = cropCanvas.getContext('2d');
    var k = cropCanvas.width / src.width;
    ctx.drawImage(src, 0, 0, cropCanvas.width, cropCanvas.height);
    var q = state.quad.map(function (p) { return { x: p.x * k, y: p.y * k }; });
    // dim outside
    ctx.save(); ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.beginPath();
    ctx.rect(0, 0, cropCanvas.width, cropCanvas.height);
    ctx.moveTo(q[0].x, q[0].y); for (var i = 3; i >= 1; i--) ctx.lineTo(q[i].x, q[i].y); ctx.closePath();
    ctx.fill('evenodd'); ctx.restore();
    ctx.lineWidth = 3 * dpr; ctx.strokeStyle = '#2aa8ff';
    ctx.beginPath(); ctx.moveTo(q[0].x, q[0].y); for (i = 1; i < 4; i++) ctx.lineTo(q[i].x, q[i].y); ctx.closePath(); ctx.stroke();
    q.forEach(function (p, j) {
      ctx.beginPath(); ctx.arc(p.x, p.y, (dragging === j ? 16 : 12) * dpr, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(42,168,255,.35)'; ctx.fill(); ctx.lineWidth = 3 * dpr; ctx.strokeStyle = '#fff'; ctx.stroke();
    });
  }
  function toSrc(e) {
    var r = cropCanvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width * state.src.width, y: (e.clientY - r.top) / r.height * state.src.height, scale: state.src.width / r.width };
  }
  cropCanvas.addEventListener('pointerdown', function (e) {
    var p = toSrc(e), best = -1, bd = Infinity;
    state.quad.forEach(function (q, i) { var d = dist(p, q); if (d < bd) { bd = d; best = i; } });
    if (bd / p.scale < 44) { dragging = best; cropCanvas.setPointerCapture(e.pointerId); drawCrop(); e.preventDefault(); }
  });
  cropCanvas.addEventListener('pointermove', function (e) {
    if (dragging < 0) return;
    var p = toSrc(e);
    state.quad[dragging] = { x: clamp(p.x, 0, state.src.width), y: clamp(p.y, 0, state.src.height) };
    drawCrop();
  });
  function endDrag() {
    if (dragging < 0) return;
    dragging = -1; state.quad = orderQuad(state.quad); drawCrop();
    if (!isConvex(state.quad)) setStatus('warn', 'The frame is twisted', 'You moved a corner.', 'The corners cross over each other.', 'Move the handles so they form a clean four-sided frame around the page.');
  }
  cropCanvas.addEventListener('pointerup', endDrag);
  cropCanvas.addEventListener('pointercancel', endDrag);
  window.addEventListener('resize', function () { if (!$('view-crop').classList.contains('hidden')) drawCrop(); });

  $('btnAutoDetect').addEventListener('click', function () { runDetect('You tapped "Detect again".'); });
  $('btnFullImage').addEventListener('click', function () {
    state.quad = insetQuad(state.src.width, state.src.height, 0); drawCrop();
    setStatus('info', 'Frame set to the whole photo', 'You tapped "Use whole photo".', 'The frame now covers the full photo.', 'Tap "Crop page" to continue, or drag the handles.');
  });
  $('btnRotate').addEventListener('click', function () {
    var s = state.src, c = document.createElement('canvas');
    c.width = s.height; c.height = s.width;
    var ctx = c.getContext('2d'); ctx.translate(c.width, 0); ctx.rotate(Math.PI / 2); ctx.drawImage(s, 0, 0);
    var Hh = s.height;
    state.quad = orderQuad(state.quad.map(function (p) { return { x: Hh - p.y, y: p.x }; }));
    setSource(c); drawCrop();
  });
  $('btnCancelCrop').addEventListener('click', function () {
    state.src = null; state.srcData = null;
    if (state.queue.length) { setStatus('info', 'Photo skipped', 'You tapped "Cancel".', 'That photo was not added.', 'The next photo opens automatically.'); setTimeout(nextInQueue, 600); }
    else { show('add'); idleStatus(); }
  });

  /* ------------------------------------------------------------------ *
   * Step 3: perspective correction and enhancement
   * ------------------------------------------------------------------ */
  $('btnApplyCrop').addEventListener('click', function () {
    if (!isConvex(state.quad)) { setStatus('warn', 'Fix the frame first', 'You tapped "Crop page".', 'The corners cross over each other, so the page cannot be straightened.', 'Move the handles to form a clean four-sided frame, then tap "Crop page" again.'); return; }
    setStatus('info', 'Straightening and cleaning the page…', 'You tapped "Crop page".', null, 'Please wait a moment.', true);
    setTimeout(function () {
      state.warped = warp(state.srcData, state.quad);
      state.filter = 'auto';
      renderFilter();
      show('enhance');
      setStatus('ok', 'Page straightened and cleaned', 'You tapped "Crop page".',
        'We flattened the page and applied the "Auto" clean-up so text is easier to read.',
        'Try "Greyscale" or "Black & white" if you prefer, then tap "Add to document".');
      scrollToStatus();
    }, 30);
  });
  $('btnBackCrop').addEventListener('click', function () { show('crop'); drawCrop(); setStatus('info', 'Back to the page edges', 'You tapped "Back to edges".', null, 'Adjust the handles, then tap "Crop page".'); });
  $('btnDiscard').addEventListener('click', function () {
    state.warped = state.filtered = null; state.src = state.srcData = null;
    if (state.queue.length) { setStatus('info', 'Page discarded', 'You tapped "Discard".', 'That page was not added.', 'The next photo opens automatically.'); setTimeout(nextInQueue, 600); }
    else { show('add'); idleStatus(); }
  });
  Array.prototype.forEach.call($('filters').children, function (b) {
    b.addEventListener('click', function () { state.filter = b.dataset.filter; renderFilter(); });
  });

  function warp(srcData, quad) {
    var w = Math.max(dist(quad[0], quad[1]), dist(quad[3], quad[2]));
    var h = Math.max(dist(quad[0], quad[3]), dist(quad[1], quad[2]));
    var s = Math.min(1, MAX_OUTPUT / Math.max(w, h));
    var W = Math.max(1, Math.round(w * s)), H = Math.max(1, Math.round(h * s));
    var Hm = homography([{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }], quad);
    var out = new ImageData(W, H), od = out.data, sd = srcData.data, sw = srcData.width, sh = srcData.height;
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        var X = x + 0.5, Y = y + 0.5;
        var den = Hm[6] * X + Hm[7] * Y + 1;
        var u = (Hm[0] * X + Hm[1] * Y + Hm[2]) / den - 0.5;
        var v = (Hm[3] * X + Hm[4] * Y + Hm[5]) / den - 0.5;
        var x0 = Math.floor(u), y0 = Math.floor(v), fx = u - x0, fy = v - y0;
        var xa = clamp(x0, 0, sw - 1), xb = clamp(x0 + 1, 0, sw - 1), ya = clamp(y0, 0, sh - 1), yb = clamp(y0 + 1, 0, sh - 1);
        var i00 = (ya * sw + xa) * 4, i10 = (ya * sw + xb) * 4, i01 = (yb * sw + xa) * 4, i11 = (yb * sw + xb) * 4, o = (y * W + x) * 4;
        for (var c = 0; c < 3; c++) {
          var top = sd[i00 + c] + (sd[i10 + c] - sd[i00 + c]) * fx;
          var bot = sd[i01 + c] + (sd[i11 + c] - sd[i01 + c]) * fx;
          od[o + c] = top + (bot - top) * fy;
        }
        od[o + 3] = 255;
      }
    }
    var cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    cv.getContext('2d').putImageData(out, 0, 0);
    return cv;
  }

  // Solve for the 3x3 matrix that maps `from` points onto `to` points.
  function homography(from, to) {
    var A = [], b = [];
    for (var i = 0; i < 4; i++) {
      var x = from[i].x, y = from[i].y, X = to[i].x, Y = to[i].y;
      A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]); b.push(X);
      A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]); b.push(Y);
    }
    return gauss(A, b);
  }
  function gauss(A, b) {
    var n = b.length, i, j, k;
    for (i = 0; i < n; i++) A[i].push(b[i]);
    for (i = 0; i < n; i++) {
      var mx = i; for (k = i + 1; k < n; k++) if (Math.abs(A[k][i]) > Math.abs(A[mx][i])) mx = k;
      var t = A[i]; A[i] = A[mx]; A[mx] = t;
      for (k = i + 1; k < n; k++) { var f = A[k][i] / A[i][i]; for (j = i; j <= n; j++) A[k][j] -= f * A[i][j]; }
    }
    var x = new Array(n);
    for (i = n - 1; i >= 0; i--) { var s = A[i][n]; for (j = i + 1; j < n; j++) s -= A[i][j] * x[j]; x[i] = s / A[i][i]; }
    return x;
  }

  function renderFilter() {
    Array.prototype.forEach.call($('filters').children, function (b) { b.setAttribute('aria-pressed', String(b.dataset.filter === state.filter)); });
    state.filtered = applyFilter(state.warped, state.filter);
    var p = $('preview'); p.width = state.filtered.width; p.height = state.filtered.height;
    p.getContext('2d').drawImage(state.filtered, 0, 0);
    p.style.width = Math.min(p.parentNode.clientWidth || 800, window.innerHeight * 0.72 * p.width / p.height) + 'px';
  }

  function applyFilter(src, filter) {
    var W = src.width, H = src.height, c = document.createElement('canvas'); c.width = W; c.height = H;
    var ctx = c.getContext('2d'); ctx.drawImage(src, 0, 0);
    if (filter === 'color') return c;
    var img = ctx.getImageData(0, 0, W, H), d = img.data, n = W * H, i;
    var lum = new Float32Array(n);
    for (i = 0; i < n; i++) lum[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    if (filter === 'bw') {
      // Bradley adaptive threshold using an integral image: handles shadows across the page.
      var ii = new Float64Array((W + 1) * (H + 1)), x, y;
      for (y = 1; y <= H; y++) { var row = 0; for (x = 1; x <= W; x++) { row += lum[(y - 1) * W + (x - 1)]; ii[y * (W + 1) + x] = ii[(y - 1) * (W + 1) + x] + row; } }
      var r = Math.max(8, Math.round(Math.max(W, H) / 32)), T = 0.12;
      for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
        var x1 = Math.max(0, x - r), x2 = Math.min(W, x + r + 1), y1 = Math.max(0, y - r), y2 = Math.min(H, y + r + 1);
        var cnt = (x2 - x1) * (y2 - y1);
        var sum = ii[y2 * (W + 1) + x2] - ii[y1 * (W + 1) + x2] - ii[y2 * (W + 1) + x1] + ii[y1 * (W + 1) + x1];
        var v = lum[y * W + x] * cnt <= sum * (1 - T) ? 0 : 255, o = (y * W + x) * 4;
        d[o] = d[o + 1] = d[o + 2] = v;
      }
    } else {
      // Flatten uneven lighting: estimate the paper brightness around each point and divide it out.
      var bg = paperLevel(lum, W, H);
      for (i = 0; i < n; i++) {
        var f = 235 / Math.max(40, bg[i]), q4 = i * 4;
        lum[i] = Math.min(255, lum[i] * f);
        d[q4] = Math.min(255, d[q4] * f); d[q4 + 1] = Math.min(255, d[q4 + 1] * f); d[q4 + 2] = Math.min(255, d[q4 + 2] * f);
      }
      // Contrast stretch: darkest 1% to black, paper (90th percentile) to white.
      var hist = new Uint32Array(256); for (i = 0; i < n; i++) hist[lum[i] | 0]++;
      var lo = pct(hist, n, 0.01), hi = pct(hist, n, 0.90);
      if (hi - lo < 30) { lo = 0; hi = 255; }
      var k = 255 / (hi - lo);
      for (i = 0; i < n; i++) {
        var o4 = i * 4;
        if (filter === 'grey') { var gv = (lum[i] - lo) * k; d[o4] = d[o4 + 1] = d[o4 + 2] = gv; }
        else { d[o4] = (d[o4] - lo) * k; d[o4 + 1] = (d[o4 + 1] - lo) * k; d[o4 + 2] = (d[o4 + 2] - lo) * k; }
      }
      if (filter === 'auto') {
        // White balance: make the paper neutral white in each colour channel.
        for (var ch = 0; ch < 3; ch++) {
          var hc = new Uint32Array(256); for (i = 0; i < n; i++) hc[d[i * 4 + ch]]++;
          var top = Math.max(128, pct(hc, n, 0.90)), kc = 255 / top;
          for (i = 0; i < n; i++) d[i * 4 + ch] = d[i * 4 + ch] * kc;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }
  // Paper brightness map: shrink, take local maximum (removes text), smooth, then sample back up.
  function paperLevel(lum, W, H) {
    var step = Math.max(4, Math.round(Math.max(W, H) / 96)), sw = Math.ceil(W / step), sh = Math.ceil(H / step), x, y, i, j;
    var small = new Float32Array(sw * sh);
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) { var k = ((y / step) | 0) * sw + ((x / step) | 0); if (lum[y * W + x] > small[k]) small[k] = lum[y * W + x]; }
    var r = 3, m = new Float32Array(sw * sh);
    for (y = 0; y < sh; y++) for (x = 0; x < sw; x++) {
      var mx = 0;
      for (j = Math.max(0, y - r); j <= Math.min(sh - 1, y + r); j++) for (i = Math.max(0, x - r); i <= Math.min(sw - 1, x + r); i++) if (small[j * sw + i] > mx) mx = small[j * sw + i];
      m[y * sw + x] = mx;
    }
    m = boxBlur(boxBlur(m, sw, sh, 3), sw, sh, 3);
    var out = new Float32Array(W * H);
    for (y = 0; y < H; y++) {
      var fy = clamp(y / step - 0.5, 0, sh - 1), y0 = fy | 0, y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
      for (x = 0; x < W; x++) {
        var fx = clamp(x / step - 0.5, 0, sw - 1), x0 = fx | 0, x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
        var a = m[y0 * sw + x0] + (m[y0 * sw + x1] - m[y0 * sw + x0]) * tx, b = m[y1 * sw + x0] + (m[y1 * sw + x1] - m[y1 * sw + x0]) * tx;
        out[y * W + x] = a + (b - a) * ty;
      }
    }
    return out;
  }
  function pct(hist, n, p) { var target = n * p, acc = 0; for (var i = 0; i < 256; i++) { acc += hist[i]; if (acc >= target) return i; } return 255; }

  $('btnAddPage').addEventListener('click', function () {
    var c = state.filtered;
    c.toBlob(function (blob) {
      state.pages.push({ blob: blob, url: URL.createObjectURL(blob), w: c.width, h: c.height });
      state.unsaved = true;
      state.warped = state.filtered = null; state.src = state.srcData = null;
      renderPages();
      if (state.queue.length) {
        setStatus('ok', 'Page ' + state.pages.length + ' added', 'You tapped "Add to document".',
          'The page is in your document below. The next photo is opening automatically.', 'Wait for the frame to appear, then check the corners.');
        setTimeout(nextInQueue, 700);
      } else {
        show('add');
        setStatus('ok', 'Page ' + state.pages.length + ' added', 'You tapped "Add to document".',
          'Your document now has ' + plural(state.pages.length, 'page') + ' (shown below).',
          'Add another page with "Take photo", or scroll down and tap "Save PDF".');
      }
    }, 'image/jpeg', STORE_QUALITY);
  });

  /* ------------------------------------------------------------------ *
   * Step 4: page list and PDF
   * ------------------------------------------------------------------ */
  function renderPages() {
    var box = $('pages'); box.innerHTML = '';
    state.pages.forEach(function (p, i) {
      var div = document.createElement('div'); div.className = 'page';
      div.innerHTML = '<img alt="Page ' + (i + 1) + '" src="' + p.url + '"><div>Page ' + (i + 1) + '</div>' +
        '<div class="row"><button type="button" data-a="left" aria-label="Move page ' + (i + 1) + ' earlier"' + (i === 0 ? ' disabled' : '') + '>◀</button>' +
        '<button type="button" data-a="del" aria-label="Delete page ' + (i + 1) + '">🗑</button>' +
        '<button type="button" data-a="right" aria-label="Move page ' + (i + 1) + ' later"' + (i === state.pages.length - 1 ? ' disabled' : '') + '>▶</button></div>';
      div.addEventListener('click', function (e) {
        var a = e.target.closest('button'); if (!a) return;
        if (a.dataset.a === 'del') { URL.revokeObjectURL(p.url); state.pages.splice(i, 1); }
        else { var j = a.dataset.a === 'left' ? i - 1 : i + 1; state.pages[i] = state.pages[j]; state.pages[j] = p; }
        renderPages();
      });
      box.appendChild(div);
    });
    $('pageCount').textContent = '(' + plural(state.pages.length, 'page') + ')';
    $('noPages').classList.toggle('hidden', state.pages.length > 0);
    $('pdfControls').classList.toggle('hidden', state.pages.length === 0);
    if (!state.pages.length) state.unsaved = false;
  }

  $('btnAddMore').addEventListener('click', function () { show('add'); idleStatus(); scrollToStatus(); });
  $('btnClear').addEventListener('click', function () {
    if (!confirm('Delete all ' + plural(state.pages.length, 'page') + ' from this device? This cannot be undone.')) return;
    state.pages.forEach(function (p) { URL.revokeObjectURL(p.url); });
    state.pages = []; renderPages(); show('add');
    setStatus('info', 'All pages deleted', 'You tapped "Delete all".', 'Every page has been removed from this browser.', 'Add a new page to start again.');
  });

  var SIZES = { a4: [595.28, 841.89], letter: [612, 792] };

  function pdfName() {
    var n = ($('fileName').value || 'scan').trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\.pdf$/i, '') || 'scan';
    return n + '.pdf';
  }

  function makePdf() {
    var q = parseFloat($('quality').value), size = $('pageSize').value;
    return Promise.all(state.pages.map(function (p) {
      if (q >= STORE_QUALITY - 0.001) return p.blob.arrayBuffer().then(function (b) { return { bytes: new Uint8Array(b), w: p.w, h: p.h }; });
      return reencode(p.blob, q).then(function (blob) { return blob.arrayBuffer(); }).then(function (b) { return { bytes: new Uint8Array(b), w: p.w, h: p.h }; });
    })).then(function (imgs) { return buildPdf(imgs, size); });
  }

  function reencode(blob, q) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob), img = new Image();
      img.onload = function () {
        var c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
        var ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(url); c.toBlob(function (b) { b ? resolve(b) : reject(); }, 'image/jpeg', q);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(); };
      img.src = url;
    });
  }

  // Minimal PDF 1.4 writer: one JPEG image per page, no external library.
  function buildPdf(imgs, size) {
    var enc = new TextEncoder(), parts = [], offset = 0, offsets = [];
    function add(x) { var b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); offset += b.length; }
    function obj(num, body) { offsets[num] = offset; add(num + ' 0 obj\n'); body(); add('\nendobj\n'); }
    function f(n) { return (Math.round(n * 100) / 100).toString(); }
    var n = imgs.length, infoNum = 3 + n * 3;
    add('%PDF-1.4\n'); add(new Uint8Array([37, 226, 227, 207, 211, 10]));
    obj(1, function () { add('<< /Type /Catalog /Pages 2 0 R >>'); });
    var kids = []; for (var i = 0; i < n; i++) kids.push((3 + i * 3) + ' 0 R');
    obj(2, function () { add('<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + n + ' >>'); });
    imgs.forEach(function (im, i) {
      var pn = 3 + i * 3, inum = pn + 1, cnum = pn + 2, PW, PH, dw, dh;
      if (size === 'fit') { PW = im.w * 72 / 200; PH = im.h * 72 / 200; dw = PW; dh = PH; }
      else {
        var s = SIZES[size]; PW = s[0]; PH = s[1];
        if (im.w > im.h) { PW = s[1]; PH = s[0]; }
        var k = Math.min(PW / im.w, PH / im.h); dw = im.w * k; dh = im.h * k;
      }
      var ox = (PW - dw) / 2, oy = (PH - dh) / 2;
      obj(pn, function () { add('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + f(PW) + ' ' + f(PH) + '] /Resources << /XObject << /Im0 ' + inum + ' 0 R >> >> /Contents ' + cnum + ' 0 R >>'); });
      obj(inum, function () {
        add('<< /Type /XObject /Subtype /Image /Width ' + im.w + ' /Height ' + im.h + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + im.bytes.length + ' >>\nstream\n');
        add(im.bytes); add('\nendstream');
      });
      var content = 'q ' + f(dw) + ' 0 0 ' + f(dh) + ' ' + f(ox) + ' ' + f(oy) + ' cm /Im0 Do Q';
      obj(cnum, function () { add('<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream'); });
    });
    var d = new Date(), pad = function (v) { return (v < 10 ? '0' : '') + v; };
    var date = 'D:' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
    obj(infoNum, function () { add('<< /Producer (Headstart Consult CC Document Scanner) /CreationDate (' + date + ') >>'); });
    var xref = offset, size_ = infoNum + 1;
    add('xref\n0 ' + size_ + '\n0000000000 65535 f \n');
    for (i = 1; i < size_; i++) add(('0000000000' + offsets[i]).slice(-10) + ' 00000 n \n');
    add('trailer\n<< /Size ' + size_ + ' /Root 1 0 R /Info ' + infoNum + ' 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
    return new Blob(parts, { type: 'application/pdf' });
  }

  $('btnPdf').addEventListener('click', function () {
    var btn = this; btn.disabled = true;
    setStatus('info', 'Creating your PDF…', 'You tapped "Save PDF".', null, 'Please wait. Large documents can take a few seconds.', true);
    makePdf().then(function (blob) {
      var name = pdfName(), url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
      state.unsaved = false;
      setStatus('ok', 'PDF ready: ' + name + ' (' + (blob.size / 1048576).toFixed(1) + ' MB)', 'You tapped "Save PDF".',
        'Your browser saved the PDF to this device, usually in the Downloads folder. A phone may show a download bar or ask where to save it first.',
        'Open the file to check it. Your pages stay here until you close this page or tap "Delete all", so delete them if you are on a shared device.');
      scrollToStatus();
    }).catch(function () {
      setStatus('err', 'The PDF could not be created', 'You tapped "Save PDF".', 'Your device may be low on memory.', 'Choose "Small file" quality or remove some pages, then try again.');
    }).then(function () { btn.disabled = false; });
  });

  // Native share sheet where the browser supports sharing files (no cost: uses the visitor's own apps).
  if (navigator.canShare && navigator.canShare({ files: [new File([''], 'x.pdf', { type: 'application/pdf' })] })) {
    $('btnShare').classList.remove('hidden');
    $('btnShare').addEventListener('click', function () {
      setStatus('info', 'Preparing to share…', 'You tapped "Share".', null, 'Please wait.', true);
      makePdf().then(function (blob) {
        var file = new File([blob], pdfName(), { type: 'application/pdf' });
        return navigator.share({ files: [file], title: file.name }).then(function () {
          state.unsaved = false;
          setStatus('ok', 'Shared', 'You tapped "Share".', 'Your device handed the PDF to the app you picked. That app\'s own terms apply from here.', 'Delete the pages here with "Delete all" when you are done.');
        });
      }).catch(function () { idleStatus(); });
    });
  }

  window.addEventListener('beforeunload', function (e) { if (state.unsaved) { e.preventDefault(); e.returnValue = ''; } });

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }

  renderPages();
  show('add');
  idleStatus();

  // Exposed for automated tests only.
  window.__scanner = { detectQuad: detectQuad, buildPdf: buildPdf, state: state };
})();
