/**
 * @jest-environment jsdom
 */
describe('popup.js', () => {
  // We will need to access functions and DOM elements
  let popup;
  let reorderForm, startButton, cancelButton, confirmButton, editButton, statusText, orderSelect, maxLengthInput, progressBar, settingsView, previewView, previewList;

  beforeEach(() => {
    // Reset modules to ensure popup.js runs in a fresh environment with the new DOM
    jest.resetModules();
    // Clear all mocks before each test
    jest.clearAllMocks();

    // Set up a mock DOM that matches the structure in popup.html
    document.body.innerHTML = `
      <div id="settings-view">
        <form id="reorderForm">
          <select id="order">
            <option value="asc">Shortest to Longest</option>
            <option value="desc">Longest to Shortest</option>
          </select>
          <input id="maxLength" />
          <button id="startReorder">Start</button>
        </form>
      </div>
      <div id="preview-view" style="display: none;">
        <div id="preview-list"></div>
        <button id="confirmButton">Confirm</button>
        <button id="editButton">Edit</button>
      </div>
      <div id="status-text"></div>
      <button id="cancelReorder" style="display: none;"></button>
      <div id="progress-bar-container" style="display: none;">
        <div id="progress-bar"></div>
      </div>
    `;

    // Now that the DOM is set up, we can require the module.
    // This executes the script, attaching event listeners.
    popup = require('./popup');

    // Assign DOM elements to variables for easier access in tests
    reorderForm = document.getElementById('reorderForm');
    startButton = document.getElementById('startReorder');
    cancelButton = document.getElementById('cancelReorder');
    confirmButton = document.getElementById('confirmButton');
    editButton = document.getElementById('editButton');
    statusText = document.getElementById('status-text');
    orderSelect = document.getElementById('order');
    maxLengthInput = document.getElementById('maxLength');
    progressBar = document.getElementById('progress-bar');
    settingsView = document.getElementById('settings-view');
    previewView = document.getElementById('preview-view');
    previewList = document.getElementById('preview-list');
  });

  describe('updateUI function', () => {
    test('should set UI to idle state for null or "idle" status', () => {
      popup.updateUI({ state: 'idle' });
      expect(statusText.textContent).toBe('Ready to sort.');
      expect(startButton.disabled).toBe(false);
      expect(cancelButton.style.display).toBe('none');
      expect(settingsView.style.display).toBe('block');
      expect(previewView.style.display).toBe('none');
    });

    test('should set UI to gathering state', () => {
      popup.updateUI({ state: 'gathering', message: 'Finding videos...' });
      expect(statusText.textContent).toBe('Finding videos...');
      expect(startButton.disabled).toBe(true);
      expect(cancelButton.style.display).toBe('block');
      expect(orderSelect.disabled).toBe(true);
    });

    test('should display the preview view when status is "preview"', () => {
      const status = {
        state: 'preview',
        total: 2,
        plan: [
          { title: 'Short Video', duration: 30 },
          { title: 'Long Video', duration: 300 },
        ],
      };

      popup.updateUI(status);

      expect(statusText.textContent).toContain('Found 2 videos.');
      expect(settingsView.style.display).toBe('none');
      expect(previewView.style.display).toBe('block');
      expect(previewList.children.length).toBe(2);
      expect(previewList.children[0].textContent).toContain('(0:30) Short Video');
      expect(previewList.children[1].textContent).toContain('(5:00) Long Video');
    });

    test('should set UI to reordering state and update progress bar', () => {
      popup.updateUI({ state: 'reordering', processed: 1, total: 4 });
      expect(statusText.textContent).toBe('Reordering... (1/4)');
      expect(startButton.disabled).toBe(true);
      expect(progressBar.style.width).toBe('25%');
      expect(settingsView.style.display).toBe('block');
      expect(previewView.style.display).toBe('none');
    });

    test('should set UI to complete state', () => {
      popup.updateUI({ state: 'complete' });
      expect(statusText.textContent).toBe('Reordering complete!');
      expect(startButton.disabled).toBe(false);
      expect(progressBar.style.width).toBe('100%');
    });

    test('should set UI to error state', () => {
      popup.updateUI({ state: 'error', message: 'Something went wrong' });
      expect(statusText.textContent).toBe('Error: Something went wrong');
      expect(startButton.disabled).toBe(false);
      expect(settingsView.style.display).toBe('block');
    });
  });

  describe('Event Listeners', () => {
    test('should save settings and send message on form submission', () => {
      // Arrange: Set values in the form
      orderSelect.value = 'desc';
      maxLengthInput.value = '10';

      // Act: Simulate form submission
      reorderForm.dispatchEvent(new Event('submit'));

      // Assert: Check that settings were saved
      expect(chrome.storage.local.set).toHaveBeenCalledWith({
        reorder_settings: { order: 'desc', maxLength: '10' }
      });

      // Assert: Check that the correct message was sent
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
        { from: 'popup', action: 'generatePlan', order: 'desc', maxLength: 600 },
        expect.any(Function)
      );
    });

    test('should show an error message from the content script on submission', () => {
      // Arrange: Mock sendMessage to return an error response from the content script
      chrome.runtime.sendMessage.mockImplementation((message, callback) => {
        callback({ status: 'error', message: 'Playlist not found.' });
      });

      // Act: Simulate form submission
      reorderForm.dispatchEvent(new Event('submit'));

      // Assert: The status text should display the error from the response
      expect(statusText.textContent).toBe('Error: Playlist not found.');
    });

    test('should send "executeReorder" message on confirm button click', () => {
      confirmButton.click();
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
        { from: 'popup', action: 'executeReorder' },
        expect.any(Function)
      );
    });

    test('should send "cancelReorder" message and reset UI on edit button click', () => {
      // Arrange: Mock sendMessage to execute the callback it receives.
      chrome.runtime.sendMessage.mockImplementation((message, callback) => {
        if (callback) {
          callback();
        }
      });

      // Set a non-idle state first
      // Add 'total' property to avoid "Found undefined videos" message
      popup.updateUI({ state: 'preview', plan: [], total: 0 });
      expect(settingsView.style.display).toBe('none');

      editButton.click();

      // Assert that cancel message was sent
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
        { from: 'popup', action: 'cancelReorder' },
        expect.any(Function)
      );

      // Assert that UI is reset to idle
      expect(statusText.textContent).toBe('Ready to sort.');
      expect(settingsView.style.display).toBe('block');
    });

    test('should send "cancelReorder" message on cancel button click', () => {
      cancelButton.click();
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
        { from: 'popup', action: 'cancelReorder' },
        expect.any(Function)
      );
    });
  });

  describe('Settings persistence', () => {
    test('loadSettings should populate form from storage', () => {
      // Arrange: Mock the storage to return specific settings
      const settings = { order: 'asc', maxLength: '5' };
      chrome.storage.local.get.mockImplementation((keys, callback) => {
        callback({ reorder_settings: settings });
      });

      // Act: Manually call loadSettings (since DOMContentLoaded is tricky to test)
      // We need to get the function from a fresh require to test it in isolation.
      const { loadSettings } = require('./popup');
      loadSettings();

      // Assert
      expect(orderSelect.value).toBe('asc');
      expect(maxLengthInput.value).toBe('5');
    });

    test('saveSettings should be called on input change', () => {
      // Act: Trigger change events
      orderSelect.dispatchEvent(new Event('change'));
      maxLengthInput.dispatchEvent(new Event('change'));

      // Assert
      expect(chrome.storage.local.set).toHaveBeenCalledTimes(2);
    });
  });

  describe('Initialization and Listeners', () => {
    test('DOMContentLoaded should load settings and initial status', () => {
      // Arrange: Mock storage to return a specific state, e.g., 'reordering'
      const status = { state: 'reordering', processed: 5, total: 10 };
      chrome.storage.local.get.mockImplementation((keys, callback) => {
        if (keys === 'reorder_settings') {
          callback({ reorder_settings: { order: 'desc', maxLength: '15' } });
        }
        if (keys === 'reorder_status') {
          callback({ reorder_status: status });
        }
      });
      // Arrange: Mock 'set' to execute its callback, which is where updateUI is called.
      chrome.storage.local.set.mockImplementation((data, callback) => {
        if (callback) {
          callback();
        }
      });

      // Act: Manually dispatch the DOMContentLoaded event
      document.dispatchEvent(new Event('DOMContentLoaded'));

      // Assert: Check that settings were loaded
      expect(orderSelect.value).toBe('desc');
      expect(maxLengthInput.value).toBe('15');

      // Assert: Check that the UI reflects the initial status from storage
      expect(statusText.textContent).toBe('Reordering... (5/10)');
      expect(startButton.disabled).toBe(true);
    });

    test('DOMContentLoaded should reset to idle if last state was "complete"', () => {
      // Arrange: Mock storage to return a 'complete' status
      const status = { state: 'complete' };
      chrome.storage.local.get.mockImplementation((keys, callback) => {
        if (keys === 'reorder_status') {
          callback({ reorder_status: status });
        }
      });

      // Act: Manually dispatch the DOMContentLoaded event
      document.dispatchEvent(new Event('DOMContentLoaded'));

      // Assert: The UI should be reset to the 'idle' state, not 'complete'
      expect(statusText.textContent).toBe('Ready to sort.');
    });

    test('chrome.storage.onChanged listener should update UI', () => {
      // Arrange: Define a new status that the listener will receive
      const newStatus = { state: 'complete' };
      const changes = { reorder_status: { newValue: newStatus } };

      // Act: Manually trigger the storage listener with the new status
      chrome.storage.onChanged.callListeners(changes, 'local');

      // Assert: The UI should update to the 'complete' state
      expect(statusText.textContent).toBe('Reordering complete!');
      expect(startButton.disabled).toBe(false);
    });
  });

  describe('API Error Handling', () => {
    test('should show an error if form submission fails to connect', () => {
      // Arrange: Mock sendMessage to simulate a connection error
      chrome.runtime.sendMessage.mockImplementation((message, callback) => {
        chrome.runtime.lastError = { message: 'Could not establish connection.' };
        callback(undefined); // The callback is still called, but with no response
      });

      // Act: Simulate form submission
      reorderForm.dispatchEvent(new Event('submit'));

      // Assert: The status text should display the specific connection error message
      expect(statusText.textContent).toContain('Error: Could not connect to the YouTube page.');
      // Reset lastError for subsequent tests
      delete chrome.runtime.lastError;
    });

    test('should show an error if cancel operation fails', () => {
      // Arrange: Mock sendMessage to simulate an error during cancellation
      chrome.runtime.sendMessage.mockImplementation((message, callback) => {
        chrome.runtime.lastError = { message: 'Failed to send.' };
        callback(undefined);
      });

      // Act: Click the cancel button
      cancelButton.click();

      // Assert: The status text should show the cancel error message
      expect(statusText.textContent).toBe('Error: Could not send cancel command.');
      delete chrome.runtime.lastError;
    });
  });
});