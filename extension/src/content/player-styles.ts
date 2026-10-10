export const PLAYER_INTEGRATION_STYLES = `
/* Universal Video Segment Tagger - Professional In-Player Integration */

/* 1. Scrubber Timeline Markers Layer */
.vdt-scrubber-layer {
  position: absolute !important;
  left: 0 !important;
  right: 0 !important;
  top: 0 !important;
  bottom: 0 !important;
  height: 100% !important;
  pointer-events: none !important;
  z-index: 25 !important;
  overflow: visible !important;
}

.vdt-timeline-segment {
  position: absolute !important;
  top: 0 !important;
  bottom: 0 !important;
  height: 100% !important;
  border-radius: 2px !important;
  cursor: pointer !important;
  pointer-events: auto !important;
  opacity: 0.85 !important;
  transition: transform 0.1s ease, opacity 0.1s ease !important;
  box-shadow: 0 0 4px rgba(0,0,0,0.5) !important;
}

.vdt-timeline-segment:hover {
  opacity: 1 !important;
  transform: scaleY(1.5) !important;
  z-index: 35 !important;
  box-shadow: 0 0 8px rgba(255,255,255,0.7) !important;
}

.vdt-timeline-pin {
  position: absolute !important;
  top: -8px !important;
  bottom: -6px !important;
  width: 2px !important;
  pointer-events: auto !important;
  z-index: 40 !important;
  cursor: pointer !important;
}

.vdt-timeline-pin-flag {
  position: absolute !important;
  top: -18px !important;
  left: 50% !important;
  transform: translateX(-50%) !important;
  font-size: 10px !important;
  font-weight: 700 !important;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace !important;
  padding: 1px 5px !important;
  border-radius: 3px !important;
  white-space: nowrap !important;
  pointer-events: none !important;
  box-shadow: 0 2px 8px rgba(0,0,0,0.6) !important;
  letter-spacing: 0.5px !important;
}

.vdt-timeline-live-range {
  position: absolute !important;
  top: 0 !important;
  bottom: 0 !important;
  height: 100% !important;
  pointer-events: none !important;
  background: repeating-linear-gradient(45deg, rgba(34, 197, 94, 0.3), rgba(34, 197, 94, 0.3) 6px, rgba(34, 197, 94, 0.5) 6px, rgba(34, 197, 94, 0.5) 12px) !important;
  border-top: 2px solid #22c55e !important;
  border-bottom: 2px solid #22c55e !important;
  z-index: 30 !important;
}

.vdt-scrubber-tooltip {
  position: absolute !important;
  bottom: calc(100% + 10px) !important;
  transform: translateX(-50%) !important;
  background: #090d16 !important;
  color: #f8fafc !important;
  border: 1px solid #334155 !important;
  padding: 4px 9px !important;
  border-radius: 5px !important;
  font-size: 11px !important;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace !important;
  pointer-events: none !important;
  white-space: nowrap !important;
  box-shadow: 0 8px 24px rgba(0,0,0,0.7) !important;
  z-index: 50 !important;
  display: flex !important;
  align-items: center !important;
  gap: 6px !important;
}

/* 2. Docked Control Bar */
.vdt-player-bar {
  position: absolute !important;
  left: 12px !important;
  right: 12px !important;
  bottom: 48px !important;
  height: 38px !important;
  background: rgba(11, 17, 32, 0.95) !important;
  backdrop-filter: blur(16px) !important;
  -webkit-backdrop-filter: blur(16px) !important;
  border: 1px solid rgba(255, 255, 255, 0.12) !important;
  border-radius: 8px !important;
  display: flex !important;
  align-items: center !important;
  justify-content: space-between !important;
  padding: 0 10px !important;
  z-index: 2147483647 !important;
  color: #f8fafc !important;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif !important;
  font-size: 11px !important;
  box-shadow: 0 8px 32px rgba(0,0,0,0.7) !important;
  user-select: none !important;
  transition: opacity 0.2s ease, transform 0.2s ease, bottom 0.2s ease !important;
}

/* Fullscreen adjustments */
:fullscreen .vdt-player-bar,
:-webkit-full-screen .vdt-player-bar,
.jw-flag-fullscreen .vdt-player-bar {
  bottom: 58px !important;
  left: 20px !important;
  right: 20px !important;
  height: 42px !important;
  font-size: 12px !important;
}

/* Auto-hide classes */
.vdt-player-bar.vdt-hidden {
  opacity: 0 !important;
  pointer-events: none !important;
  transform: translateY(8px) !important;
}

.vdt-player-bar.vdt-visible {
  opacity: 1 !important;
  pointer-events: auto !important;
  transform: translateY(0) !important;
}

/* 3. Button Styles (Clean & Professional) */
.vdt-btn {
  background: rgba(30, 41, 59, 0.85) !important;
  border: 1px solid rgba(71, 85, 105, 0.7) !important;
  color: #f8fafc !important;
  padding: 5px 10px !important;
  border-radius: 5px !important;
  font-size: 11px !important;
  font-weight: 500 !important;
  cursor: pointer !important;
  display: inline-flex !important;
  align-items: center !important;
  gap: 5px !important;
  transition: all 0.12s ease !important;
  user-select: none !important;
  line-height: 1 !important;
}

.vdt-btn:hover {
  background: rgba(51, 65, 85, 0.95) !important;
  border-color: #94a3b8 !important;
  color: #ffffff !important;
}

.vdt-btn:active {
  transform: scale(0.97) !important;
}

.vdt-btn-primary {
  background: #2563eb !important;
  border: 1px solid #3b82f6 !important;
  color: #ffffff !important;
  font-weight: 600 !important;
}

.vdt-btn-primary:hover {
  background: #1d4ed8 !important;
  border-color: #60a5fa !important;
}

.vdt-btn-success {
  background: #16a34a !important;
  border: 1px solid #22c55e !important;
  color: #ffffff !important;
  font-weight: 600 !important;
}

.vdt-btn-success:hover {
  background: #15803d !important;
}

.vdt-btn-in-active {
  background: #059669 !important;
  border-color: #10b981 !important;
  color: #ffffff !important;
  font-weight: 600 !important;
}

.vdt-btn-out-active {
  background: #dc2626 !important;
  border-color: #ef4444 !important;
  color: #ffffff !important;
  font-weight: 600 !important;
}

/* 4. In-DOM Custom Popovers (Replaces buggy native <select>) */
.vdt-popover-container {
  position: relative !important;
  display: inline-block !important;
}

.vdt-popover-trigger {
  background: #1e293b !important;
  border: 1px solid #475569 !important;
  color: #f8fafc !important;
  border-radius: 5px !important;
  padding: 4px 8px !important;
  font-size: 11px !important;
  font-weight: 500 !important;
  cursor: pointer !important;
  display: inline-flex !important;
  align-items: center !important;
  gap: 6px !important;
  transition: all 0.12s ease !important;
  user-select: none !important;
}

.vdt-popover-trigger:hover,
.vdt-popover-trigger.active {
  background: #334155 !important;
  border-color: #94a3b8 !important;
}

.vdt-popover-menu {
  position: absolute !important;
  bottom: calc(100% + 8px) !important;
  left: 0 !important;
  min-width: 150px !important;
  background: #0f172a !important;
  border: 1px solid #334155 !important;
  border-radius: 7px !important;
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.8) !important;
  padding: 4px !important;
  display: flex !important;
  flex-direction: column !important;
  gap: 2px !important;
  z-index: 2147483647 !important;
  animation: vdtPopIn 0.15s cubic-bezier(0.16, 1, 0.3, 1) !important;
}

.vdt-popover-menu-right {
  left: auto !important;
  right: 0 !important;
}

@keyframes vdtPopIn {
  from {
    opacity: 0;
    transform: translateY(6px) scale(0.97);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

.vdt-popover-item {
  padding: 5px 8px !important;
  border-radius: 4px !important;
  font-size: 11px !important;
  color: #cbd5e1 !important;
  cursor: pointer !important;
  display: flex !important;
  align-items: center !important;
  justify-content: space-between !important;
  gap: 8px !important;
  transition: background 0.1s ease !important;
}

.vdt-popover-item:hover {
  background: #1e293b !important;
  color: #f8fafc !important;
}

.vdt-popover-item.selected {
  background: rgba(37, 99, 235, 0.25) !important;
  color: #60a5fa !important;
  font-weight: 600 !important;
}

/* 5. In-Player Slide-Up Segments Drawer */
.vdt-segments-drawer {
  position: absolute !important;
  bottom: 92px !important;
  right: 12px !important;
  width: 360px !important;
  max-height: 300px !important;
  background: rgba(11, 17, 32, 0.97) !important;
  backdrop-filter: blur(20px) !important;
  -webkit-backdrop-filter: blur(20px) !important;
  border: 1px solid rgba(59, 130, 246, 0.45) !important;
  border-radius: 10px !important;
  box-shadow: 0 16px 45px rgba(0,0,0,0.8) !important;
  flex-direction: column !important;
  z-index: 2147483647 !important;
  overflow: hidden !important;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
  color: #f8fafc !important;
  font-size: 11px !important;
  animation: vdtPopIn 0.18s cubic-bezier(0.16, 1, 0.3, 1) !important;
}

:fullscreen .vdt-segments-drawer,
:-webkit-full-screen .vdt-segments-drawer,
.jw-flag-fullscreen .vdt-segments-drawer {
  bottom: 106px !important;
  right: 20px !important;
}

.vdt-drawer-header {
  display: flex !important;
  align-items: center !important;
  justify-content: space-between !important;
  padding: 8px 12px !important;
  background: rgba(30, 41, 59, 0.9) !important;
  border-bottom: 1px solid rgba(51, 65, 85, 0.8) !important;
}

.vdt-drawer-body {
  padding: 8px !important;
  overflow-y: auto !important;
  display: flex !important;
  flex-direction: column !important;
  gap: 6px !important;
  max-height: 220px !important;
}

.vdt-segment-card {
  background: #1e293b !important;
  border: 1px solid #334155 !important;
  border-radius: 6px !important;
  padding: 6px 9px !important;
  display: flex !important;
  align-items: center !important;
  justify-content: space-between !important;
  gap: 8px !important;
  transition: border-color 0.12s ease !important;
}

.vdt-segment-card:hover {
  border-color: #3b82f6 !important;
}

.vdt-dot {
  width: 7px !important;
  height: 7px !important;
  border-radius: 50% !important;
  display: inline-block !important;
  flex-shrink: 0 !important;
}

/* Custom Scrollbar for Drawer */
.vdt-drawer-body::-webkit-scrollbar {
  width: 5px !important;
}

.vdt-drawer-body::-webkit-scrollbar-track {
  background: transparent !important;
}

.vdt-drawer-body::-webkit-scrollbar-thumb {
  background: #475569 !important;
  border-radius: 3px !important;
}
/* Seek Bar */
.vdt-seek-container {
  width: 100% !important;
  display: flex !important;
  align-items: center !important;
  padding: 4px 0 !important;
  cursor: pointer !important;
  position: absolute !important;
  top: -16px !important;
  left: 0 !important;
  right: 0 !important;
}

.vdt-seek-bar {
  -webkit-appearance: none !important;
  width: 100% !important;
  height: 4px !important;
  background: rgba(255, 255, 255, 0.2) !important;
  border-radius: 2px !important;
  outline: none !important;
  margin: 0 !important;
  transition: height 0.1s ease !important;
}

.vdt-seek-bar:hover {
  height: 6px !important;
}

.vdt-seek-bar::-webkit-slider-thumb {
  -webkit-appearance: none !important;
  appearance: none !important;
  width: 12px !important;
  height: 12px !important;
  border-radius: 50% !important;
  background: #38bdf8 !important;
  cursor: pointer !important;
  box-shadow: 0 0 5px rgba(0,0,0,0.5) !important;
  transition: transform 0.1s ease !important;
}

.vdt-seek-bar::-webkit-slider-thumb:hover {
  transform: scale(1.3) !important;
}

/* Time display */
.vdt-time-display {
  font-variant-numeric: tabular-nums !important;
  color: #e2e8f0 !important;
  font-size: 12px !important;
  font-weight: 500 !important;
  margin-left: 8px !important;
  margin-right: 8px !important;
}

/* Collapsed Ball */
.vdt-collapsed-ball {
  position: absolute !important;
  bottom: 48px !important;
  right: 20px !important;
  width: 44px !important;
  height: 44px !important;
  border-radius: 50% !important;
  background: rgba(11, 17, 32, 0.95) !important;
  backdrop-filter: blur(16px) !important;
  -webkit-backdrop-filter: blur(16px) !important;
  border: 1px solid rgba(255, 255, 255, 0.2) !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  cursor: pointer !important;
  z-index: 2147483647 !important;
  box-shadow: 0 4px 12px rgba(0,0,0,0.5) !important;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1) !important;
  color: #38bdf8 !important;
}

.vdt-collapsed-ball:hover {
  transform: scale(1.1) !important;
  background: rgba(30, 41, 59, 0.95) !important;
  border-color: #38bdf8 !important;
}

`;

export function injectPlayerStyles(): void {
  const existing = document.getElementById('vdt-player-styles');
  if (existing) {
    existing.textContent = PLAYER_INTEGRATION_STYLES;
    return;
  }
  const styleEl = document.createElement('style');
  styleEl.id = 'vdt-player-styles';
  styleEl.textContent = PLAYER_INTEGRATION_STYLES;
  (document.head || document.documentElement).appendChild(styleEl);
}
