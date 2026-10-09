import { NetworkMonitor } from './network-monitor';
import { VideoSourceResolver } from '../services/source-resolver';
import { ApiClient } from '../services/api-client';

// Initialize network requests listener
NetworkMonitor.initialize();

// Configure Side Panel behavior on extension install or startup
chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch((err) => console.warn('[ServiceWorker] Could not set panel behavior:', err));
  }
});

// Relay messages between Side Panel, Content Scripts, and background
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;

  // Forward keyboard shortcuts to all frames in the sender's tab
  if (message.type === 'FORWARD_SHORTCUT') {
    const tabId = sender.tab?.id;
    if (tabId) {
      chrome.tabs.sendMessage(tabId, { type: 'EXECUTE_SHORTCUT', payload: message.payload }).catch(() => {});
    }
    sendResponse({ ok: true });
    return false;
  }

  // Retrieve all sources discovered for a tab (from network monitor or DOM)
  if (message.type === 'GET_TAB_SOURCES') {
    const tabId = message.payload?.tabId ?? sender.tab?.id;
    if (typeof tabId === 'number') {
      NetworkMonitor.getSourcesForTab(tabId).then((sources) => {
        sendResponse({ ok: true, sources });
      });
      return true;
    }
    sendResponse({ ok: false, sources: [] });
    return false;
  }

  // Register a source found by content scripts
  if (message.type === 'REGISTER_SOURCE') {
    const tabId = message.payload?.tabId ?? sender.tab?.id;
    const source = message.payload?.source;
    if (typeof tabId === 'number' && source) {
      NetworkMonitor.registerTabSource(tabId, source);
      sendResponse({ ok: true });
      return false;
    }
  }

  // Manually resolve a URL pasted or provided by user
  if (message.type === 'RESOLVE_URL_MANUALLY') {
    const { url, tabId, pageUrl } = message.payload;
    VideoSourceResolver.resolveSource(url, pageUrl || '')
      .then((resolved) => {
        if (typeof tabId === 'number') {
          NetworkMonitor.registerTabSource(tabId, resolved);
        }
        sendResponse({ ok: true, source: resolved });
      })
      .catch((err) => {
        sendResponse({ ok: false, error: err.message });
      });
    return true;
  }

  // Submit job to backend API directly from on-player overlay or drawer
  if (message.type === 'SUBMIT_JOB_FROM_OVERLAY') {
    ApiClient.submitJob(message.payload)
      .then((res) => {
        sendResponse({ ok: true, job_id: res.job_id, status: res.status });
      })
      .catch((err) => {
        sendResponse({ ok: false, error: err.message });
      });
    return true;
  }

  // Relay command from side panel to content script in active tab
  if (message.type === 'RELAY_TO_ACTIVE_TAB') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTab = tabs[0];
      if (activeTab && activeTab.id) {
        chrome.tabs.sendMessage(activeTab.id, message.payload, (response) => {
          sendResponse(response);
        });
      } else {
        sendResponse({ ok: false, error: 'No active tab found' });
      }
    });
    return true;
  }

  // Relay video playback state
  if (message.type === 'DOM_VIDEOS_FOUND' || message.type === 'VIDEO_TIME_UPDATE') {
    chrome.runtime.sendMessage(message).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
