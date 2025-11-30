/**
 * @jest-environment jsdom
 */
const content = require('./content');

describe('content.js', () => {
  // This will be used to inject mock DOM elements for each test
  let playlistContainer;

  beforeEach(() => {
    // Reset mocks and DOM before each test
    jest.clearAllMocks();
    document.body.innerHTML = '<div id="playlist-container"></div>';
    playlistContainer = document.getElementById('playlist-container');

    // Mock querySelector to work with our container
    document.querySelectorAll = jest.fn(selector => {
      if (selector === 'ytd-playlist-video-renderer') {
        return playlistContainer.querySelectorAll(selector);
      }
      return [];
    });
  });

  // Helper function to create a mock video element
  const createMockVideoElement = (title) => {
    const videoEl = document.createElement('ytd-playlist-video-renderer');
    const titleEl = document.createElement('span');
    titleEl.id = 'video-title';
    // Add a time element for generateReorderPlan tests
    const timeEl = document.createElement('span');
    timeEl.className = 'ytd-thumbnail-overlay-time-status-renderer';
    const durationSeconds = Math.floor(Math.random() * 1000);
    timeEl.innerText = `${Math.floor(durationSeconds / 60)}:${(durationSeconds % 60).toString().padStart(2, '0')}`;

    titleEl.textContent = title;
    videoEl.appendChild(titleEl);
    return videoEl;
  };

  test('should return true when DOM order matches the plan', async () => {
    // Arrange: The planned order of videos
    const reorderPlan = [
      { title: 'Video A' },
      { title: 'Video B' },
      { title: 'Video C' },
    ];

    // Arrange: Set up the DOM to match the plan
    playlistContainer.appendChild(createMockVideoElement('Video A'));
    playlistContainer.appendChild(createMockVideoElement('Video B'));
    playlistContainer.appendChild(createMockVideoElement('Video C'));

    // Mock storage for verifyOrder
    chrome.storage.local.get.mockResolvedValue({ reorder_status: { processed: 0 } });

    // Act: Run the verification
    const result = await content.verifyOrder(reorderPlan);

    // Assert: The result should be true for a perfect match
    expect(result).toBe(true);
  });

  test('should return an error message when DOM order does not match the plan', async () => {
    // Arrange: The planned order of videos
    const reorderPlan = [
      { title: 'Video A' },
      { title: 'Video B' },
      { title: 'Video C' },
    ];

    // Arrange: Set up the DOM in a different order
    playlistContainer.appendChild(createMockVideoElement('Video A'));
    playlistContainer.appendChild(createMockVideoElement('Video C')); // Mismatched order
    playlistContainer.appendChild(createMockVideoElement('Video B'));

    // Mock storage for verifyOrder
    chrome.storage.local.get.mockResolvedValue({ reorder_status: { processed: 0 } });

    // Act: Run the verification
    const result = await content.verifyOrder(reorderPlan);

    // Assert: The result should be an error string
    expect(result).toContain('Mismatch at position 2');
    expect(result).toContain('Expected: "Video B", but found: "Video C"');
  });

  test('should return an error message when the DOM has fewer videos than the plan', async () => {
    // Arrange: The planned order of videos
    const reorderPlan = [
      { title: 'Video A' },
      { title: 'Video B' },
      { title: 'Video C' },
    ];

    // Arrange: Set up the DOM with a missing video
    playlistContainer.appendChild(createMockVideoElement('Video A'));
    playlistContainer.appendChild(createMockVideoElement('Video B'));

    // Act
    chrome.storage.local.get.mockResolvedValue({ reorder_status: { processed: 0 } });
    const result = await content.verifyOrder(reorderPlan);

    expect(result).toBe('Verification failed: Not all videos were found on the page after reordering.');
  });

  describe('generateReorderPlan', () => {
    // Helper to create a video element with a specific duration
    const createVideoWithDuration = (title, durationSeconds) => {
      const videoEl = document.createElement('ytd-playlist-video-renderer');
      const titleEl = document.createElement('span');
      titleEl.id = 'video-title';
      titleEl.textContent = title;

      const timeEl = document.createElement('span');
      timeEl.className = 'ytd-thumbnail-overlay-time-status-renderer';
      const minutes = Math.floor(durationSeconds / 60);
      const seconds = durationSeconds % 60;
      timeEl.innerText = `${minutes}:${seconds.toString().padStart(2, '0')}`;

      videoEl.appendChild(titleEl);
      videoEl.appendChild(timeEl); // The original helper was missing this
      return videoEl;
    };

    beforeEach(() => {
      // Mock functions that are difficult to test in JSDOM (scrolling, timers)
      content.scrollToBottom = jest.fn().mockResolvedValue();
    });

    test('should generate a plan sorted in ascending order', async () => {
      // Arrange
      playlistContainer.appendChild(createVideoWithDuration('Long Video', 300));
      playlistContainer.appendChild(createVideoWithDuration('Short Video', 30));
      playlistContainer.appendChild(createVideoWithDuration('Medium Video', 120));

      // Act
      await content.generateReorderPlan('asc', 0);

      // Assert
      const setCall = chrome.storage.local.set.mock.calls.find(call => call[0].reorder_status.state === 'preview');
      const plan = setCall[0].reorder_status.plan;
      expect(plan[0].title).toBe('Short Video');
      expect(plan[1].title).toBe('Medium Video');
      expect(plan[2].title).toBe('Long Video');
      expect(plan.length).toBe(3);
    });

    test('should generate a plan sorted in descending order', async () => {
      // Arrange
      playlistContainer.appendChild(createVideoWithDuration('Long Video', 300));
      playlistContainer.appendChild(createVideoWithDuration('Short Video', 30));
      playlistContainer.appendChild(createVideoWithDuration('Medium Video', 120));

      // Act
      await content.generateReorderPlan('desc', 0);

      // Assert
      const setCall = chrome.storage.local.set.mock.calls.find(call => call[0].reorder_status.state === 'preview');
      const plan = setCall[0].reorder_status.plan;
      expect(plan[0].title).toBe('Long Video');
      expect(plan[1].title).toBe('Medium Video');
      expect(plan[2].title).toBe('Short Video');
    });

    test('should filter videos by maxLength', async () => {
      // Arrange
      playlistContainer.appendChild(createVideoWithDuration('Video over 5 mins', 301));
      playlistContainer.appendChild(createVideoWithDuration('Video under 5 mins', 299));
      playlistContainer.appendChild(createVideoWithDuration('Video at 5 mins', 300));

      // Act: maxLength is in seconds (5 * 60 = 300)
      await content.generateReorderPlan('asc', 300);

      // Assert
      const setCall = chrome.storage.local.set.mock.calls.find(call => call[0].reorder_status.state === 'preview');
      const plan = setCall[0].reorder_status.plan;
      expect(plan.length).toBe(2);
      expect(plan.map(v => v.title)).toContain('Video under 5 mins');
      expect(plan.map(v => v.title)).toContain('Video at 5 mins');
      expect(plan.map(v => v.title)).not.toContain('Video over 5 mins');
    });

    test('should update status to error if no videos are found', async () => {
      // Arrange: No videos in the container

      // Act
      await content.generateReorderPlan('asc', 0);

      // Assert
      const lastSetCall = chrome.storage.local.set.mock.calls.pop();
      const status = lastSetCall[0].reorder_status;
      expect(status.state).toBe('error');
      expect(status.message).toBe('No videos found. Are you on a playlist page?');
    });

    test('should update status to error if no videos match criteria', async () => {
      // Arrange
      playlistContainer.appendChild(createVideoWithDuration('Long Video', 300));

      // Act: Filter with a maxLength that excludes the only video
      await content.generateReorderPlan('asc', 200);

      // Assert
      const lastSetCall = chrome.storage.local.set.mock.calls.pop();
      const status = lastSetCall[0].reorder_status;
      expect(status.state).toBe('error');
      expect(status.message).toBe('No videos match the specified criteria.');
    });
  });
});