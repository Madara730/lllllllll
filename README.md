# JumperCast 🖥️📱

> Real-time screen sharing + remote control in your browser. No tunnels, no IPs, no backend.

## How It Works

```
Laptop  ──PeerJS WebRTC──►  Phone
  │                            │
  │◄── tap coordinates ────────┘
  │
  └── shows click flash on screen
```

1. **Laptop** opens the site → clicks "Share Screen"
2. A unique room ID + QR code appears instantly
3. **Phone** scans QR (or visits the link)
4. WebRTC peer connection established via PeerJS broker
5. Laptop sends screen stream → Phone receives live video
6. Phone taps the video → coordinates sent back → Laptop shows click flash

## Quick Start (Local Dev)

```bash
npm run dev
# Opens on http://localhost:3000
```

Then open two browser tabs (or laptop + phone on same WiFi):
- Tab 1 → "Share Screen" → start sharing
- Tab 2 → "View & Control" → enter room ID

## Deploy to Vercel (One Command)

```bash
npm run deploy
# or
npx vercel --prod
```

That's it. No env vars, no configuration, no backend.

## Tech Stack

| Layer | Technology |
|---|---|
| P2P Signaling | PeerJS (public cloud broker) |
| Screen Capture | `navigator.mediaDevices.getDisplayMedia()` |
| Video Streaming | WebRTC via `peer.call()` / `call.answer()` |
| Control Channel | PeerJS DataConnection |
| QR Code | `qrcode.js` |
| Hosting | Vercel (static) |
| Backend | **None** |

## Browser Support

| Feature | Chrome | Firefox | Safari | Edge |
|---|---|---|---|---|
| Screen Share (getDisplayMedia) | ✅ | ✅ | ✅ 13+ | ✅ |
| WebRTC | ✅ | ✅ | ✅ | ✅ |
| Tap Control | ✅ | ✅ | ✅ | ✅ |

> ⚠️ **Note on Remote Click Simulation**  
> Browsers cannot programmatically move the OS cursor for security reasons.  
> The tap sends coordinates, and the sharer sees a visual flash at that position.  
> For full OS-level cursor control, you'd need a native app (Electron/Tauri + robotjs).  
> This app is the **pure browser** version — zero install required.

## Files

```
├── index.html      # App shell + all three views
├── style.css       # Design system (dark theme, animations)
├── app.js          # WebRTC + PeerJS logic
├── vercel.json     # Deployment + security headers
└── package.json    # Scripts
```
