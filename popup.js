document.addEventListener('DOMContentLoaded', () => {
    const reorderBtn = document.getElementById('reorder-btn');
    const confirmationControls = document.getElementById('confirmation-controls');
    const proceedBtn = document.getElementById('proceed-btn');
    const cancelBtn = document.getElementById('cancel-btn');
    const maxDurationInput = document.getElementById('max-duration');
    const sortOrderSelect = document.getElementById('sort-order');
    const statusDiv = document.getElementById('status');
 
    // Load saved settings
    chrome.storage.sync.get(['maxDuration', 'sortOrder'], (result) => {
        if (result.maxDuration) {
            maxDurationInput.value = result.maxDuration;
        }
        if (result.sortOrder) {
            sortOrderSelect.value = result.sortOrder;
        }
    });
 
    reorderBtn.addEventListener('click', async () => {
        const maxDuration = parseInt(maxDurationInput.value, 10);
        const sortOrder = sortOrderSelect.value;

        // Save settings
        chrome.storage.sync.set({ maxDuration, sortOrder });
 
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

        if (!tab.url || !tab.url.includes("youtube.com/playlist?list=")) {
            statusDiv.textContent = "Error: Not a YouTube playlist page.";
            return;
        }
 
        reorderBtn.disabled = true; // Disable button to prevent multiple clicks
        statusDiv.textContent = 'Starting...';

        try {
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ['content_script.js']
            });

            // Send message to content script to start the process
            chrome.tabs.sendMessage(tab.id, {
                action: "reorder",
                maxDuration: maxDuration,
                sortOrder: sortOrder
            });

        } catch (e) {
            console.error(e);
            statusDiv.textContent = 'Error injecting script.';
            reorderBtn.disabled = false;
        }
    });
 
    proceedBtn.addEventListener('click', async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        chrome.tabs.sendMessage(tab.id, { action: "proceedReorder" });
 
        confirmationControls.style.display = 'none';
        reorderBtn.style.display = 'block';
        reorderBtn.disabled = true;
        statusDiv.innerHTML = 'Reordering in progress...';
    });
 
    cancelBtn.addEventListener('click', async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        chrome.tabs.sendMessage(tab.id, { action: "cancelReorder" });
 
        confirmationControls.style.display = 'none';
        reorderBtn.style.display = 'block';
        reorderBtn.disabled = false;
        statusDiv.textContent = 'Reordering cancelled.';
    });

    // Listen for status updates from the content script
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === "updateStatus") {
            statusDiv.innerHTML = request.message;
 
            if (request.confirm) {
                // Show confirmation buttons, hide reorder button
                reorderBtn.style.display = 'none';
                confirmationControls.style.display = 'flex';
            } else if (request.done) {
                // Process finished, reset UI
                reorderBtn.style.display = 'block';
                reorderBtn.disabled = false;
                confirmationControls.style.display = 'none';
            }
        }
    });
});