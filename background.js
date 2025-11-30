chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Forward messages from popup to the active tab (content script)
  if (request.from === 'popup') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs.length > 0) {
        chrome.tabs.sendMessage(tabs[0].id, request, (response) => {
          if (chrome.runtime.lastError) {
            // Handle error, e.g., content script not injected
            sendResponse({ status: 'error', message: 'Could not connect to page.' });
          } else {
            sendResponse(response);
          }
        });
      }
    });
    return true; // Indicates that the response is sent asynchronously
  }
});