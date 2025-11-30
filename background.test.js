/**
 * @jest-environment node
 */

// Since background.js doesn't interact with the DOM, we use the 'node' environment.

describe('background.js message listener', () => {

  beforeEach(() => {
    // Clear all mocks before each test to ensure isolation.
    jest.clearAllMocks();
    // Reset modules to ensure background.js is re-loaded for each test.
    jest.resetModules();
  });

  test('should forward a message from the popup to the active tab', async () => {
    // Arrange
    const request = { from: 'popup', action: 'test' };
    const sender = {}; // Sender object is present but its properties aren't used for this check
    const sendResponse = jest.fn();
    const tabs = [{ id: 123 }];
    const contentScriptResponse = { status: 'success' };

    // Mock the tabs API to find an active tab
    chrome.tabs.query.mockImplementation((query, callback) => {
      callback(tabs);
    });

    // Mock the sendMessage API to simulate a successful response from the content script
    chrome.tabs.sendMessage.mockImplementation((tabId, message, callback) => {
      callback(contentScriptResponse);
    });

    // Act: Load the background script, which will attach its listener to our mocked chrome object.
    require('./background');

    // Act: Simulate a message arriving at the listener
    await chrome.runtime.onMessage.callListeners(request, sender, sendResponse);
    
    // Assert
    expect(chrome.tabs.query).toHaveBeenCalledWith({ active: true, currentWindow: true }, expect.any(Function));
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(tabs[0].id, request, expect.any(Function));
    expect(sendResponse).toHaveBeenCalledWith(contentScriptResponse);
  });

  test('should handle errors when the content script is not available', async () => {
    // Arrange
    const request = { from: 'popup', action: 'test' };
    const sender = {};
    const sendResponse = jest.fn();
    const tabs = [{ id: 123 }];

    chrome.tabs.query.mockImplementation((query, callback) => {
      callback(tabs);
    });

    // Mock sendMessage to simulate a connection error
    chrome.tabs.sendMessage.mockImplementation((tabId, message, callback) => {
      chrome.runtime.lastError = { message: 'Could not establish connection.' };
      callback(undefined);
    });

    require('./background');

    // Act
    await chrome.runtime.onMessage.callListeners(request, sender, sendResponse);

    // Assert
    expect(sendResponse).toHaveBeenCalledWith({ status: 'error', message: 'Could not connect to page.' });
    // Clean up the mock error
    delete chrome.runtime.lastError;
  });

  test('should do nothing if no active tab is found', async () => {
    // Arrange
    const request = { from: 'popup', action: 'test' };
    const sender = {};
    const sendResponse = jest.fn();

    // Mock the tabs API to return no tabs
    chrome.tabs.query.mockImplementation((query, callback) => {
      callback([]);
    });

    require('./background');

    // Act
    await chrome.runtime.onMessage.callListeners(request, sender, sendResponse);

    // Assert
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
    expect(sendResponse).not.toHaveBeenCalled();
  });

  test('should ignore messages not from the popup', async () => {
    // Arrange
    const request = { from: 'other_source', action: 'test' }; // from is not 'popup'
    const sender = {};
    const sendResponse = jest.fn();

    require('./background');

    // Act
    await chrome.runtime.onMessage.callListeners(request, sender, sendResponse);

    // Assert
    expect(chrome.tabs.query).not.toHaveBeenCalled();
    expect(sendResponse).not.toHaveBeenCalled();
  });
});