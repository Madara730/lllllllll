/* ============================================================
   JumperCast — Application Logic v3
   WebRTC Screen Share + Remote Control via PeerJS
   ============================================================ */

'use strict';

// ── PeerJS Config (default cloud broker) ──────────────────
const PEERJS_CONFIG = {
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'turn:openrelay.metered.ca:80',  username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' }
    ]
  }
};

const PREFIX = 'jc-';

// ── State ──────────────────────────────────────────────────
const S = {
  role: null, peer: null, roomId: null,
  stream: null, viewers: {}, remoteCtrl: false,
  hostConn: null, dataConn: null
};

// ── Helpers ────────────────────────────────────────────────
const uid  = (n=6) => Math.random().toString(36).slice(2, 2+n);
const $    = id => document.getElementById(id);
const hide = (id, v) => { const el = $(id) || id; if(el) el.classList.toggle('hidden', v); };

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = $(id);
  if (el) el.classList.add('active');
  else console.error('Screen not found:', id);
}

function toast(msg, ms=3000) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), ms);
}

function badge(id, cls, txt) {
  const el = $(id);
  if (!el) return;
  el.className = 'status-badge ' + cls;
  el.textContent = txt;
}

function isMobile() {
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
}

function buildUrl(roomId) {
  return window.location.origin + window.location.pathname + '?room=' + encodeURIComponent(roomId);
}

// ── QR render (safe — won't crash if lib not loaded) ──────
function renderQR(roomId) {
  const box = $('qr-container');
  if (!box) return;
  box.innerHTML = '';
  if (typeof QRCode === 'undefined') {
    box.innerHTML = '<p style="color:#6b7280;font-size:.8rem;text-align:center">QR unavailable — copy link instead</p>';
    return;
  }
  const canvas = document.createElement('canvas');
  box.appendChild(canvas);
  QRCode.toCanvas(canvas, buildUrl(roomId), { width: 132, margin: 1, color: { dark:'#000', light:'#fff' } }, e => {
    if (e) console.warn('QR error:', e);
  });
}

// ── Copy helpers ───────────────────────────────────────────
function copyRoomId() {
  if (!S.roomId) return;
  navigator.clipboard.writeText(S.roomId).then(() => toast('Room ID copied!'));
}
function copyLink() {
  if (!S.roomId) return;
  navigator.clipboard.writeText(buildUrl(S.roomId)).then(() => toast('Link copied! Send to phone.'));
}

// ── URL param auto-connect ─────────────────────────────────
function checkUrlParams() {
  const room = new URLSearchParams(location.search).get('room');
  if (room) {
    selectRole('viewer');
    const inp = $('room-input');
    if (inp) inp.value = room;
    setTimeout(() => connectToRoom(), 1000);
  }
}

// ═══════════════════════════════════════════════════════════
//  ROLE SELECTION
// ═══════════════════════════════════════════════════════════
function selectRole(role) {
  console.log('[JC] selectRole:', role);

  if (typeof Peer === 'undefined') {
    alert('PeerJS library did not load. Please check your internet and refresh.');
    return;
  }

  S.role = role;

  if (role === 'sharer') {
    // Block on mobile — getDisplayMedia not supported
    if (isMobile()) {
      alert('Screen sharing only works on a desktop/laptop browser.\n\nOn your phone, use "View & Control" instead!');
      return;
    }
    showScreen('sharer-screen');
    initSharer();
  } else {
    showScreen('viewer-screen');
    initViewer();
  }
}

function goHome() {
  cleanup();
  showScreen('landing-screen');
}

// ═══════════════════════════════════════════════════════════
//  SHARER (LAPTOP) LOGIC
// ═══════════════════════════════════════════════════════════
function initSharer() {
  console.log('[Sharer] init');

  // 1. Generate room ID immediately
  const roomId = 'screen-' + uid(6);
  S.roomId = roomId;
  const peerId = PREFIX + roomId;

  // 2. Show room ID + QR RIGHT AWAY (no waiting for PeerJS)
  const display = $('room-id-display');
  if (display) display.textContent = roomId;
  renderQR(roomId);
  hide('room-waiting', true);
  hide('room-info', false);
  badge('sharer-status-badge', 'idle', 'Connecting…');

  console.log('[Sharer] Room ID:', roomId, '| Peer ID:', peerId);

  // 3. Connect to PeerJS broker
  try {
    S.peer = new Peer(peerId, PEERJS_CONFIG);
  } catch(e) {
    console.error('[Sharer] Peer() failed:', e);
    toast('⚠️ PeerJS error: ' + e.message);
    badge('sharer-status-badge', 'error', 'Error');
    return;
  }

  S.peer.on('open', id => {
    console.log('[Sharer] Peer open:', id);
    badge('sharer-status-badge', 'sharing', 'Ready — share QR with phone');
    toast('✅ Room ready!');
  });

  S.peer.on('connection', dc => handleDataConn(dc));
  S.peer.on('call',       call => handleCall(call));

  S.peer.on('error', err => {
    console.error('[Sharer] PeerJS error:', err.type, err);
    if (err.type === 'unavailable-id') {
      S.peer.destroy();
      initSharer();   // try new ID
    } else {
      badge('sharer-status-badge', 'error', 'Error — retrying…');
      setTimeout(() => { if (S.peer && !S.peer.destroyed) S.peer.reconnect(); }, 2000);
    }
  });

  S.peer.on('disconnected', () => {
    badge('sharer-status-badge', 'idle', 'Reconnecting…');
    if (S.peer && !S.peer.destroyed) S.peer.reconnect();
  });
}

function handleDataConn(dc) {
  const vid = dc.peer;
  dc.on('open', () => {
    if (!S.viewers[vid]) S.viewers[vid] = {};
    S.viewers[vid].dc = dc;
    updateDeviceList();
    dc.send({ type: 'welcome', remoteCtrl: S.remoteCtrl });
    badge('sharer-status-badge', 'connected', Object.keys(S.viewers).length + ' connected');
  });
  dc.on('data', msg => onSharerMsg(msg));
  dc.on('close', () => {
    delete S.viewers[vid];
    updateDeviceList();
    const n = Object.keys(S.viewers).length;
    badge('sharer-status-badge', n ? 'connected' : 'sharing', n ? n + ' connected' : 'Sharing');
  });
  dc.on('error', e => console.error('[Sharer] dc error:', e));
}

function handleCall(call) {
  if (!S.stream) { call.close(); return; }
  call.answer(S.stream);
  if (!S.viewers[call.peer]) S.viewers[call.peer] = {};
  S.viewers[call.peer].mc = call;
}

function onSharerMsg(msg) {
  if (!msg || !msg.type) return;
  if (msg.type === 'tap' && S.remoteCtrl) {
    flashClick(msg.x, msg.y);
    console.log(`[Sharer] Remote tap (${(msg.x*100).toFixed(1)}%, ${(msg.y*100).toFixed(1)}%)`);
  }
}

// ── Screen Share ───────────────────────────────────────────
async function startSharing() {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { cursor: 'always', frameRate: { ideal: 30 } },
      audio: false
    });
    S.stream = stream;

    const v = $('sharer-video');
    v.srcObject = stream;
    hide('sharer-placeholder', true);
    hide('sharer-video', false);
    $('stream-quality').textContent = 'Live';
    hide('btn-start-share', true);
    hide('btn-stop-share', false);
    badge('sharer-status-badge', 'sharing', 'Sharing');
    stream.getVideoTracks()[0].addEventListener('ended', stopSharing);
    notifyAll({ type: 'stream-started' });
    toast('Sharing started!');
  } catch(e) {
    console.error('[Sharer] getDisplayMedia:', e);
    const msg = e.name === 'NotAllowedError' ? 'Screen capture permission denied'
              : e.name === 'NotSupportedError' ? 'Screen sharing not supported here'
              : e.message;
    toast('⚠️ ' + msg);
  }
}

function stopSharing() {
  if (S.stream) { S.stream.getTracks().forEach(t => t.stop()); S.stream = null; }
  const v = $('sharer-video');
  v.srcObject = null;
  hide('sharer-video', true);
  hide('sharer-placeholder', false);
  $('stream-quality').textContent = '';
  hide('btn-stop-share', true);
  hide('btn-start-share', false);
  badge('sharer-status-badge', 'idle', 'Stopped');
  notifyAll({ type: 'stream-stopped' });
  toast('Sharing stopped');
}

function toggleRemoteControl() {
  S.remoteCtrl = !S.remoteCtrl;
  const t = $('remote-ctrl-toggle');
  t.setAttribute('data-enabled', S.remoteCtrl);
  hide('sharer-remote-status', !S.remoteCtrl);
  notifyAll({ type: 'remote-ctrl', enabled: S.remoteCtrl });
  toast(S.remoteCtrl ? '✅ Remote control ON' : '🔒 Remote control OFF');
}

function notifyAll(msg) {
  Object.values(S.viewers).forEach(v => { if (v.dc && v.dc.open) v.dc.send(msg); });
}

function flashClick(normX, normY) {
  const wrap = $('sharer-video-wrap');
  const flash = $('click-flash');
  if (!wrap || !flash) return;
  const r = wrap.getBoundingClientRect();
  flash.style.left = (normX * r.width) + 'px';
  flash.style.top  = (normY * r.height) + 'px';
  flash.classList.remove('hidden');
  flash.style.animation = 'none';
  requestAnimationFrame(() => { flash.style.animation = ''; });
  clearTimeout(flashClick._t);
  flashClick._t = setTimeout(() => flash.classList.add('hidden'), 600);
}

function updateDeviceList() {
  const list = $('device-list');
  const keys = Object.keys(S.viewers);
  list.innerHTML = keys.length
    ? keys.map((_, i) => `<div class="device-item"><div class="device-dot"></div><div class="device-name">Viewer ${i+1}</div><div class="device-role">📱 Remote</div></div>`).join('')
    : '<div class="no-devices">No devices connected yet</div>';
}

// ═══════════════════════════════════════════════════════════
//  VIEWER (PHONE) LOGIC
// ═══════════════════════════════════════════════════════════
function initViewer() {
  console.log('[Viewer] init');
  badge('viewer-status-badge', 'idle', 'Ready');
  S.peer = new Peer(PREFIX + 'v-' + uid(10), PEERJS_CONFIG);
  S.peer.on('open', id => console.log('[Viewer] Peer open:', id));
  S.peer.on('error', e => { console.error('[Viewer] error:', e); showViewerError('Connection error: ' + e.message); });
}

function connectToRoom() {
  let input = ($('room-input').value || '').trim();
  if (!input) { showViewerError('Please enter a room ID'); return; }

  // Accept full URL or just the ID
  if (input.includes('?room=')) {
    try { input = new URL(input).searchParams.get('room'); } catch {}
  }

  S.roomId = input;
  const hostId = PREFIX + input;
  hide('viewer-error', true);
  badge('viewer-status-badge', 'connected', 'Connecting…');
  $('viewer-status-text').textContent = 'Connecting to host…';

  const go = () => {
    const dc = S.peer.connect(hostId, { reliable: true });
    S.dataConn = dc;

    dc.on('open', () => {
      dc.send({ type: 'hello', id: S.peer.id });

      // Call sharer to get stream
      const silentStream = makeSilentStream();
      const call = S.peer.call(hostId, silentStream);
      S.hostConn = call;

      call.on('stream', remote => {
        const v = $('viewer-video');
        v.srcObject = remote;
        v.onloadedmetadata = () => v.play().catch(()=>{});
        badge('viewer-status-badge', 'sharing', 'Receiving');
        $('viewer-status-text').textContent = 'Receiving screen';
        hide('viewer-connect-panel', true);
        hide('viewer-live-panel', false);
        toast('Connected! Tap to control.');
      });

      call.on('close', () => { toast('Host ended sharing'); disconnectViewer(); });
      call.on('error', e => showViewerError('Stream error: ' + e.message));
    });

    dc.on('data', msg => onViewerMsg(msg));
    dc.on('close', () => { toast('Host disconnected'); disconnectViewer(); });
    dc.on('error', e => { console.error('[Viewer] dc error:', e); showViewerError('Could not connect. Check the room ID.'); });
  };

  if (S.peer && S.peer.id) go();
  else if (S.peer) S.peer.once('open', go);
  else showViewerError('Not ready — please refresh');
}

function makeSilentStream() {
  try {
    const ctx = new AudioContext();
    const dest = ctx.createMediaStreamDestination();
    ctx.createOscillator().connect(dest);
    return dest.stream;
  } catch {
    const c = document.createElement('canvas');
    c.width = 1; c.height = 1;
    return c.captureStream(1);
  }
}

function onViewerMsg(msg) {
  if (!msg || !msg.type) return;
  if (msg.type === 'welcome') updateTapHint(msg.remoteCtrl);
  if (msg.type === 'remote-ctrl') { updateTapHint(msg.enabled); toast(msg.enabled ? '🖱️ Control enabled' : '🔒 Control disabled'); }
  if (msg.type === 'stream-stopped') { badge('viewer-status-badge', 'idle', 'Paused'); $('viewer-status-text').textContent = 'Host paused sharing'; }
  if (msg.type === 'stream-started') { badge('viewer-status-badge', 'sharing', 'Receiving'); }
}

function updateTapHint(enabled) {
  const h = $('tap-hint');
  if (!h) return;
  h.innerHTML = enabled
    ? '<span class="tap-icon">🖱️</span><span>Tap to control laptop</span>'
    : '<span class="tap-icon">👁️</span><span>View only</span>';
}

function disconnectViewer() {
  if (S.hostConn) { S.hostConn.close(); S.hostConn = null; }
  if (S.dataConn) { S.dataConn.close(); S.dataConn = null; }
  $('viewer-video').srcObject = null;
  hide('viewer-live-panel', true);
  hide('viewer-connect-panel', false);
  badge('viewer-status-badge', 'idle', 'Disconnected');
}

function showViewerError(msg) {
  const el = $('viewer-error');
  if (el) { el.textContent = msg; hide(el, false); }
  badge('viewer-status-badge', 'error', 'Error');
}

// ── Tap overlay ────────────────────────────────────────────
function setupTapOverlay() {
  const overlay = $('tap-overlay');
  if (!overlay) return;

  const onTap = e => {
    e.preventDefault();
    const rect = overlay.getBoundingClientRect();
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    const cy = e.touches ? e.touches[0].clientY : e.clientY;
    const nx = (cx - rect.left) / rect.width;
    const ny = (cy - rect.top)  / rect.height;

    // Ripple
    const rip = $('tap-ripple');
    const wrap = $('viewer-video-wrap');
    if (rip && wrap) {
      const wr = wrap.getBoundingClientRect();
      rip.style.left = (cx - wr.left) + 'px';
      rip.style.top  = (cy - wr.top)  + 'px';
      rip.classList.remove('hidden');
      rip.style.animation = 'none';
      requestAnimationFrame(() => { rip.style.animation = ''; });
      clearTimeout(onTap._rt);
      onTap._rt = setTimeout(() => rip.classList.add('hidden'), 700);
    }

    // Fade hint
    const hint = $('tap-hint');
    if (hint) { hint.style.opacity = '0'; setTimeout(() => { hint.style.display='none'; }, 300); }

    if (S.dataConn && S.dataConn.open) {
      S.dataConn.send({ type: 'tap', x: nx, y: ny, screenW: rect.width, screenH: rect.height });
    }
  };

  overlay.addEventListener('click', onTap);
  overlay.addEventListener('touchstart', onTap, { passive: false });
}

// ── Cleanup ────────────────────────────────────────────────
function cleanup() {
  if (S.stream) { S.stream.getTracks().forEach(t => t.stop()); }
  if (S.peer && !S.peer.destroyed) S.peer.destroy();
  Object.assign(S, { role:null, peer:null, roomId:null, stream:null, viewers:{}, remoteCtrl:false, hostConn:null, dataConn:null });

  // Reset sharer UI
  const d = $('room-id-display'); if (d) d.textContent = '';
  const q = $('qr-container'); if (q) q.innerHTML = '';
  hide('room-waiting', false); hide('room-info', true);
  hide('btn-start-share', false); hide('btn-stop-share', true);
  const dl = $('device-list'); if (dl) dl.innerHTML = '<div class="no-devices">No devices connected yet</div>';
  const rt = $('remote-ctrl-toggle'); if (rt) rt.setAttribute('data-enabled', false);
  hide('sharer-remote-status', true);
  const sv = $('sharer-video'); if (sv) sv.srcObject = null;
  hide('sharer-video', true); hide('sharer-placeholder', false);

  // Reset viewer UI
  const ri = $('room-input'); if (ri) ri.value = '';
  hide('viewer-error', true);
  hide('viewer-connect-panel', false); hide('viewer-live-panel', true);
  const vv = $('viewer-video'); if (vv) vv.srcObject = null;
}

// ── Boot ───────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  setupTapOverlay();
  checkUrlParams();
  window.addEventListener('beforeunload', () => {
    if (S.peer && !S.peer.destroyed) S.peer.destroy();
  });
});
