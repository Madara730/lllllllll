/* ============================================================
   JumperCast — Application Logic
   WebRTC Screen Share + Remote Control via PeerJS
   ============================================================ */

'use strict';

// ── Constants ──────────────────────────────────────────────
const PEERJS_CONFIG = {
  // Uses PeerJS public cloud broker (free, no server needed)
  // For production reliability, consider hosting your own PeerJS server
  host: '0.peerjs.com',
  port: 443,
  secure: true,
  path: '/',
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      // Free TURN servers for NAT traversal (works across different networks)
      {
        urls: 'turn:openrelay.metered.ca:80',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      {
        urls: 'turn:openrelay.metered.ca:443',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      }
    ]
  }
};

const JUMPER_PREFIX = 'jc-';   // Room ID namespace prefix

// ── App State ──────────────────────────────────────────────
const State = {
  role: null,            // 'sharer' | 'viewer'
  peer: null,            // PeerJS Peer instance
  peerId: null,          // Our PeerJS ID
  roomId: null,          // Human-facing room ID (e.g. "screen-abc123")

  // Sharer state
  stream: null,          // MediaStream from getDisplayMedia
  connectedViewers: {},  // peerId → { conn, dataConn }
  remoteControlEnabled: false,
  sharingActive: false,

  // Viewer state
  hostConn: null,        // MediaConnection to sharer
  dataConn: null,        // DataConnection to sharer
};

// ── Utility helpers ────────────────────────────────────────
function uid(len = 6) {
  return Math.random().toString(36).slice(2, 2 + len);
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function showToast(msg, duration = 2800) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.remove('show'), duration);
}

function setStatusBadge(elementId, state, text) {
  const el = document.getElementById(elementId);
  el.className = `status-badge ${state}`;
  el.textContent = text;
}

function toggleHidden(el, hidden) {
  if (typeof el === 'string') el = document.getElementById(el);
  if (hidden) el.classList.add('hidden');
  else el.classList.remove('hidden');
}

// ── Role selection ─────────────────────────────────────────
function selectRole(role) {
  State.role = role;
  if (role === 'sharer') {
    initSharer();
    showScreen('sharer-screen');
  } else {
    initViewer();
    showScreen('viewer-screen');
  }
}

function goHome() {
  cleanup();
  showScreen('landing-screen');
}

// ── Generate unique room ID + PeerJS peer ID ───────────────
function makeRoomId() {
  return 'screen-' + uid(6);
}

function roomToPeerId(roomId) {
  // PeerJS peer ID = namespace prefix + room ID
  return JUMPER_PREFIX + roomId;
}

function peerIdToRoom(peerId) {
  return peerId.startsWith(JUMPER_PREFIX) ? peerId.slice(JUMPER_PREFIX.length) : peerId;
}

// ── QR Code ────────────────────────────────────────────────
function renderQR(text) {
  const container = document.getElementById('qr-container');
  container.innerHTML = '';
  const canvas = document.createElement('canvas');
  container.appendChild(canvas);
  QRCode.toCanvas(canvas, text, {
    width: 132,
    margin: 1,
    color: { dark: '#000000', light: '#ffffff' }
  }, err => {
    if (err) console.error('QR error:', err);
  });
}

// ── Copy helpers ───────────────────────────────────────────
function copyRoomId() {
  navigator.clipboard.writeText(State.roomId).then(() => showToast('Room ID copied!'));
}

function copyLink() {
  const url = buildShareUrl(State.roomId);
  navigator.clipboard.writeText(url).then(() => showToast('Link copied!'));
}

function buildShareUrl(roomId) {
  const base = window.location.origin + window.location.pathname;
  return `${base}?room=${encodeURIComponent(roomId)}`;
}

// ── Check URL params (phone scanning QR) ──────────────────
function checkUrlParams() {
  const params = new URLSearchParams(window.location.search);
  const room = params.get('room');
  if (room) {
    selectRole('viewer');
    document.getElementById('room-input').value = room;
    // Auto-connect after a short delay so peer is ready
    setTimeout(() => connectToRoom(), 800);
  }
}

// ══════════════════════════════════════════════════════════
//  SHARER (LAPTOP) LOGIC
// ══════════════════════════════════════════════════════════
function initSharer() {
  const roomId = makeRoomId();
  State.roomId = roomId;
  const myPeerId = roomToPeerId(roomId);

  setStatusBadge('sharer-status-badge', 'idle', 'Waiting…');

  State.peer = new Peer(myPeerId, PEERJS_CONFIG);

  State.peer.on('open', id => {
    console.log('[Sharer] Peer open:', id);
    // Reveal room info
    document.getElementById('room-id-display').textContent = roomId;
    renderQR(buildShareUrl(roomId));
    toggleHidden('room-waiting', true);
    toggleHidden('room-info', false);
    setStatusBadge('sharer-status-badge', 'sharing', 'Ready');
  });

  // Incoming DATA connections (control channel from viewers)
  State.peer.on('connection', dataConn => {
    handleIncomingDataConnection(dataConn);
  });

  // Incoming CALL connections (viewers request stream)
  State.peer.on('call', call => {
    handleIncomingCall(call);
  });

  State.peer.on('error', err => {
    console.error('[Sharer] PeerJS error:', err);
    if (err.type === 'unavailable-id') {
      // ID taken — try a new one
      State.peer.destroy();
      initSharer();
    } else {
      showToast('Connection error: ' + err.message);
      setStatusBadge('sharer-status-badge', 'error', 'Error');
    }
  });

  State.peer.on('disconnected', () => {
    console.warn('[Sharer] Peer disconnected, reconnecting…');
    if (!State.peer.destroyed) State.peer.reconnect();
  });
}

function handleIncomingDataConnection(dataConn) {
  const viewerPeerId = dataConn.peer;
  console.log('[Sharer] Data connection from:', viewerPeerId);

  dataConn.on('open', () => {
    // Register viewer
    if (!State.connectedViewers[viewerPeerId]) {
      State.connectedViewers[viewerPeerId] = { dataConn };
    } else {
      State.connectedViewers[viewerPeerId].dataConn = dataConn;
    }
    updateDeviceList();
    dataConn.send({ type: 'welcome', remoteControlEnabled: State.remoteControlEnabled });
    setStatusBadge('sharer-status-badge', 'connected',
      `${Object.keys(State.connectedViewers).length} connected`);
  });

  dataConn.on('data', msg => {
    handleSharerMessage(msg, viewerPeerId);
  });

  dataConn.on('close', () => {
    delete State.connectedViewers[viewerPeerId];
    updateDeviceList();
    const count = Object.keys(State.connectedViewers).length;
    setStatusBadge('sharer-status-badge',
      count > 0 ? 'connected' : 'sharing',
      count > 0 ? `${count} connected` : 'Sharing');
    showToast('A viewer disconnected');
  });

  dataConn.on('error', err => console.error('[Sharer] DataConn error:', err));
}

function handleIncomingCall(call) {
  const viewerPeerId = call.peer;
  console.log('[Sharer] Incoming call from:', viewerPeerId);

  if (!State.stream) {
    console.warn('[Sharer] No stream to answer call with');
    call.close();
    return;
  }

  call.answer(State.stream);

  if (!State.connectedViewers[viewerPeerId]) {
    State.connectedViewers[viewerPeerId] = {};
  }
  State.connectedViewers[viewerPeerId].mediaConn = call;

  call.on('close', () => {
    if (State.connectedViewers[viewerPeerId]) {
      delete State.connectedViewers[viewerPeerId].mediaConn;
    }
  });
}

function handleSharerMessage(msg, fromPeerId) {
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case 'tap':
      if (State.remoteControlEnabled) {
        simulateClick(msg.x, msg.y, msg.screenW, msg.screenH);
      }
      break;
    case 'scroll':
      if (State.remoteControlEnabled) {
        // Scroll is visual-only feedback in browser context
        // (actual scroll simulation requires native app; we show feedback)
        showClickFlash(msg.x, msg.y);
      }
      break;
  }
}

// ── Screen Sharing ────────────────────────────────────────
async function startSharing() {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        cursor: 'always',
        frameRate: { ideal: 30, max: 30 },
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      },
      audio: false
    });

    State.stream = stream;
    State.sharingActive = true;

    // Show preview
    const video = document.getElementById('sharer-video');
    video.srcObject = stream;
    toggleHidden('sharer-placeholder', true);
    toggleHidden('sharer-video', false);
    document.getElementById('stream-quality').textContent = 'Live';

    // Update buttons
    toggleHidden('btn-start-share', true);
    toggleHidden('btn-stop-share', false);
    setStatusBadge('sharer-status-badge', 'sharing', 'Sharing');

    // Handle user stopping via browser UI
    stream.getVideoTracks()[0].addEventListener('ended', () => {
      stopSharing();
    });

    // Notify any already-connected viewers
    notifyViewers({ type: 'stream-started' });

    showToast('Screen sharing started!');
  } catch (err) {
    console.error('[Sharer] getDisplayMedia error:', err);
    if (err.name === 'NotAllowedError') {
      showToast('Permission denied — please allow screen sharing');
    } else if (err.name === 'NotSupportedError') {
      showToast('Screen sharing not supported in this browser');
    } else {
      showToast('Failed to start sharing: ' + err.message);
    }
  }
}

function stopSharing() {
  if (State.stream) {
    State.stream.getTracks().forEach(t => t.stop());
    State.stream = null;
  }
  State.sharingActive = false;

  const video = document.getElementById('sharer-video');
  video.srcObject = null;
  toggleHidden('sharer-video', true);
  toggleHidden('sharer-placeholder', false);
  document.getElementById('stream-quality').textContent = '';

  toggleHidden('btn-stop-share', true);
  toggleHidden('btn-start-share', false);
  setStatusBadge('sharer-status-badge', 'idle', 'Stopped');

  notifyViewers({ type: 'stream-stopped' });
  showToast('Sharing stopped');
}

// ── Remote Control ────────────────────────────────────────
function toggleRemoteControl() {
  State.remoteControlEnabled = !State.remoteControlEnabled;
  const toggle = document.getElementById('remote-ctrl-toggle');
  toggle.setAttribute('data-enabled', State.remoteControlEnabled);
  const bar = document.getElementById('sharer-remote-status');
  toggleHidden(bar, !State.remoteControlEnabled);

  notifyViewers({ type: 'remote-control-changed', enabled: State.remoteControlEnabled });
  showToast(State.remoteControlEnabled
    ? '✅ Remote control enabled'
    : '🔒 Remote control disabled');
}

function notifyViewers(msg) {
  Object.values(State.connectedViewers).forEach(viewer => {
    if (viewer.dataConn && viewer.dataConn.open) {
      viewer.dataConn.send(msg);
    }
  });
}

// ── Simulate click on laptop screen ──────────────────────
function simulateClick(normX, normY, senderW, senderH) {
  // normX, normY are 0..1 ratios of the viewer's video dimensions
  // We show a flash on our local preview at the same ratio
  const videoEl = document.getElementById('sharer-video');
  const rect = videoEl.getBoundingClientRect();
  const flashX = rect.left + normX * rect.width;
  const flashY = rect.top + normY * rect.height;
  showClickFlash(flashX, flashY);

  // In a pure browser app we can't programmatically move the OS cursor.
  // This would require a native helper (e.g., Electron, Tauri, PyAutoGUI).
  // We show visual feedback + a browser-level click on the video element.
  console.log(`[Sharer] Remote click at (${(normX*100).toFixed(1)}%, ${(normY*100).toFixed(1)}%)`);
}

function showClickFlash(x, y) {
  const flash = document.getElementById('click-flash');
  const wrap = document.getElementById('sharer-video-wrap');
  const rect = wrap.getBoundingClientRect();

  // Convert absolute coords to wrap-relative
  const relX = typeof x === 'number' ? x - rect.left : 0;
  const relY = typeof y === 'number' ? y - rect.top : 0;

  flash.style.left = relX + 'px';
  flash.style.top = relY + 'px';
  flash.classList.remove('hidden');
  flash.style.animation = 'none';
  requestAnimationFrame(() => {
    flash.style.animation = '';
    flash.classList.remove('hidden');
  });
  clearTimeout(showClickFlash._t);
  showClickFlash._t = setTimeout(() => flash.classList.add('hidden'), 600);
}

// ── Device list UI ────────────────────────────────────────
function updateDeviceList() {
  const list = document.getElementById('device-list');
  const viewers = Object.keys(State.connectedViewers);

  if (viewers.length === 0) {
    list.innerHTML = '<div class="no-devices">No devices connected yet</div>';
    return;
  }

  list.innerHTML = viewers.map((pid, i) => `
    <div class="device-item">
      <div class="device-dot"></div>
      <div class="device-name">Viewer ${i + 1}</div>
      <div class="device-role">📱 Remote</div>
    </div>
  `).join('');
}

// ══════════════════════════════════════════════════════════
//  VIEWER (PHONE) LOGIC
// ══════════════════════════════════════════════════════════
function initViewer() {
  // Viewer gets a random peer ID (not a room ID)
  State.peer = new Peer(JUMPER_PREFIX + 'v-' + uid(10), PEERJS_CONFIG);

  State.peer.on('open', id => {
    console.log('[Viewer] Peer open:', id);
  });

  State.peer.on('error', err => {
    console.error('[Viewer] PeerJS error:', err);
    showViewerError('Connection error: ' + err.message);
  });
}

function connectToRoom() {
  const input = document.getElementById('room-input').value.trim();
  if (!input) {
    showViewerError('Please enter a room ID');
    return;
  }

  // Support entering just the ID or the full URL
  let roomId = input;
  if (input.includes('?room=')) {
    try { roomId = new URL(input).searchParams.get('room'); } catch {}
  }

  State.roomId = roomId;
  const hostPeerId = roomToPeerId(roomId);

  toggleHidden('viewer-error', true);
  setStatusBadge('viewer-status-badge', 'connected', 'Connecting…');
  document.getElementById('viewer-status-text').textContent = 'Connecting to host…';

  // Wait for peer to be ready
  const doConnect = () => {
    // 1. Open data channel
    const dataConn = State.peer.connect(hostPeerId, { reliable: true });
    State.dataConn = dataConn;

    dataConn.on('open', () => {
      console.log('[Viewer] Data channel open');
      dataConn.send({ type: 'viewer-hello', viewerId: State.peer.id });

      // 2. Call to request stream
      const call = State.peer.call(hostPeerId, createSilentStream());
      State.hostConn = call;

      call.on('stream', remoteStream => {
        console.log('[Viewer] Got stream');
        const video = document.getElementById('viewer-video');
        video.srcObject = remoteStream;
        video.onloadedmetadata = () => video.play().catch(() => {});

        setStatusBadge('viewer-status-badge', 'sharing', 'Receiving');
        document.getElementById('viewer-status-text').textContent = 'Receiving screen';

        // Switch to live panel
        toggleHidden('viewer-connect-panel', true);
        toggleHidden('viewer-live-panel', false);
        showToast('Connected! Tap to control.');
      });

      call.on('close', () => {
        showToast('Host ended sharing');
        disconnectViewer();
      });

      call.on('error', err => {
        console.error('[Viewer] Call error:', err);
        showViewerError('Stream error: ' + err.message);
      });
    });

    dataConn.on('data', msg => {
      handleViewerMessage(msg);
    });

    dataConn.on('close', () => {
      showToast('Host disconnected');
      disconnectViewer();
    });

    dataConn.on('error', err => {
      console.error('[Viewer] DataConn error:', err);
      showViewerError('Connection failed. Is the room ID correct?');
      setStatusBadge('viewer-status-badge', 'error', 'Error');
    });
  };

  if (State.peer && State.peer.id) {
    doConnect();
  } else if (State.peer) {
    State.peer.on('open', doConnect);
  } else {
    showViewerError('Peer not ready — please refresh');
  }
}

// PeerJS requires us to "call" with a stream — send silence/blank if we have no stream
function createSilentStream() {
  try {
    const ctx = new AudioContext();
    const dest = ctx.createMediaStreamDestination();
    const osc = ctx.createOscillator();
    osc.connect(dest);
    osc.start();
    // Return just the audio stream (no video needed from viewer side)
    return dest.stream;
  } catch {
    // Fallback: create empty video stream
    const canvas = document.createElement('canvas');
    canvas.width = 1; canvas.height = 1;
    return canvas.captureStream(1);
  }
}

function handleViewerMessage(msg) {
  if (!msg || !msg.type) return;
  switch (msg.type) {
    case 'welcome':
      console.log('[Viewer] Welcome, remote control:', msg.remoteControlEnabled);
      updateTapOverlayHint(msg.remoteControlEnabled);
      break;
    case 'remote-control-changed':
      updateTapOverlayHint(msg.enabled);
      showToast(msg.enabled ? '🖱️ Remote control enabled by host' : '🔒 Remote control disabled');
      break;
    case 'stream-stopped':
      showToast('Host stopped sharing');
      document.getElementById('viewer-video').srcObject = null;
      setStatusBadge('viewer-status-badge', 'idle', 'Paused');
      document.getElementById('viewer-status-text').textContent = 'Host paused sharing';
      break;
    case 'stream-started':
      setStatusBadge('viewer-status-badge', 'sharing', 'Receiving');
      document.getElementById('viewer-status-text').textContent = 'Receiving screen';
      break;
  }
}

function updateTapOverlayHint(remoteEnabled) {
  const hint = document.getElementById('tap-hint');
  if (remoteEnabled) {
    hint.innerHTML = '<span class="tap-icon">🖱️</span><span>Tap to control laptop</span>';
  } else {
    hint.innerHTML = '<span class="tap-icon">👁️</span><span>View only — remote control off</span>';
  }
}

function disconnectViewer() {
  if (State.hostConn) { State.hostConn.close(); State.hostConn = null; }
  if (State.dataConn) { State.dataConn.close(); State.dataConn = null; }

  const video = document.getElementById('viewer-video');
  video.srcObject = null;

  toggleHidden('viewer-live-panel', true);
  toggleHidden('viewer-connect-panel', false);
  setStatusBadge('viewer-status-badge', 'idle', 'Disconnected');
}

function showViewerError(msg) {
  const el = document.getElementById('viewer-error');
  el.textContent = msg;
  toggleHidden(el, false);
  setStatusBadge('viewer-status-badge', 'error', 'Error');
}

// ── Tap-to-control ────────────────────────────────────────
function setupTapOverlay() {
  const overlay = document.getElementById('tap-overlay');

  const sendTap = (e) => {
    e.preventDefault();
    const rect = overlay.getBoundingClientRect();

    let clientX, clientY;
    if (e.touches && e.touches.length > 0) {
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }

    const normX = (clientX - rect.left) / rect.width;
    const normY = (clientY - rect.top) / rect.height;

    // Show ripple
    showTapRipple(clientX, clientY);

    // Fade hint after first tap
    const hint = document.getElementById('tap-hint');
    if (hint) hint.style.opacity = '0';
    setTimeout(() => { if (hint) hint.style.display = 'none'; }, 300);

    if (State.dataConn && State.dataConn.open) {
      State.dataConn.send({
        type: 'tap',
        x: normX,
        y: normY,
        screenW: rect.width,
        screenH: rect.height
      });
    }
  };

  overlay.addEventListener('click', sendTap);
  overlay.addEventListener('touchstart', sendTap, { passive: false });
}

function showTapRipple(clientX, clientY) {
  const ripple = document.getElementById('tap-ripple');
  const wrap = document.getElementById('viewer-video-wrap');
  const rect = wrap.getBoundingClientRect();

  ripple.style.left = (clientX - rect.left) + 'px';
  ripple.style.top  = (clientY - rect.top) + 'px';
  ripple.classList.remove('hidden');
  ripple.style.animation = 'none';
  requestAnimationFrame(() => {
    ripple.style.animation = '';
  });
  clearTimeout(showTapRipple._t);
  showTapRipple._t = setTimeout(() => ripple.classList.add('hidden'), 700);
}

// ── Cleanup ───────────────────────────────────────────────
function cleanup() {
  if (State.stream) {
    State.stream.getTracks().forEach(t => t.stop());
    State.stream = null;
  }
  if (State.peer && !State.peer.destroyed) {
    State.peer.destroy();
    State.peer = null;
  }
  Object.assign(State, {
    role: null,
    peerId: null,
    roomId: null,
    connectedViewers: {},
    remoteControlEnabled: false,
    sharingActive: false,
    hostConn: null,
    dataConn: null
  });

  // Reset sharer UI
  document.getElementById('room-id-display').textContent = '';
  document.getElementById('qr-container').innerHTML = '';
  toggleHidden('room-waiting', false);
  toggleHidden('room-info', true);
  toggleHidden('btn-start-share', false);
  toggleHidden('btn-stop-share', true);
  document.getElementById('device-list').innerHTML = '<div class="no-devices">No devices connected yet</div>';
  const toggle = document.getElementById('remote-ctrl-toggle');
  toggle.setAttribute('data-enabled', false);
  toggleHidden('sharer-remote-status', true);
  const sharerVideo = document.getElementById('sharer-video');
  sharerVideo.srcObject = null;
  toggleHidden('sharer-video', true);
  toggleHidden('sharer-placeholder', false);

  // Reset viewer UI
  document.getElementById('room-input').value = '';
  toggleHidden('viewer-error', true);
  toggleHidden('viewer-connect-panel', false);
  toggleHidden('viewer-live-panel', true);
  const viewerVideo = document.getElementById('viewer-video');
  viewerVideo.srcObject = null;
}

// ── Init ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Setup tap overlay (always, it's hidden until viewer mode)
  setupTapOverlay();

  // Check if we arrived via QR / shared link
  checkUrlParams();

  // Clean up peer on page unload
  window.addEventListener('beforeunload', () => {
    if (State.peer && !State.peer.destroyed) State.peer.destroy();
  });
});
