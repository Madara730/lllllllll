/* ============================================================
   JumperCast — Application Logic v4
   FIX: Sharer calls viewer (not viewer calling sharer)
   ============================================================ */

'use strict';

const PEERJS_CONFIG = {
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'turn:openrelay.metered.ca:80',  username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' }
    ]
  }
};

const PREFIX = 'jc-';

const S = {
  role: null, peer: null, roomId: null,
  stream: null, viewers: {}, remoteCtrl: false,
  hostConn: null, dataConn: null
};

const uid  = (n=6) => Math.random().toString(36).slice(2, 2+n);
const $    = id => document.getElementById(id);
const hide = (id, v) => { const el = typeof id==='string' ? $(id) : id; if(el) el.classList.toggle('hidden', !!v); };

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = $(id);
  if (el) el.classList.add('active');
}

function toast(msg, ms=3200) {
  const el = $('toast');
  if (!el) return;
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
  return location.origin + location.pathname + '?room=' + encodeURIComponent(roomId);
}

function renderQR(roomId) {
  const box = $('qr-container');
  if (!box) return;
  box.innerHTML = '';
  if (typeof QRCode === 'undefined') {
    box.innerHTML = '<p style="color:#6b7280;font-size:.8rem;text-align:center;padding:8px">QR unavailable<br>Copy link below</p>';
    return;
  }
  const canvas = document.createElement('canvas');
  box.appendChild(canvas);
  QRCode.toCanvas(canvas, buildUrl(roomId), { width: 132, margin: 1, color: { dark:'#000', light:'#fff' } }, e => {
    if (e) console.warn('QR:', e);
  });
}

function copyRoomId() {
  if (S.roomId) navigator.clipboard.writeText(S.roomId).then(() => toast('Room ID copied!'));
}
function copyLink() {
  if (S.roomId) navigator.clipboard.writeText(buildUrl(S.roomId)).then(() => toast('Link copied! Send to phone.'));
}

function checkUrlParams() {
  const room = new URLSearchParams(location.search).get('room');
  if (room) {
    selectRole('viewer');
    const inp = $('room-input');
    if (inp) inp.value = room;
    setTimeout(() => connectToRoom(), 1200);
  }
}

// ═══════════════════════════════════════════════════════════
//  ROLE SELECTION
// ═══════════════════════════════════════════════════════════
function selectRole(role) {
  console.log('[JC] selectRole:', role);
  if (typeof Peer === 'undefined') {
    alert('PeerJS library failed to load. Please check your internet and refresh.');
    return;
  }
  S.role = role;
  if (role === 'sharer') {
    if (isMobile()) {
      alert('Screen sharing only works on desktop/laptop.\n\nOn your phone, use "View & Control" instead!');
      return;
    }
    showScreen('sharer-screen');
    initSharer();
  } else {
    showScreen('viewer-screen');
    initViewer();
  }
}

function goHome() { cleanup(); showScreen('landing-screen'); }

// ═══════════════════════════════════════════════════════════
//  SHARER — laptop side
// ═══════════════════════════════════════════════════════════
function initSharer() {
  const roomId = 'screen-' + uid(6);
  S.roomId = roomId;
  const peerId = PREFIX + roomId;

  // Show Room ID + QR immediately
  const disp = $('room-id-display');
  if (disp) disp.textContent = roomId;
  renderQR(roomId);
  hide('room-waiting', true);
  hide('room-info', false);
  badge('sharer-status-badge', 'idle', 'Connecting to broker…');
  console.log('[Sharer] Room:', roomId);

  S.peer = new Peer(peerId, PEERJS_CONFIG);

  S.peer.on('open', id => {
    console.log('[Sharer] Peer open:', id);
    badge('sharer-status-badge', 'sharing', 'Ready — share QR with phone');
    toast('✅ Room ready! Share the QR or link.');
  });

  // ── Incoming DATA connection from viewer ──────────────────
  S.peer.on('connection', dc => {
    const vid = dc.peer;
    console.log('[Sharer] Viewer data conn:', vid);

    dc.on('open', () => {
      if (!S.viewers[vid]) S.viewers[vid] = {};
      S.viewers[vid].dc = dc;
      updateDeviceList();

      const count = Object.keys(S.viewers).length;
      badge('sharer-status-badge', 'connected', count + ' connected');

      // Tell viewer about remote control state
      dc.send({ type: 'welcome', remoteCtrl: S.remoteCtrl });

      // ✅ KEY FIX: Sharer calls viewer with the stream
      if (S.stream) {
        console.log('[Sharer] Calling viewer with stream:', vid);
        callViewer(vid);
      } else {
        // No stream yet — tell viewer to wait
        dc.send({ type: 'wait-for-stream' });
        console.log('[Sharer] No stream yet, viewer will wait');
      }
    });

    dc.on('data', msg => {
      if (!msg) return;
      if (msg.type === 'tap' && S.remoteCtrl) flashClick(msg.x, msg.y);
      if (msg.type === 'request-stream' && S.stream) callViewer(vid);
    });

    dc.on('close', () => {
      delete S.viewers[vid];
      updateDeviceList();
      const n = Object.keys(S.viewers).length;
      badge('sharer-status-badge', n ? 'connected' : 'sharing', n ? n + ' connected' : 'Sharing');
    });
  });

  S.peer.on('error', err => {
    console.error('[Sharer] error:', err.type, err.message);
    if (err.type === 'unavailable-id') { S.peer.destroy(); initSharer(); }
    else { badge('sharer-status-badge', 'error', 'Error'); toast('⚠️ ' + err.message); }
  });

  S.peer.on('disconnected', () => {
    badge('sharer-status-badge', 'idle', 'Reconnecting…');
    if (S.peer && !S.peer.destroyed) S.peer.reconnect();
  });
}

// Sharer calls a specific viewer peer with the screen stream
function callViewer(viewerPeerId) {
  if (!S.stream || !S.peer) return;
  console.log('[Sharer] Calling viewer:', viewerPeerId);
  const call = S.peer.call(viewerPeerId, S.stream);
  if (S.viewers[viewerPeerId]) S.viewers[viewerPeerId].mc = call;
  call.on('error', e => console.error('[Sharer] call error:', e));
}

// ── Screen Sharing ─────────────────────────────────────────
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
    badge('sharer-status-badge', 'sharing',
      Object.keys(S.viewers).length ? Object.keys(S.viewers).length + ' connected' : 'Sharing');

    stream.getVideoTracks()[0].addEventListener('ended', stopSharing);

    // ✅ Call ALL viewers that are already connected but waiting
    Object.keys(S.viewers).forEach(vid => {
      console.log('[Sharer] Stream started — calling waiting viewer:', vid);
      callViewer(vid);
      const dc = S.viewers[vid].dc;
      if (dc && dc.open) dc.send({ type: 'stream-started' });
    });

    toast('Sharing started!');
  } catch(e) {
    const msg = e.name === 'NotAllowedError' ? 'Screen capture permission denied'
              : e.name === 'NotSupportedError' ? 'Not supported in this browser'
              : e.message;
    toast('⚠️ ' + msg);
  }
}

function stopSharing() {
  if (S.stream) { S.stream.getTracks().forEach(t => t.stop()); S.stream = null; }
  const v = $('sharer-video');
  if (v) v.srcObject = null;
  hide('sharer-video', true); hide('sharer-placeholder', false);
  $('stream-quality').textContent = '';
  hide('btn-stop-share', true); hide('btn-start-share', false);
  badge('sharer-status-badge', 'idle', 'Stopped');
  Object.values(S.viewers).forEach(vw => { if (vw.dc && vw.dc.open) vw.dc.send({ type: 'stream-stopped' }); });
  toast('Sharing stopped');
}

function toggleRemoteControl() {
  S.remoteCtrl = !S.remoteCtrl;
  const t = $('remote-ctrl-toggle');
  if (t) t.setAttribute('data-enabled', S.remoteCtrl);
  hide('sharer-remote-status', !S.remoteCtrl);
  Object.values(S.viewers).forEach(vw => { if (vw.dc && vw.dc.open) vw.dc.send({ type: 'remote-ctrl', enabled: S.remoteCtrl }); });
  toast(S.remoteCtrl ? '✅ Remote control ON' : '🔒 Remote control OFF');
}

function flashClick(normX, normY) {
  const wrap = $('sharer-video-wrap'), flash = $('click-flash');
  if (!wrap || !flash) return;
  const r = wrap.getBoundingClientRect();
  flash.style.left = (normX * r.width) + 'px';
  flash.style.top  = (normY * r.height) + 'px';
  flash.classList.remove('hidden');
  flash.style.animation = 'none';
  requestAnimationFrame(() => { flash.style.animation = ''; });
  clearTimeout(flashClick._t);
  flashClick._t = setTimeout(() => flash.classList.add('hidden'), 600);

  // Send to local host proxy for OS-level control
  fetch('http://localhost:4000/click', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ x: normX, y: normY })
  }).catch(err => {
    console.warn('[Sharer] Failed to reach local host proxy (is it running?)', err);
  });
}

function updateDeviceList() {
  const list = $('device-list');
  if (!list) return;
  const keys = Object.keys(S.viewers);
  list.innerHTML = keys.length
    ? keys.map((_, i) => `<div class="device-item"><div class="device-dot"></div><div class="device-name">Viewer ${i+1}</div><div class="device-role">📱 Remote</div></div>`).join('')
    : '<div class="no-devices">No devices connected yet</div>';
}

// ═══════════════════════════════════════════════════════════
//  VIEWER — phone side
// ═══════════════════════════════════════════════════════════
function initViewer() {
  console.log('[Viewer] init');
  badge('viewer-status-badge', 'idle', 'Ready');
  S.peer = new Peer(PREFIX + 'v-' + uid(10), PEERJS_CONFIG);
  S.peer.on('open', id => console.log('[Viewer] Peer open:', id));
  S.peer.on('error', e => { console.error('[Viewer] error:', e); showViewerError('Connection error: ' + e.message); badge('viewer-status-badge','error','Error'); });
}

function connectToRoom() {
  let input = ($('room-input').value || '').trim();
  if (!input) { showViewerError('Please enter a room ID'); return; }
  if (input.includes('?room=')) {
    try { input = new URL(input).searchParams.get('room'); } catch {}
  }
  S.roomId = input;
  const hostId = PREFIX + input;

  hide('viewer-error', true);
  badge('viewer-status-badge', 'connected', 'Connecting…');
  $('viewer-status-text').textContent = 'Connecting to host…';

  const go = () => {
    console.log('[Viewer] Connecting to host:', hostId);

    // 1. Open data channel to sharer
    const dc = S.peer.connect(hostId, { reliable: true });
    S.dataConn = dc;

    dc.on('open', () => {
      console.log('[Viewer] Data channel open');
      badge('viewer-status-badge', 'connected', 'Waiting for stream…');
      $('viewer-status-text').textContent = 'Waiting for screen stream…';
      dc.send({ type: 'hello', id: S.peer.id });
    });

    dc.on('data', msg => onViewerMsg(msg));
    dc.on('close', () => { toast('Host disconnected'); disconnectViewer(); });
    dc.on('error', e => { console.error('[Viewer] dc error:', e); showViewerError('Could not reach host. Is the Room ID correct?'); });

    // 2. ✅ Viewer ANSWERS incoming call from sharer (does NOT call sharer)
    S.peer.on('call', call => {
      console.log('[Viewer] Incoming call from sharer — answering');
      badge('viewer-status-badge', 'connected', 'Receiving stream…');
      $('viewer-status-text').textContent = 'Receiving stream…';

      call.answer(); // answer with no stream — viewer just watches

      call.on('stream', remote => {
        console.log('[Viewer] Got stream!');
        const v = $('viewer-video');
        if (v) v.muted = true; // Mobile Safari/Chrome require muted for autoplay
        v.srcObject = remote;
        v.onloadedmetadata = () => v.play().catch(e => console.warn('play:', e));

        badge('viewer-status-badge', 'sharing', 'Receiving ✅');
        $('viewer-status-text').textContent = 'Receiving screen';
        hide('viewer-connect-panel', true);
        hide('viewer-live-panel', false);
        toast('Connected! Tap anywhere to control.');
      });

      call.on('close', () => { toast('Stream ended'); disconnectViewer(); });
      call.on('error', e => { console.error('[Viewer] call error:', e); showViewerError('Stream error: ' + e.message); });
    });
  };

  if (S.peer && S.peer.id) go();
  else if (S.peer) S.peer.once('open', go);
  else showViewerError('Not ready — please refresh');
}

function onViewerMsg(msg) {
  if (!msg || !msg.type) return;
  if (msg.type === 'welcome')      { updateTapHint(msg.remoteCtrl); }
  if (msg.type === 'remote-ctrl')  { updateTapHint(msg.enabled); toast(msg.enabled ? '🖱️ Control enabled' : '🔒 Control disabled'); }
  if (msg.type === 'stream-stopped') { $('viewer-status-text').textContent = 'Host paused sharing'; badge('viewer-status-badge','idle','Paused'); }
  if (msg.type === 'stream-started') { $('viewer-status-text').textContent = 'Stream resuming…'; }
  if (msg.type === 'wait-for-stream') { $('viewer-status-text').textContent = 'Waiting — host hasn\'t shared yet'; toast('Host hasn\'t clicked Share Screen yet'); }
}

function updateTapHint(enabled) {
  const h = $('tap-hint');
  if (!h) return;
  h.innerHTML = enabled
    ? '<span class="tap-icon">🖱️</span><span>Tap to control laptop</span>'
    : '<span class="tap-icon">👁️</span><span>View only</span>';
}

function disconnectViewer() {
  if (S.hostConn) { try { S.hostConn.close(); } catch {} S.hostConn = null; }
  if (S.dataConn) { try { S.dataConn.close(); } catch {} S.dataConn = null; }
  const v = $('viewer-video'); if (v) v.srcObject = null;
  hide('viewer-live-panel', true);
  hide('viewer-connect-panel', false);
  badge('viewer-status-badge', 'idle', 'Disconnected');
}

function showViewerError(msg) {
  const el = $('viewer-error');
  if (el) { el.textContent = msg; hide(el, false); }
}

// ── Tap overlay ────────────────────────────────────────────
function setupTapOverlay() {
  const overlay = $('tap-overlay');
  if (!overlay) return;
  const onTap = e => {
    e.preventDefault();
    const video = $('viewer-video');
    const rect = overlay.getBoundingClientRect();
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    const cy = e.touches ? e.touches[0].clientY : e.clientY;

    let nx = 0, ny = 0;
    if (video && video.videoWidth && video.videoHeight) {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      const cw = rect.width;
      const ch = rect.height;

      const containerRatio = cw / ch;
      const videoRatio = vw / vh;
      
      let renderedW = cw, renderedH = ch, offsetX = 0, offsetY = 0;

      if (containerRatio > videoRatio) {
        // Pillarboxed (black bars left/right)
        renderedH = ch;
        renderedW = ch * videoRatio;
        offsetX = (cw - renderedW) / 2;
      } else {
        // Letterboxed (black bars top/bottom)
        renderedW = cw;
        renderedH = cw / videoRatio;
        offsetY = (ch - renderedH) / 2;
      }

      const tapX = cx - rect.left - offsetX;
      const tapY = cy - rect.top - offsetY;

      nx = Math.max(0, Math.min(1, tapX / renderedW));
      ny = Math.max(0, Math.min(1, tapY / renderedH));
    } else {
      // Fallback
      nx = (cx - rect.left) / rect.width;
      ny = (cy - rect.top)  / rect.height;
    }

    const rip = $('tap-ripple'), wrap = $('viewer-video-wrap');
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

    const hint = $('tap-hint');
    if (hint) { hint.style.opacity = '0'; setTimeout(() => { hint.style.display='none'; }, 300); }

    if (S.dataConn && S.dataConn.open) {
      S.dataConn.send({ type: 'tap', x: nx, y: ny });
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

  const d = $('room-id-display'); if (d) d.textContent = '';
  const q = $('qr-container'); if (q) q.innerHTML = '';
  hide('room-waiting', false); hide('room-info', true);
  hide('btn-start-share', false); hide('btn-stop-share', true);
  const dl = $('device-list'); if (dl) dl.innerHTML = '<div class="no-devices">No devices connected yet</div>';
  const rt = $('remote-ctrl-toggle'); if (rt) rt.setAttribute('data-enabled', false);
  hide('sharer-remote-status', true);
  const sv = $('sharer-video'); if (sv) sv.srcObject = null;
  hide('sharer-video', true); hide('sharer-placeholder', false);

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
