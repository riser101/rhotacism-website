/* Homepage footer band: the "TopSpeech" wordmark drawn as waveform bars. Port of the approved
   Claude Design "Footer Waveword" (Nov 2026): idle ripple, hover lift + readouts, tap/Enter
   traces a 1.5 s playhead. No audio, so the readouts are a labelled MODEL, not measurements.
   Loaded only by therollracademy/index.html. To remove: delete the two WAVEWORD blocks in
   index.html, css/waveword.css and this file. */
(function () {
  const TEXT = 'TopSpeech', SERIF = '"DM Serif Display"', MONO = '"JetBrains Mono", ui-monospace, monospace';
  const PH = [[0,1,'t','p'],[1,2,'ɑ','v'],[2,3,'p','p'],[3,4,'s','f'],[4,5,'p','p'],[5,7,'i','v'],[7,9,'tʃ','f']];
  const DUR = 1500, SPAN = 1.2;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  function rr(ctx, x, y, w, h) {
    const r = Math.min(w / 2, h / 2);
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function Waveword(root, o) {
    const cv = root.querySelector('canvas'), ctx = cv.getContext('2d');
    const ro = {}; root.querySelectorAll('[data-ro]').forEach(e => ro[e.dataset.ro] = e);
    const row = o.row || null, btn = root.querySelector('[data-trace]');
    const mq = matchMedia('(prefers-reduced-motion: reduce)');
    let reduced = mq.matches;
    let dead = false, raf = 0, W = 0, H = 0, dpr = 1, cols = [], groups = [], mid = 0, bw = 0, n = 0, pitch = 0, xh = 0, rulerH = 0, phonH = 0, M = 0;
    let px = null, sweepT0 = -1, down = null, visible = true, rowOn = null; const last = {};
    const set = (k, v) => { if (ro[k] && last[k] !== v) { ro[k].textContent = v; last[k] = v; } };

    function build() {
      W = cv.clientWidth; if (!W) return false;
      dpr = Math.min(2, window.devicePixelRatio || 1);
      // Past maxW the word stops growing and centres; the CSS row padding uses the same formula.
      M = o.maxW ? Math.max(o.gutter, (W - o.maxW) / 2 + o.gutter) : o.gutter;
      const span = W - 2 * M;
      n = o.cols;
      const p0 = span / n;
      bw = Math.max(o.minBw || 2, p0 * o.ratio, o.maxGap ? p0 - o.maxGap : 0);
      pitch = (span - bw) / (n - 1);
      const cxs = i => M + bw / 2 + i * pitch;
      const mc = document.createElement('canvas').getContext('2d');
      mc.font = `400 100px ${SERIF}`;
      const m0 = mc.measureText(TEXT);
      let fs = span / (m0.actualBoundingBoxLeft + m0.actualBoundingBoxRight) * 100, inkL = M, res;

      function sample(fs, inkL) {
        const font = `400 ${fs}px ${SERIF}`; mc.font = font;
        const mm = mc.measureText(TEXT);
        const asc = mm.actualBoundingBoxAscent, desc = mm.actualBoundingBoxDescent;
        const wordH = Math.ceil(asc + desc) + 2, x0 = inkL + mm.actualBoundingBoxLeft;
        const oc = document.createElement('canvas'); oc.width = Math.ceil(W); oc.height = wordH;
        const ox = oc.getContext('2d', { willReadFrequently: true }); ox.font = font; ox.fillStyle = '#000'; ox.fillText(TEXT, x0, asc + 1);
        const data = ox.getImageData(0, 0, oc.width, oc.height).data;
        const cs = []; let first = -1, lastI = -1;
        for (let i = 0; i < n; i++) {
          const cx = cxs(i), segs = [];
          const sx = [Math.round(cx - bw * 0.3), Math.round(cx), Math.round(cx + bw * 0.3)];
          let run = -1;
          for (let y = 0; y <= wordH; y++) {
            let on = false;
            if (y < wordH) { let c = 0; for (const x of sx) if (x >= 0 && x < oc.width && data[(y * oc.width + x) * 4 + 3] > 110) c++; on = c >= 2; }
            if (on && run < 0) run = y; else if (!on && run >= 0) { segs.push([run, y]); run = -1; }
          }
          const merged = [];
          for (const s of segs) { const l = merged[merged.length - 1]; if (l && s[0] - l[1] < bw * 0.9) l[1] = s[1]; else merged.push([s[0], s[1]]); }
          cs.push({ cx, merged, fill: merged.reduce((a, s) => a + s[1] - s[0], 0) });
        }
        // Suppress only isolated specks: short fill with no substantial neighbour on either side.
        const big = i => i >= 0 && i < n && cs[i].fill >= 2 * bw;
        cs.forEach((c, i) => {
          const has = j => j >= 0 && j < n && cs[j].fill > 0;
          const keep = c.fill > 0 && (big(i) || has(i - 1) || has(i + 1));
          c.segs = keep ? c.merged.map(s => { let a = s[0], b = s[1]; if (b - a < bw) { const m = (a + b) / 2; a = m - bw / 2; b = m + bw / 2; } return [a, b]; }) : [];
          if (c.segs.length) { if (first < 0) first = i; lastI = i; }
        });
        return { font, asc, desc, wordH, x0, cs, first, last: lastI };
      }

      // Fit: stretch the type until the first/last visible columns sit exactly on the gutters.
      for (let it = 0; it < 6; it++) {
        res = sample(fs, inkL);
        const f = res.first, l = res.last;
        if (f < 0 || (f === 0 && l === n - 1) || l <= f) break;
        const s = (cxs(n - 1) - cxs(0)) / (cxs(l) - cxs(f));
        inkL = cxs(0) + (inkL - cxs(f)) * s; fs *= s;
      }
      mc.font = res.font; xh = mc.measureText('x').actualBoundingBoxAscent;
      const head = res.asc * 0.16 + o.liftMax, foot = res.desc * 0.2 + 4;
      rulerH = o.ruler ? o.rulerH : 6; phonH = o.phonH;
      const wordTop = rulerH + head;
      H = Math.ceil(wordTop + res.wordH + foot + phonH);
      cv.style.height = H + 'px'; cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      mid = wordTop + res.asc + 1 - xh / 2;
      const lx = k => res.x0 + mc.measureText(TEXT.slice(0, k)).width;
      groups = PH.map(([a, b, l, t]) => ({ x0: lx(a), x1: lx(b), l, t }));
      cols = res.cs.map(c => {
        let g = groups.findIndex(gr => c.cx >= gr.x0 && c.cx < gr.x1);
        if (g < 0) g = c.cx < groups[0].x0 ? 0 : groups.length - 1;
        return { cx: c.cx, segs: c.segs.map(([a, b]) => [a + wordTop, b + wordTop]), g, s: 0, lift: 0 };
      });
      return true;
    }

    function frame(now) {
      raf = 0; if (dead || !n) return;
      const t = now / 1000, L = M, Rr = W - M, span = Rr - L;
      let p = -1, sweeping = false;
      if (sweepT0 >= 0) { const k = (now - sweepT0) / DUR; if (k > 1.15) sweepT0 = -1; else { sweeping = true; p = k; } }
      const onHead = sweeping && p >= 0 && p <= 1, xp = L + clamp(p, 0, 1) * span;
      const hx = sweeping ? null : px;
      const fx = onHead ? xp : hx;
      const inWord = fx != null && fx >= L && fx <= Rr;
      let fg = -1;
      if (inWord) { fg = groups.findIndex(g => fx >= g.x0 && fx < g.x1); if (fg < 0) fg = fx < groups[0].x0 ? 0 : groups.length - 1; }
      const R = pitch * 7, fsz = o.font;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);

      ctx.font = `400 ${fsz}px ${MONO}`; ctx.textBaseline = 'alphabetic';
      if (o.ruler) {
        ctx.fillStyle = '#2b2b2b'; ctx.fillRect(0, rulerH - 1, W, 1);
        for (let j = 0; j <= 24; j++) {
          const major = j % 4 === 0, x = Math.min(W - 1, Math.round(L + (j * 0.05) / SPAN * span) - (j === 24 ? 1 : 0)), h = major ? 7 : 3;
          ctx.fillStyle = major ? '#5c5c5c' : '#333'; ctx.fillRect(x, rulerH - 1 - h, 1, h);
          if (major && j > 0) {
            ctx.fillStyle = '#8a8a8a'; const lab = j === 24 ? '1.2 s' : (j * 0.05).toFixed(1);
            ctx.fillText(lab, x - 4 - ctx.measureText(lab).width, rulerH - 6);
          }
        }
      }
      const yb = H - phonH + 6;
      groups.forEach((g, gi) => {
        const a = Math.max(g.x0 + 3, L), b = Math.min(g.x1 - 3, Rr), act = onHead && gi === fg, hov = !sweeping && gi === fg;
        ctx.fillStyle = act ? '#fff' : hov ? '#9a9a9a' : '#3a3a3a';
        ctx.fillRect(a, yb, b - a, 1); ctx.fillRect(a, yb, 1, 4); ctx.fillRect(b - 1, yb, 1, 4);
        ctx.fillStyle = act ? '#fff' : hov ? '#d6d6d6' : '#8a8a8a';
        const label = '/' + g.l + '/', w = ctx.measureText(label).width;
        ctx.fillText(label, (a + b) / 2 - w / 2, yb + fsz + 6);
      });
      if (onHead) { ctx.fillStyle = '#fff'; ctx.fillRect(Math.round(xp), rulerH, 1, H - rulerH - phonH); }
      else if (hx != null) { ctx.fillStyle = '#4a4a4a'; ctx.fillRect(Math.round(hx), rulerH, 1, H - rulerH - phonH); }

      let moving = false;
      for (let i = 0; i < n; i++) {
        const c = cols[i], u = (c.cx - L) / span;
        let tgt = 0;
        if (!reduced) {
          const syl = Math.max(0, Math.sin(u * Math.PI * 2.6 - t * 1.7));
          tgt = 0.028 * (0.3 + 0.7 * syl * syl) * (0.75 + 0.25 * Math.sin(t * 9 + i * 1.7));
          if (sweeping) {
            const d = p - u, env = d < 0 ? Math.exp(-((d / 0.012) ** 2)) : Math.exp(-d / 0.045);
            const ty = groups[c.g].t;
            const mod = ty === 'v' ? 1 : ty === 'p' ? (d >= 0 && d < 0.02 ? 1.5 : 0.5) : ty === 'f' ? 0.3 + 0.7 * Math.random() : 0.3;
            tgt += 0.24 * env * mod;
          }
        }
        c.s += (tgt - c.s) * (reduced ? 1 : 0.3);
        const g = hx == null ? 0 : Math.exp(-(((c.cx - hx) / R) ** 2));
        const lt = reduced ? 0 : o.liftMax * g;
        c.lift += (lt - c.lift) * (reduced ? 1 : 0.2);
        if (Math.abs(lt - c.lift) > 0.05) moving = true;
        if (!c.segs.length) continue;
        let v = 236;
        if (sweeping) v = u <= p ? 255 : 115;
        v = Math.round(v + (255 - v) * g);
        ctx.beginPath(); ctx.fillStyle = `rgb(${v},${v},${v})`;
        for (const [a, b] of c.segs) {
          const y0 = mid + (a - mid) * (1 + c.s) - c.lift, y1 = mid + (b - mid) * (1 + c.s) - c.lift;
          rr(ctx, c.cx - bw / 2, y0, bw, y1 - y0);
        }
        ctx.fill();
      }

      if (inWord) { set('time', `t ${(clamp((fx - L) / span, 0, 1) * SPAN).toFixed(2)} s`); set('phon', `/${groups[fg].l}/`); }
      else { set('time', 't — s'); set('phon', '/—/'); }
      if (row) { const on = onHead || hx != null; if (on !== rowOn) { row.style.display = on ? 'flex' : 'none'; rowOn = on; } }
      if ((!reduced && visible) || sweeping || moving) req();
    }
    function req() { if (!raf && !dead) raf = requestAnimationFrame(frame); }

    const pos = e => { const r = cv.getBoundingClientRect(); return (e.clientX - r.left) * (W / r.width); };
    const onMove = e => { if (e.pointerType === 'touch' && !down) return; px = pos(e); req(); };
    const onDown = e => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; px = pos(e); req(); };
    const onUp = e => {
      if (down && Math.abs(e.clientX - down.x) < 8 && Math.abs(e.clientY - down.y) < 8 && performance.now() - down.t < 500) play();
      down = null; if (e.pointerType !== 'mouse') px = null; req();
    };
    const onLeave = () => { px = null; down = null; req(); };
    const noFocus = e => e.preventDefault();
    function play() { sweepT0 = performance.now(); req(); if (o.onPlay) o.onPlay(); }
    const onMq = () => { reduced = mq.matches; req(); };
    const onFonts = () => { if (build()) req(); };

    cv.addEventListener('pointermove', onMove); cv.addEventListener('pointerdown', onDown);
    cv.addEventListener('pointerup', onUp); cv.addEventListener('pointerleave', onLeave);
    cv.addEventListener('pointercancel', onLeave);
    if (btn) { btn.addEventListener('click', play); btn.addEventListener('mousedown', noFocus); }
    mq.addEventListener && mq.addEventListener('change', onMq);
    document.fonts && document.fonts.addEventListener('loadingdone', onFonts);
    const rob = new ResizeObserver(() => { if (cv.clientWidth && Math.abs(cv.clientWidth - W) > 0.5 && build()) req(); });
    rob.observe(cv);
    const io = new IntersectionObserver(es => { visible = es[0].isIntersecting; if (visible) req(); });
    io.observe(cv);
    (async () => {
      try { await Promise.all([document.fonts.load(`400 100px ${SERIF}`), document.fonts.load(`400 10px ${MONO}`)]); } catch (e) {}
      if (!dead && build()) req();
    })();

    return {
      play,
      destroy() {
        dead = true; if (raf) cancelAnimationFrame(raf);
        cv.removeEventListener('pointermove', onMove); cv.removeEventListener('pointerdown', onDown);
        cv.removeEventListener('pointerup', onUp); cv.removeEventListener('pointerleave', onLeave);
        cv.removeEventListener('pointercancel', onLeave);
        if (btn) { btn.removeEventListener('click', play); btn.removeEventListener('mousedown', noFocus); }
        mq.removeEventListener && mq.removeEventListener('change', onMq);
        document.fonts && document.fonts.removeEventListener('loadingdone', onFonts);
        rob.disconnect(); io.disconnect();
      }
    };
  }

  // Artboard 1a (desktop 1440) and 1b (mobile 390) settings; 759px matches the CSS breakpoint.
  const DESKTOP = { cols: 120, gutter: 40, maxW: 1680, ratio: 0.58, minBw: 2, ruler: true, liftMax: 18, rulerH: 30, phonH: 36, font: 10 };
  const MOBILE = { cols: 56, gutter: 16, ratio: 0.58, minBw: 4, maxGap: 3, ruler: false, liftMax: 8, rulerH: 20, phonH: 26, font: 8.5 };
  let lastTrack = 0;
  const track = () => {
    const now = Date.now(); if (now - lastTrack < 3000) return; lastTrack = now;
    try { if (window.posthog) window.posthog.capture('footer_waveword_trace'); } catch (e) {}
  };

  function init(root) {
    const small = matchMedia('(max-width: 759px)'), roRow = root.querySelector('.ww-ro');
    let inst = null;
    const boot = () => {
      if (inst) inst.destroy();
      if (roRow) roRow.style.display = '';
      inst = Waveword(root, Object.assign({ row: small.matches ? roRow : null, onPlay: track }, small.matches ? MOBILE : DESKTOP));
    };
    small.addEventListener ? small.addEventListener('change', boot) : small.addListener(boot);
    boot();
    root.querySelectorAll('[data-ww-year]').forEach(e => { e.textContent = new Date().getFullYear(); });
  }
  if (!window.matchMedia || !window.ResizeObserver || !window.IntersectionObserver) return;
  document.querySelectorAll('.ww-band').forEach(init);
})();
