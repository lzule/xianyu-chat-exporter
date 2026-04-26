chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "downloadExport") {
    const blob = new Blob([msg.content], { type: `${msg.mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename: msg.filename, saveAs: false }, () => {
      URL.revokeObjectURL(url);
    });
  }
  if (msg.type === "exportDone") {
    chrome.action.setBadgeText({ text: "✓" });
    setTimeout(() => chrome.action.setBadgeText({ text: "" }), 5000);
  }
});
