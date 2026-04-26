# Xianyu Chat Exporter

[中文文档](README_zh.md)

Chrome extension for exporting **Xianyu** (`xianyu.com` / `goofish.com`) chat records as JSON.

## Maintenance Log

### 2026-04-26

- Refactored export pipeline: injected function returns data to popup for download instead of relying on `chrome.runtime.sendMessage`, eliminating "unknown error" crashes caused by background service worker cold starts
- Added `background.js` service worker for download handling and badge notifications
- Removed Markdown export — JSON only now
- Fixed `sanitizeName` binary control characters that could cause `chrome.scripting.executeScript` serialization failures
- File naming now uses export timestamp (`YYYY-MM-DD_HH-mm`) instead of unreliable message timestamps
- Sped up auto-scroll: wait interval `650ms → 300ms`, stagnant rounds `4 → 2`
- Removed donation images, cleaned up `.gitignore`

### 2026-04-25

- Initial fork and customization
- Added scroll-chain diagnostics and route-driven auto scroll
- Improved auto-scroll container detection and batch scroll stability

## Output Format

### File naming

`contactName_YYYY-MM-DD_HH-mm.json`

- Timestamp is the export moment, accurate to the minute.
- Contact name is sanitized for filesystem safety.

### JSON structure

```json
{
  "product": "product image URL or 未识别商品",
  "messages": [
    { "id": 0, "role": "me", "text": "message content" },
    { "id": 1, "role": "other", "text": "message content" }
  ]
}
```

- `product`: product image URL if found, otherwise `未识别商品`
- `role`: `me` (sent by user) or `other` (received)
- Avatar/placeholder image URLs are filtered out

## Features

- Auto-scroll chat history to top before export (optional) with real-time progress
- Batch export all conversations from the left sidebar
- Batch progress display: current index, success/failed/skipped counts, file count, ETA
- Completion report with file count verification and failure details
- Default export subfolder configurable and persisted via `chrome.storage.local`

## Install

1. Open `chrome://extensions/`
2. Enable Developer mode
3. Click `Load unpacked`
4. Select folder `xianyu-chat-exporter`
