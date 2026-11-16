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
  height: auto !important;
  min-height: 38px !important;
  background: rgba(11, 17, 32, 0.95) !important;
  backdrop-filter: blur(16px) !important;
  -webkit-backdrop-filter: blur(16px) !important;
  border: 1px solid rgba(255, 255, 255, 0.12) !important;
  border-radius: 8px !important;
  display: flex !important;
  align-items: center !important;
  justify-content: space-between !important;
  padding: 4px 8px !important;
  gap: 8px !important;
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
  min-height: 42px !important;
  font-size: 12px !important;
}

/* Two groups that wrap onto a second line on narrow players instead of overflowing. */
.vdt-bar-row {
  display: flex !important;
  align-items: center !important;
  justify-content: space-between !important;
  flex-wrap: wrap !important;
  gap: 4px 10px !important;
  width: 100% !important;
  padding-top: 2px !important;
}
.vdt-bar-group { display: flex !important; align-items: center !important; gap: 5px !important; flex-wrap: nowrap !important; min-width: 0 !important; }
.vdt-bar-group-end { margin-left: auto !important; }
.vdt-popover-trigger > span:nth-child(2) { max-width: 120px !important; overflow: hidden !important; text-overflow: ellipsis !important; white-space: nowrap !important; }

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

/* 5. Segments panel (editor) */
.vdt-segments-drawer {
  position: absolute !important;
  bottom: 96px !important;
  right: 12px !important;
  width: 410px !important;
  max-width: calc(100% - 24px) !important;
  max-height: calc(100% - 120px) !important;
  min-height: 0 !important;
  background: rgba(11, 17, 32, 0.97) !important;
  backdrop-filter: blur(20px) !important;
  -webkit-backdrop-filter: blur(20px) !important;
  border: 1px solid rgba(148, 163, 184, 0.25) !important;
  border-radius: 12px !important;
  box-shadow: 0 18px 50px rgba(0,0,0,0.75) !important;
  flex-direction: column !important;
  z-index: 2147483647 !important;
  overflow: hidden !important;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
  color: #f8fafc !important;
  font-size: 12px !important;
  line-height: 1.3 !important;
  text-align: left !important;
  animation: vdtPopIn 0.18s cubic-bezier(0.16, 1, 0.3, 1) !important;
}
:fullscreen .vdt-segments-drawer,
:-webkit-full-screen .vdt-segments-drawer,
.jw-flag-fullscreen .vdt-segments-drawer {
  bottom: 110px !important;
  right: 20px !important;
}
.vdt-segments-drawer *, .vdt-segments-drawer *::before, .vdt-segments-drawer *::after { box-sizing: border-box !important; }

.vdt-drawer-header, .vdt-drawer-footer {
  display: flex !important;
  align-items: center !important;
  justify-content: space-between !important;
  gap: 8px !important;
  padding: 8px 10px 8px 12px !important;
  background: rgba(30, 41, 59, 0.75) !important;
  flex: none !important;
}
.vdt-drawer-header { border-bottom: 1px solid rgba(51, 65, 85, 0.9) !important; }
.vdt-drawer-footer { border-top: 1px solid rgba(51, 65, 85, 0.9) !important; }
.vdt-drawer-title { display: flex !important; align-items: center !important; gap: 6px !important; min-width: 0 !important; }
.vdt-drawer-title strong { font-size: 13px !important; color: #f8fafc !important; }
.vdt-drawer-icon { color: #38bdf8 !important; display: inline-flex !important; }
.vdt-saved { color: #4ade80 !important; display: inline-flex !important; }
.vdt-drawer-tools { display: flex !important; align-items: center !important; gap: 4px !important; }
.vdt-muted { color: #94a3b8 !important; }
.vdt-drawer-status { font-size: 11px !important; color: #7dd3fc !important; min-width: 0 !important; overflow: hidden !important; text-overflow: ellipsis !important; white-space: nowrap !important; }
.vdt-drawer-status.error { color: #fca5a5 !important; }

.vdt-drawer-body {
  padding: 6px !important;
  overflow-y: auto !important;
  display: flex !important;
  flex-direction: column !important;
  gap: 4px !important;
  min-height: 0 !important;
  flex: 1 1 auto !important;
  overscroll-behavior: contain !important;
}
.vdt-drawer-body::-webkit-scrollbar { width: 6px !important; }
.vdt-drawer-body::-webkit-scrollbar-track { background: transparent !important; }
.vdt-drawer-body::-webkit-scrollbar-thumb { background: #475569 !important; border-radius: 3px !important; }

.vdt-empty {
  display: flex !important; flex-direction: column !important; align-items: center !important; gap: 8px !important;
  padding: 22px 12px !important; color: #94a3b8 !important; font-size: 12px !important; text-align: center !important;
}
.vdt-empty-steps { display: inline-flex !important; gap: 6px !important; color: #cbd5e1 !important; }
.vdt-segments-drawer kbd {
  font-family: ui-monospace, Consolas, monospace !important; font-size: 10px !important; padding: 1px 5px !important;
  border-radius: 4px !important; background: #1e293b !important; border: 1px solid #475569 !important; color: #7dd3fc !important;
}

/* Rows */
.vdt-seg-row {
  position: relative !important;
  background: rgba(30, 41, 59, 0.55) !important;
  border: 1px solid transparent !important;
  border-left: 3px solid var(--vdt-seg-color, #64748b) !important;
  border-radius: 8px !important;
  padding: 4px 4px 6px 8px !important;
  transition: background 0.12s ease, border-color 0.12s ease !important;
}
.vdt-seg-row:hover { background: rgba(51, 65, 85, 0.6) !important; }
.vdt-seg-row.vdt-active { background: rgba(14, 116, 144, 0.28) !important; }
.vdt-seg-row.vdt-active .vdt-seg-index { background: #0ea5e9 !important; color: #fff !important; }
.vdt-seg-row.vdt-selected {
  background: rgba(37, 99, 235, 0.18) !important;
  border-color: rgba(96, 165, 250, 0.7) !important;
  border-left-color: var(--vdt-seg-color, #64748b) !important;
}
.vdt-seg-line { display: flex !important; align-items: center !important; gap: 6px !important; cursor: pointer !important; min-height: 28px !important; }
.vdt-seg-index {
  min-width: 20px !important; height: 20px !important; padding: 0 5px !important; border-radius: 10px !important;
  display: inline-grid !important; place-items: center !important; font-size: 10.5px !important; font-weight: 700 !important;
  background: #334155 !important; color: #e2e8f0 !important; font-variant-numeric: tabular-nums !important;
}
.vdt-seg-range {
  display: inline-flex !important; align-items: center !important; gap: 5px !important;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace !important; font-size: 11.5px !important; color: #e2e8f0 !important;
  font-variant-numeric: tabular-nums !important;
}
.vdt-seg-duration { font-size: 10.5px !important; color: #94a3b8 !important; font-variant-numeric: tabular-nums !important; }
.vdt-seg-warn { display: inline-flex !important; color: #fbbf24 !important; }
.vdt-spacer { flex: 1 1 auto !important; }
.vdt-seg-label { display: flex !important; align-items: center !important; gap: 6px !important; padding: 0 0 0 26px !important; }
.vdt-seg-label select {
  appearance: auto !important; max-width: 100% !important; background: #0f172a !important; color: #f8fafc !important;
  border: 1px solid #334155 !important; border-radius: 5px !important; padding: 2px 6px !important; font-size: 11px !important;
  cursor: pointer !important; outline: none !important; height: auto !important; margin: 0 !important;
}
.vdt-seg-label select:focus { border-color: #60a5fa !important; }

/* Editor */
.vdt-seg-editor {
  display: flex !important; flex-direction: column !important; gap: 4px !important;
  margin: 6px 0 0 26px !important; padding: 6px !important; border-radius: 7px !important;
  background: rgba(2, 6, 23, 0.55) !important; border: 1px solid rgba(51, 65, 85, 0.9) !important;
}
.vdt-time-field { display: flex !important; align-items: center !important; gap: 3px !important; }
.vdt-time-caption { display: inline-flex !important; width: 18px !important; color: #94a3b8 !important; justify-content: center !important; }
.vdt-time-input {
  width: 96px !important; height: 26px !important; padding: 0 6px !important; margin: 0 !important;
  border: 1px solid #475569 !important; border-radius: 5px !important; background: #0f172a !important; color: #f8fafc !important;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace !important; font-size: 12px !important; text-align: center !important;
  outline: none !important; box-shadow: none !important; user-select: text !important;
}
.vdt-time-input:focus { border-color: #60a5fa !important; box-shadow: 0 0 0 2px rgba(96, 165, 250, 0.25) !important; }
.vdt-time-input.vdt-invalid { border-color: #ef4444 !important; box-shadow: 0 0 0 2px rgba(239, 68, 68, 0.25) !important; }

.vdt-dot {
  width: 7px !important;
  height: 7px !important;
  border-radius: 50% !important;
  display: inline-block !important;
  flex-shrink: 0 !important;
}

/* Ghost buttons inside rows */
.vdt-btn-ghost { background: transparent !important; border-color: transparent !important; color: #cbd5e1 !important; }
.vdt-btn-ghost:hover { background: rgba(148, 163, 184, 0.18) !important; border-color: transparent !important; color: #fff !important; }
.vdt-btn-ghost.vdt-btn-danger { color: #f87171 !important; }
.vdt-btn-ghost.vdt-btn-danger:hover { background: rgba(127, 29, 29, 0.85) !important; color: #fecaca !important; }
.vdt-btn.vdt-armed { background: #dc2626 !important; border-color: #ef4444 !important; color: #fff !important; animation: vdtPulse 0.9s ease-in-out infinite !important; }
@keyframes vdtPulse { 50% { opacity: 0.6; } }
.vdt-btn:focus-visible { outline: 2px solid #60a5fa !important; outline-offset: 1px !important; }

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
  margin: 0 2px !important;
  white-space: nowrap !important;
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

/* Icon-only buttons */
.vdt-btn-icon {
  padding: 5px 7px !important;
  min-width: 26px !important;
  justify-content: center !important;
}
.vdt-btn svg { pointer-events: none !important; }
.vdt-btn[disabled] { opacity: 0.45 !important; cursor: not-allowed !important; }
.vdt-btn-danger {
  color: #f87171 !important;
  border-color: rgba(239, 68, 68, 0.4) !important;
}
.vdt-btn-danger:hover {
  background: rgba(127, 29, 29, 0.9) !important;
  border-color: #ef4444 !important;
  color: #fecaca !important;
}
.vdt-count {
  font-variant-numeric: tabular-nums !important;
  font-weight: 700 !important;
}
.vdt-spin { display: inline-flex !important; animation: vdtSpin 1s linear infinite !important; }
@keyframes vdtSpin { to { transform: rotate(360deg); } }

/* 7. Auto-Save Recovery Toast */
.vdt-restore-toast {
  position: absolute !important;
  top: 14px !important;
  left: 50% !important;
  transform: translateX(-50%) translateY(0) !important;
  background: rgba(15, 23, 42, 0.95) !important;
  backdrop-filter: blur(12px) !important;
  -webkit-backdrop-filter: blur(12px) !important;
  border: 1px solid #0284c7 !important;
  box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.6), 0 0 15px rgba(2, 132, 199, 0.35) !important;
  color: #f8fafc !important;
  padding: 8px 14px !important;
  border-radius: 8px !important;
  z-index: 2147483647 !important;
  display: flex !important;
  align-items: center !important;
  gap: 12px !important;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
  font-size: 12px !important;
  transition: opacity 0.3s ease, transform 0.3s ease !important;
  pointer-events: auto !important;
  animation: vdtToastIn 0.35s cubic-bezier(0.16, 1, 0.3, 1) forwards !important;
}

@keyframes vdtToastIn {
  from {
    opacity: 0;
    transform: translateX(-50%) translateY(-10px);
  }
  to {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }
}

/* 8. Edit state on the bar */
.vdt-editing-chip {
  display: inline-flex !important; align-items: center !important; gap: 4px !important; margin-left: 6px !important;
  padding: 3px 8px !important; border-radius: 12px !important; font-size: 11px !important; font-weight: 700 !important;
  color: #fff !important; background: rgba(37, 99, 235, 0.35) !important;
  border: 1px solid var(--vdt-seg-color, #38bdf8) !important; box-shadow: inset 3px 0 0 var(--vdt-seg-color, #38bdf8) !important;
}
.vdt-timeline-segment-selected {
  opacity: 1 !important;
  outline: 2px solid #fff !important;
  outline-offset: 1px !important;
  z-index: 36 !important;
}

/* New label inline form */
.vdt-new-label { display: flex !important; gap: 4px !important; padding: 6px 4px 2px !important; margin: 4px 0 0 !important; border-top: 1px solid #334155 !important; }
.vdt-new-label input {
  flex: 1 1 auto !important; min-width: 0 !important; height: 26px !important; padding: 0 8px !important; margin: 0 !important;
  border: 1px solid #475569 !important; border-radius: 5px !important; background: #0b1220 !important; color: #f8fafc !important;
  font-size: 11px !important; outline: none !important; user-select: text !important;
}
.vdt-new-label input:focus { border-color: #60a5fa !important; }

/* 9. Non-blocking messages (replace alert()) */
.vdt-toast {
  position: absolute !important;
  top: 14px !important;
  left: 50% !important;
  transform: translateX(-50%) !important;
  max-width: calc(100% - 28px) !important;
  display: flex !important;
  align-items: center !important;
  gap: 10px !important;
  padding: 8px 10px 8px 12px !important;
  border-radius: 10px !important;
  background: rgba(15, 23, 42, 0.96) !important;
  border: 1px solid #334155 !important;
  box-shadow: 0 12px 30px rgba(0, 0, 0, 0.6) !important;
  color: #f1f5f9 !important;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
  font-size: 12px !important;
  line-height: 1.35 !important;
  z-index: 2147483647 !important;
  pointer-events: auto !important;
  animation: vdtToastIn 0.25s cubic-bezier(0.16, 1, 0.3, 1) forwards !important;
  transition: opacity 0.2s ease !important;
}
.vdt-toast-out { opacity: 0 !important; }
.vdt-toast-icon { display: inline-flex !important; color: #38bdf8 !important; }
.vdt-toast-ok .vdt-toast-icon { color: #4ade80 !important; }
.vdt-toast-ok { border-color: rgba(34, 197, 94, 0.55) !important; }
.vdt-toast-error { border-color: rgba(239, 68, 68, 0.7) !important; background: rgba(69, 10, 10, 0.95) !important; }
.vdt-toast-error .vdt-toast-icon { color: #fca5a5 !important; }
.vdt-toast-text { min-width: 0 !important; }
.vdt-toast-action { padding: 4px 9px !important; color: #7dd3fc !important; border-color: rgba(56, 189, 248, 0.5) !important; font-weight: 600 !important; }
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
