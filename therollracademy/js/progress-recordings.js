/* Progress recordings timeline — "Hear the R Come In, Week by Week." */
(function () {
  'use strict';
  var root = document.getElementById('progress-recordings');
  if (!root) return;

  var BASE = '/therollracademy/audio/progress/';
  var FILES = ['baseline.mp3', 'week-02.mp3', 'week-04.mp3', 'week-06.mp3', 'week-08.mp3', 'week-10.mp3', 'week-12.mp3'];
  var WEEKS = [
    { kicker: '',      label: 'Baseline', date: '25 Jan' },
    { kicker: 'After', label: '2 weeks',  date: '8 Feb' },
    { kicker: 'After', label: '4 weeks',  date: '22 Feb' },
    { kicker: 'After', label: '6 weeks',  date: '8 Mar' },
    { kicker: 'After', label: '8 weeks',  date: '22 Mar' },
    { kicker: 'After', label: '10 weeks', date: '5 Apr' },
    { kicker: 'After', label: '12 weeks', date: '19 Apr' }
  ];
  var WORDS = [
    { type: 'Initial', word: 'Red', dir: 'red', clips: [
      { gri: 18, heard: 'wed', ok: false, rho: 4,  note: 'R fully replaced by a W-glide. No tongue retraction detected.' },
      { gri: 31, heard: 'wed', ok: false, rho: 11, note: 'Early tongue bunching. R still perceived as W by listeners.' },
      { gri: 45, heard: 'wed', ok: false, rho: 20, note: 'Weak, slightly rolled R sound — typical of a regional accent.' },
      { gri: 58, heard: 'red', ok: true,  rho: 41, note: 'R now identifiable in isolation. Blends still unstable.' },
      { gri: 71, heard: 'red', ok: true,  rho: 63, note: 'Consistent in single words. Drops in fast conversation.' },
      { gri: 84, heard: 'red', ok: true,  rho: 81, note: 'Stable across blends and vocalic R.' },
      { gri: 93, heard: 'red', ok: true,  rho: 94, note: 'Natural, unforced R in conversation.' }
    ] },
    { type: 'Blend', word: 'Tree', dir: 'tree', clips: [
      { gri: 12, heard: 'twee', ok: false, rho: 2,  note: 'TR cluster collapses to TW. Tongue stays low behind the T release.' },
      { gri: 22, heard: 'twee', ok: false, rho: 7,  note: 'Slight retraction after T, but the glide still dominates.' },
      { gri: 36, heard: 'twee', ok: false, rho: 15, note: 'Brief R quality on the release; lost before the vowel.' },
      { gri: 49, heard: 'tree', ok: true,  rho: 33, note: 'R emerges in the cluster when spoken slowly. Breaks at speed.' },
      { gri: 64, heard: 'tree', ok: true,  rho: 55, note: 'R sound is slightly weak but acceptable in this cluster.' },
      { gri: 79, heard: 'tree', ok: true,  rho: 76, note: 'Clean TR onset. Minor lip rounding still audible.' },
      { gri: 91, heard: 'tree', ok: true,  rho: 92, note: 'Crisp, natural cluster at conversational pace.' }
    ] },
    { type: 'Vocalic', word: 'World', dir: 'world', clips: [
      { gri: 9,  heard: 'wuhld', ok: false, rho: 1,  note: 'Vocalic R absent. Vowel is an open schwa with no tongue lift.' },
      { gri: 17, heard: 'wuhld', ok: false, rho: 5,  note: 'Faint tongue tension; listeners still hear no R coloring.' },
      { gri: 29, heard: 'wuhld', ok: false, rho: 12, note: 'Intermittent R coloring on the vowel. Unreliable.' },
      { gri: 42, heard: 'wurld', ok: true,  rho: 28, note: 'R coloring present but under-shot before the L.' },
      { gri: 57, heard: 'world', ok: true,  rho: 49, note: 'Vocalic R clearly heard. Transition into L still heavy.' },
      { gri: 74, heard: 'world', ok: true,  rho: 71, note: 'Stable ER vowel across repetitions.' },
      { gri: 89, heard: 'world', ok: true,  rho: 90, note: 'Natural vocalic R with smooth RL transition.' }
    ] }
  ];
  var N = WEEKS.length, BARS = 28, DEFAULT_DUR = 3, CIRC = 251.3;

  function $(id) { return document.getElementById(id); }
  function hide(node, flag) { if (flag) node.setAttribute('hidden', ''); else node.removeAttribute('hidden'); }
  var el = {
    tabs: $('prTabs'), target: $('prTargetWord'),
    mute: $('prMute'), muteLabel: $('prMuteLabel'), segs: $('prSegs'), wave: $('prWave'), time: $('prTime'),
    play: $('prPlay'), playLabel: $('prPlayLabel'), card: $('prCard'), cardTitle: $('prCardTitle'),
    compare: $('prCompare'), cmpBase: $('prCmpBase'), cmpWeek: $('prCmpWeek'),
    gri: $('prGri'), griDelta: $('prGriDelta'), heardFirst: $('prHeardFirst'), heardRest: $('prHeardRest'),
    rhoDelta: $('prRhoDelta'), rho: $('prRho'), rhoBar: $('prRhoBar'), note: $('prNote'),
    pointer: $('prPointer'), fill: $('prFill'), nodes: $('prNodes'), labels: $('prLabels'), panel: root.querySelector('.pr-panel')
  };

  var state = { idx: 0, playing: false, t: 0, muted: true, started: false, finished: false, cmp: false, word: 0 };
  var audio = {}, timer = null, tick = 0, wasPlaying = false, listened = false, holdAfter = false, viewed = false, completed = {};

  /* ---------- build DOM ---------- */
  var ICON = {
    play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 4.5v15l12-7.5z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="4" width="5" height="16" rx="1"/><rect x="14" y="4" width="5" height="16" rx="1"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9.5 17.2 4.3 12l1.9-1.9 3.3 3.3 8.3-8.3 1.9 1.9z"/></svg>'
  };
  var tabEls = [], segEls = [], barEls = [], nodeWraps = [], nodeBtns = [], arcs = [], labelEls = [];
  WORDS.forEach(function (w, i) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'pr-tab'; b.setAttribute('role', 'tab');
    b.innerHTML = '<small>' + w.type + '</small><span>“' + w.word + '”</span>';
    b.addEventListener('click', function () { setWord(i); });
    el.tabs.appendChild(b); tabEls.push(b);
  });
  WEEKS.forEach(function (wk, i) {
    var s = document.createElement('div'); s.className = 'pr-seg'; s.innerHTML = '<i></i>';
    el.segs.appendChild(s); segEls.push(s);

    var w = document.createElement('div'); w.className = 'pr-node-wrap';
    w.innerHTML = '<svg class="pr-ring" viewBox="0 0 88 88" aria-hidden="true"><circle cx="44" cy="44" r="40" fill="none" stroke="rgba(232,87,0,0.18)" stroke-width="3"/><circle class="arc" cx="44" cy="44" r="40" fill="none" stroke="#E85700" stroke-width="3" stroke-linecap="round" stroke-dasharray="251.3" stroke-dashoffset="251.3"/></svg>'
      + '<button type="button" class="pr-node">' + ICON.play + ICON.pause + ICON.check + '</button>';
    el.nodes.appendChild(w); nodeWraps.push(w);
    var b = w.querySelector('.pr-node'); nodeBtns.push(b); arcs.push(w.querySelector('.arc'));
    b.addEventListener('click', function () { onNode(i); });

    var l = document.createElement('div'); l.className = 'pr-label';
    l.innerHTML = '<small>' + wk.kicker + '</small><span>' + wk.label + '</span><em>' + wk.date + '</em>';
    el.labels.appendChild(l); labelEls.push(l);
  });
  for (var k = 0; k < BARS; k++) { var bar = document.createElement('i'); el.wave.appendChild(bar); barEls.push(bar); }

  /* ---------- helpers ---------- */
  function playIdx() { return state.cmp ? 0 : state.idx; }
  function key(i) { return state.word + ':' + i; }
  function src(i) { return BASE + WORDS[state.word].dir + '/' + FILES[i]; }
  function clip(i) { return WORDS[state.word].clips[i]; }
  function fmt(sec) { var s = Math.max(0, Math.round(sec)); return Math.floor(s / 60) + ':' + (s % 60 < 10 ? '0' : '') + (s % 60); }
  function dur(i) { var a = audio[key(i)]; return a && a.duration && isFinite(a.duration) ? a.duration : DEFAULT_DUR; }
  function weekName(wk) { return wk.kicker ? 'Week ' + wk.label.split(' ')[0] : 'Baseline'; }
  function sign(v) { return (v >= 0 ? '+' : '') + v; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]; }); }
  function track(name, props) { try { if (window.posthog && posthog.capture) posthog.capture(name, props || {}); } catch (e) {} }

  function getAudio(i) {
    var w = state.word, k = key(i);
    if (!audio[k]) {
      var a = new Audio(src(i));
      a.preload = 'auto';
      a.addEventListener('timeupdate', function () { if (state.word === w && playIdx() === i) { state.t = a.duration ? a.currentTime / a.duration : 0; render(); } });
      a.addEventListener('ended', function () { if (state.word === w && playIdx() === i) finish(); });
      a.addEventListener('error', function () { if (state.word === w && playIdx() === i && state.playing) simulate(i); });
      a.addEventListener('loadedmetadata', render);
      audio[k] = a;
    }
    audio[k].muted = state.muted;
    return audio[k];
  }
  function playAudio(i) {
    var a = getAudio(i), w = state.word;
    var p = a.play();
    if (p && p.catch) p.catch(function () { if (state.playing && state.word === w && playIdx() === i) simulate(i); });
  }
  function stopAll() {
    clearInterval(timer); timer = null;
    Object.keys(audio).forEach(function (k) { var a = audio[k]; a.pause(); try { a.currentTime = 0; } catch (e) {} });
  }
  function simulate(i) {
    clearInterval(timer);
    var w = state.word, step = 0.05 / dur(i);
    timer = setInterval(function () {
      if (!state.playing || state.word !== w || playIdx() !== i) { clearInterval(timer); timer = null; return; }
      var t = state.t + step;
      if (t >= 1) { clearInterval(timer); timer = null; finish(); } else { state.t = t; render(); }
    }, 50);
  }

  /* ---------- transport ---------- */
  function start(i) {
    stopAll(); holdAfter = false;
    state.idx = i; state.playing = true; state.t = 0; state.started = true; state.finished = false; state.cmp = false;
    render(); playAudio(i);
  }
  function pause() {
    clearInterval(timer); timer = null;
    var a = audio[key(playIdx())]; if (a) a.pause();
    state.playing = false; render();
  }
  function resume() {
    if (!state.cmp && state.t >= 1 && !state.finished) { // held after a comparison: continue with the next clip
      if (state.idx < N - 1) start(state.idx + 1); else nextWord();
      return;
    }
    state.playing = true; render(); playAudio(playIdx());
  }
  function nextWord() { // loop: red -> tree -> world -> red ..., keeping the current mute state
    state.word = (state.word + 1) % WORDS.length; state.cmp = false; start(0);
  }
  function finish() {
    if (state.cmp) { // baseline comparison finished: play this week's clip once more, then hold
      stopAll(); state.cmp = false; state.t = 0; state.playing = true; holdAfter = true; render(); playAudio(state.idx); return;
    }
    if (holdAfter) { // held: the user continues from the next node or the play button
      holdAfter = false; state.playing = false; state.t = 1; render(); return;
    }
    if (state.idx < N - 1) start(state.idx + 1);
    else {
      if (!state.muted && !completed[state.word]) { completed[state.word] = true; track('progress_recordings_complete', { word: WORDS[state.word].word }); }
      nextWord();
    }
  }
  function setWord(w) {
    if (w === state.word) return;
    stopAll();
    state.word = w; state.cmp = false; state.t = 0; state.playing = false; state.finished = false;
    track('progress_recordings_word', { word: WORDS[w].word });
    setMuted(false); start(0);
  }
  function setCompare(on) { // always plays the chosen clip from the start
    if (state.idx === 0 || on === state.cmp) return;
    stopAll(); holdAfter = false;
    if (on) track('progress_recordings_compare', { word: WORDS[state.word].word, week: WEEKS[state.idx].label });
    state.cmp = on; state.t = 0; state.playing = true; state.started = true; state.finished = false;
    render(); playAudio(playIdx());
  }
  function setMuted(m) {
    state.muted = m;
    Object.keys(audio).forEach(function (k) { audio[k].muted = m; });
    if (!m && !listened) { listened = true; track('progress_recordings_listen', { word: WORDS[state.word].word, clip: WEEKS[playIdx()].label }); }
  }
  function onNode(i) {
    var active = i === state.idx, cmpNode = state.cmp && i === 0;
    if (cmpNode || (active && !state.finished && !state.cmp)) {
      if (state.playing) { pause(); return; }
      setMuted(false); resume();
    } else if (active && state.cmp) { setMuted(false); setCompare(false); }
    else { setMuted(false); start(i); }
  }

  el.mute.addEventListener('click', function () {
    var m = !state.muted; setMuted(m);
    if (!m) { if (!state.started || state.finished) start(0); else if (!state.playing) resume(); }
    render();
  });
  el.play.addEventListener('click', function () {
    if (state.playing) { pause(); return; }
    setMuted(false);
    if (state.finished || !state.started) start(0); else resume();
  });
  el.cmpBase.addEventListener('click', function () { setMuted(false); setCompare(true); });
  el.cmpWeek.addEventListener('click', function () { setMuted(false); setCompare(false); });
  /* click on any blank part of the panel toggles playback (buttons, links and the detail card keep their own behaviour) */
  el.panel.addEventListener('click', function (e) {
    if (e.target.closest('button, a, .pr-card')) return;
    if (state.playing) { pause(); return; }
    setMuted(false);
    if (state.finished || !state.started) start(0); else resume();
  });

  /* ---------- render ---------- */
  function render() {
    var idx = state.idx, playing = state.playing, finished = state.finished, cmp = state.cmp, started = state.started;
    var vIdx = playIdx(), c = clip(vIdx), base = clip(0), prog = finished ? 1 : state.t, d = dur(vIdx);
    var trackProg = cmp ? 0 : prog; // the track never advances while the baseline comparison plays
    var wordObj = WORDS[state.word];

    tabEls.forEach(function (b, i) { var on = i === state.word; b.className = 'pr-tab' + (on ? ' on' : ''); b.setAttribute('aria-selected', String(on)); });
    el.target.textContent = '“' + wordObj.word.toLowerCase() + '”';

    nodeWraps.forEach(function (w, i) {
      var active = i === idx, cmpNode = cmp && i === 0, done = i < idx || (finished && active), isPlaying = i === vIdx && playing;
      w.className = 'pr-node-wrap' + (active ? ' active' : '') + (cmpNode ? ' cmp' : '') + (done && !active && !cmpNode ? ' done' : '') + (i === vIdx ? ' ring' : '');
      var showPause = isPlaying;
      var showCheck = done && !isPlaying && !(active && cmp) && !cmpNode;
      var svgs = nodeBtns[i].children;
      hide(svgs[0], showPause || showCheck); hide(svgs[1], !showPause); hide(svgs[2], !showCheck);
      nodeBtns[i].setAttribute('aria-label', (isPlaying ? 'Pause ' : 'Play ') + (WEEKS[i].kicker ? WEEKS[i].kicker.toLowerCase() + ' ' : '') + WEEKS[i].label + ' recording');
      if (i === vIdx) arcs[i].setAttribute('stroke-dashoffset', (CIRC * (1 - prog)).toFixed(1));
      labelEls[i].className = 'pr-label' + (active ? ' active' : cmpNode ? ' cmp' : done ? ' done' : '');
    });

    segEls.forEach(function (s, i) {
      s.className = 'pr-seg' + (i === idx && !finished ? ' is-live' : '');
      s.firstChild.style.width = (i < idx || finished ? 100 : i === idx ? Math.round(trackProg * 100) : 0) + '%';
    });

    el.fill.style.width = (85.7143 * Math.min(idx + trackProg, N - 1) / (N - 1)).toFixed(3) + '%';
    var center = ((idx + 0.5) / N * 100).toFixed(3) + '%';
    el.card.style.marginLeft = 'clamp(0px, calc(' + center + ' - 170px), calc(100% - 340px))';
    el.pointer.style.left = center;

    /* card */
    el.cardTitle.textContent = 'Baseline · ' + WEEKS[0].date + ' 2026';
    hide(el.cardTitle, idx !== 0);
    hide(el.compare, idx === 0);
    el.cmpBase.className = cmp ? 'on' : '';
    el.cmpWeek.className = cmp ? '' : 'on week';
    el.cmpBase.setAttribute('aria-pressed', String(cmp));
    el.cmpWeek.setAttribute('aria-pressed', String(!cmp));
    el.cmpWeek.textContent = weekName(WEEKS[idx]);
    var showDelta = vIdx > 0;
    el.gri.textContent = 'GRI ' + c.gri;
    el.griDelta.textContent = sign(c.gri - base.gri);
    hide(el.griDelta, !showDelta);
    el.heardFirst.textContent = c.heard.charAt(0);
    el.heardFirst.style.color = c.ok ? '#E85700' : '#EF4444';
    el.heardRest.textContent = c.heard.slice(1);
    el.rhoDelta.textContent = sign(c.rho - base.rho) + '% from baseline';
    hide(el.rhoDelta, !showDelta);
    el.rho.textContent = c.rho + '%';
    el.rhoBar.style.width = c.rho + '%';
    el.note.innerHTML = '<strong>Observation: </strong>' + esc(c.note);

    /* transport */
    el.muteLabel.textContent = state.muted ? 'Muted · tap to hear' : 'Sound on';
    el.mute.setAttribute('aria-label', state.muted ? 'Unmute recordings' : 'Mute recordings');
    hide(el.mute.querySelector('.ic-muted'), !state.muted);
    hide(el.mute.querySelector('.ic-on'), state.muted);
    el.playLabel.textContent = playing ? 'Pause' : finished ? 'Replay' : started ? 'Resume' : 'Play';
    el.play.setAttribute('aria-label', playing ? 'Pause playback' : 'Play recordings from baseline');
    hide(el.play.querySelector('.ic-play'), playing);
    hide(el.play.querySelector('.ic-pause'), !playing);
    el.time.textContent = fmt(prog * d) + ' / ' + fmt(d);
    renderWave();
  }
  function renderWave() {
    var prog = state.finished ? 1 : state.t, rough = 1 - clip(playIdx()).rho / 100;
    barEls.forEach(function (b, i) {
      var x = i / (BARS - 1);
      var env = Math.exp(-Math.pow((x - 0.45) / 0.28, 2)) * 0.9 + 0.1;
      var s = Math.sin(i * 12.9898 + (state.playing ? tick : 0) * 78.233) * 43758.5453;
      var jitter = s - Math.floor(s);
      var noisy = env * (0.3 + 0.7 * jitter) + 0.2 * jitter;
      var amp = Math.min(1, env * (1 - rough) + noisy * rough);
      b.style.height = Math.round(4 + amp * 26) + 'px';
      b.className = state.started && x <= prog ? 'on' + (state.cmp ? ' cmp' : '') : '';
    });
  }
  setInterval(function () { if (state.playing) { tick++; renderWave(); } }, 120);

  /* ---------- autoplay (muted) when scrolled into view ---------- */
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function inView() { var r = el.panel.getBoundingClientRect(), vh = window.innerHeight || document.documentElement.clientHeight; var vis = Math.min(r.bottom, vh) - Math.max(r.top, 0); return r.height > 0 && vis / r.height >= 0.35; }
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      var en = entries[0];
      if (en.isIntersecting) {
        if (!viewed) { viewed = true; track('progress_recordings_view'); }
        if (!state.started) { if (!reduce && !document.hidden) start(0); }
        else if (wasPlaying && !document.hidden) { wasPlaying = false; resume(); }
      } else if (state.playing) { wasPlaying = true; pause(); }
    }, { threshold: 0.35 }).observe(el.panel);
  }
  /* pause when the browser tab is hidden; resume on return if the section is still in view */
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { if (state.playing) { wasPlaying = true; pause(); } }
    else if (wasPlaying && inView()) { wasPlaying = false; resume(); }
  });

  render();
})();
