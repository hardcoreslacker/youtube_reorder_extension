const reorderForm = document.getElementById('reorderForm');
const startButton = document.getElementById('startReorder');
const cancelButton = document.getElementById('cancelReorder');
const confirmButton = document.getElementById('confirmButton');
const editButton = document.getElementById('editButton');
const statusText = document.getElementById('status-text');
const orderSelect = document.getElementById('order');
const maxLengthInput = document.getElementById('maxLength');
const progressBarContainer = document.getElementById('progress-bar-container');
const progressBar = document.getElementById('progress-bar');
const settingsView = document.getElementById('settings-view');
const previewView = document.getElementById('preview-view');
const previewList = document.getElementById('preview-list');


function saveSettings() {
  const settings = {
    order: orderSelect.value,
    maxLength: maxLengthInput.value
  };
  chrome.storage.local.set({ reorder_settings: settings });
}

function loadSettings() {
  chrome.storage.local.get('reorder_settings', (data) => {
    if (data.reorder_settings) {
      orderSelect.value = data.reorder_settings.order || 'asc';
      maxLengthInput.value = data.reorder_settings.maxLength || '0';
    }
  });
}

function showView(viewName) {
    settingsView.style.display = viewName === 'settings' ? 'block' : 'none';
    previewView.style.display = viewName === 'preview' ? 'block' : 'none';
}

function updateUI(status) {
  if (!status || status.state === 'idle' || !status.state) {
    statusText.textContent = 'Ready to sort.';
    startButton.disabled = false;
    cancelButton.style.display = 'none';
    cancelButton.disabled = false;
    orderSelect.disabled = false;
    maxLengthInput.disabled = false;
    progressBarContainer.style.display = 'none';
    progressBar.style.width = '0%';
    showView('settings');
  } else if (status.state === 'gathering') {
    statusText.textContent = status.message || 'Gathering videos...';
    startButton.disabled = true;
    cancelButton.style.display = 'block';
    orderSelect.disabled = true;
    maxLengthInput.disabled = true;
    progressBarContainer.style.display = 'none';
    showView('settings');
  } else if (status.state === 'preview') {
    statusText.textContent = `Found ${status.total} videos. Confirm new order.`;
    previewList.innerHTML = '';
    status.plan.forEach(video => {
        const item = document.createElement('div');
        const minutes = Math.floor(video.duration / 60);
        const seconds = video.duration % 60;
        item.textContent = `(${minutes}:${seconds.toString().padStart(2, '0')}) ${video.title}`;
        item.style.whiteSpace = 'nowrap';
        item.style.overflow = 'hidden';
        item.style.textOverflow = 'ellipsis';
        previewList.appendChild(item);
    });
    showView('preview');
  } else if (status.state === 'reordering') {
    const percentage = status.total > 0 ? Math.round((status.processed / status.total) * 100) : 0;
    statusText.textContent = `Reordering... (${status.processed}/${status.total})`;
    startButton.disabled = true;
    cancelButton.style.display = 'block';
    cancelButton.disabled = false;
    orderSelect.disabled = true;
    maxLengthInput.disabled = true;
    progressBarContainer.style.display = 'block';
    progressBar.style.width = `${percentage}%`;
    showView('settings');
  } else if (status.state === 'complete') {
    statusText.textContent = `Reordering complete!`;
    startButton.disabled = false;
    cancelButton.style.display = 'none';
    cancelButton.disabled = false;
    orderSelect.disabled = false;
    maxLengthInput.disabled = false;
    progressBarContainer.style.display = 'block';
    progressBar.style.width = '100%';
    showView('settings');
  } else if (status.state === 'error') {
    statusText.textContent = `Error: ${status.message}`;
    startButton.disabled = false;
    cancelButton.style.display = 'none';
    cancelButton.disabled = false;
    orderSelect.disabled = false;
    maxLengthInput.disabled = false;
    progressBarContainer.style.display = 'none';
    progressBar.style.width = '0%';
    showView('settings');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  // Initial status check when popup opens
  chrome.storage.local.get('reorder_status', (data) => {
    // If the last known state was 'complete' or 'preview', reset to 'idle' when opening the popup.
    if (data.reorder_status && data.reorder_status.state === 'complete') {
      chrome.storage.local.set({ 'reorder_status': { state: 'idle' } }, () => updateUI({ state: 'idle' }));
      return;
    }
    updateUI(data.reorder_status);
  });
});

// Listen for status changes from the content script
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local' && changes.reorder_status) {
    updateUI(changes.reorder_status.newValue);
  }
});

reorderForm.addEventListener('submit', (e) => {
  e.preventDefault();
  saveSettings();

  const order = orderSelect.value;
  const maxLength = parseInt(maxLengthInput.value, 10) * 60; // convert to seconds

  chrome.runtime.sendMessage({ from: 'popup', action: 'generatePlan', order: order, maxLength: maxLength }, (response) => {
    if (chrome.runtime.lastError) {
      statusText.textContent = "Error: Could not connect to the YouTube page. Please refresh the page and try again.";
      return;
    }
    if (response && response.status === 'started') {
      // The UI will update via the storage listener.
    } else if (response && response.status === 'error') {
      statusText.textContent = `Error: ${response.message}`;
    }
  });
});

confirmButton.addEventListener('click', () => {
    chrome.runtime.sendMessage({ from: 'popup', action: 'executeReorder' }, (response) => {
        if (response && response.status === 'executing') {
            // UI will update via storage listener
        }
    });
});

editButton.addEventListener('click', () => {
    // Send a cancel message to reset the state in the content script and then update UI
    chrome.runtime.sendMessage({ from: 'popup', action: 'cancelReorder' }, () => {
        updateUI({ state: 'idle' });
    });
});

cancelButton.addEventListener('click', () => {
  chrome.runtime.sendMessage({ from: 'popup', action: 'cancelReorder' }, (response) => {
    if (chrome.runtime.lastError) {
      statusText.textContent = "Error: Could not send cancel command.";
      return;
    }
    if (response && response.status === 'cancelling') {
      statusText.textContent = 'Operation cancelled.';
      cancelButton.disabled = true; // Prevent multiple clicks
      updateUI({ state: 'idle' });
    }
  });
});

orderSelect.addEventListener('change', saveSettings);
maxLengthInput.addEventListener('change', saveSettings);

// For testing purposes
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    updateUI,
    loadSettings,
    saveSettings,
  };
}