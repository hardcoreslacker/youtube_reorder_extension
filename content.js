let isReordering = false; // Tracks if an operation (gathering or reordering) is active.
let isCancelled = false;

// Initialize state to idle when the script loads.
// This prevents the extension from being stuck in a previous state on page reload.
chrome.storage.local.set({ 'reorder_status': { state: 'idle' } });

async function updateStatus(state, processed = 0, total = 0, message = '', plan = []) {
  const status = { state, processed, total, message, plan, timestamp: Date.now() };
  await chrome.storage.local.set({ 'reorder_status': status });
}

async function scrollToBottom(element) {
    return new Promise(resolve => {
        const contentContainer = document.querySelector("ytd-playlist-video-list-renderer #contents");
        if (!contentContainer) {
            resolve();
            return;
        }

        let lastHeight = 0;
        let consecutiveStops = 0;
        const maxConsecutiveStops = 3; // Stop after 3 checks with no height change

        let scrollTimeout;
        const scrollInterval = setInterval(() => {
            window.scrollTo(0, document.documentElement.scrollHeight);
            const currentHeight = document.documentElement.scrollHeight;

            if (currentHeight === lastHeight) {
                consecutiveStops++;
                if (consecutiveStops >= maxConsecutiveStops) {
                    clearInterval(scrollInterval);
                    clearTimeout(scrollTimeout);
                    resolve();
                }
            } else {
                consecutiveStops = 0;
                lastHeight = currentHeight;
            }
        }, 1000); // Scroll and check every second

        // Failsafe timeout to prevent infinite scrolling
        scrollTimeout = setTimeout(() => { clearInterval(scrollInterval); resolve(); }, 30000);
    });
}

async function generateReorderPlan(order, maxLength) {
  isReordering = true;
  await updateStatus('gathering', 0, 0, 'Scrolling to load all videos...');

  try { // Wrap in a try-finally to ensure isReordering is reset
    // Scroll to the bottom to load all videos
    await scrollToBottom();
    await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for any final videos to load

    await updateStatus('gathering', 0, 0, 'Gathering video data...');

    // This selector should target the video entries in the playlist
    const videoListSelector = 'ytd-playlist-video-renderer';
    const videoElements = Array.from(document.querySelectorAll(videoListSelector));

    if (videoElements.length === 0) {
      throw new Error("No videos found. Are you on a playlist page?");
    }

    let videoData = videoElements.map((el, index) => {
      const timeEl = el.querySelector('span.ytd-thumbnail-overlay-time-status-renderer');
      const titleEl = el.querySelector('#video-title');
      const durationText = timeEl ? timeEl.innerText.trim() : '0:00';
      const durationSeconds = durationText.split(':').reduce((acc, time) => (60 * acc) + +time, 0);
      return { duration: durationSeconds, title: titleEl ? titleEl.textContent.trim() : 'Untitled' };
    });

    // Filter out videos that are too long, if a max length is set
    if (maxLength > 0) {
      videoData = videoData.filter(video => video.duration <= maxLength);
    }

    if (videoData.length === 0) {
      throw new Error("No videos match the specified criteria.");
    }

    videoData.sort((a, b) => {
      return order === 'asc' ? a.duration - b.duration : b.duration - a.duration;
    });

    // Store the plan and send it to the popup for confirmation
    const planForPopup = videoData.map(v => ({ title: v.title, duration: v.duration }));
    await updateStatus('preview', 0, videoData.length, '', planForPopup);

  } catch (error) {
    await updateStatus('error', 0, 0, error.message);
  } finally {
    // isReordering is intentionally NOT reset here. It stays true until the plan is executed or cancelled.
  }
}

function findVideoElementByTitle(title) {
    const videoElements = Array.from(document.querySelectorAll('ytd-playlist-video-renderer'));
    return videoElements.find(el => {
        const titleEl = el.querySelector('#video-title');
        return titleEl && titleEl.textContent.trim() === title;
    });
}

async function waitForDOMStability(targetNode, timeout = 500) {
    return new Promise(resolve => {
        let mutationTimeout;
        const observer = new MutationObserver(() => {
            clearTimeout(mutationTimeout);
            mutationTimeout = setTimeout(() => {
                observer.disconnect();
                resolve();
            }, timeout);
        });

        observer.observe(targetNode, { childList: true, subtree: true });

        mutationTimeout = setTimeout(() => {
            observer.disconnect();
            resolve();
        }, timeout);
    });
}

async function waitForMove(titleToFind) {
    const maxRetries = 15;
    const retryDelay = 500; // ms

    for (let i = 0; i < maxRetries; i++) {
        await new Promise(r => setTimeout(r, retryDelay));
        
        const firstVideo = document.querySelector('ytd-playlist-video-list-renderer #contents ytd-playlist-video-renderer');
        if (firstVideo) {
            const firstVideoTitle = firstVideo.querySelector('#video-title')?.textContent.trim();
            if (firstVideoTitle === titleToFind) {
                // Now, wait for the DOM to stop changing before proceeding.
                const playlistContents = document.querySelector('ytd-playlist-video-list-renderer #contents');
                if (playlistContents) await waitForDOMStability(playlistContents);
                return;
            }
        }
    }
    return false;
}

async function clickMenuOption(videoElement, optionText) {
    const menuButton = videoElement.querySelector('#menu button');
    if (!menuButton) throw new Error(`Could not find menu button for video.`);
    menuButton.click();
    await new Promise(r => setTimeout(r, 200)); // Wait for menu to appear
    const menuItems = document.querySelectorAll('ytd-menu-service-item-renderer');
    const targetOption = Array.from(menuItems).find(item => item.textContent.trim() === optionText);
    if (!targetOption) throw new Error(`Could not find "${optionText}" option.`);
    targetOption.click();
}

async function executeReorder(planToExecute) {
  isReordering = true; // Ensure this is true before starting.

  try {
    if (!planToExecute || planToExecute.length === 0) {
      throw new Error("Reorder plan is missing or empty.");
    }
    const reorderPlan = planToExecute;
    const totalVideos = reorderPlan.length;
    await updateStatus('reordering', 0, totalVideos);

    const playlistElement = document.querySelector('ytd-playlist-video-list-renderer #contents');
    if (!playlistElement) {
      throw new Error("Could not find playlist container.");
    }

    // **FIX**: Iterate backwards to get the correct final order.
    // Moving item N to the top, then N-1, results in N-1 being on top of N.
    // So we move the items that should be at the bottom first.
    for (let i = reorderPlan.length - 1; i >= 0; i--) {
      if (isCancelled) {
        await updateStatus('idle');
        break;
      }
      const videoInfo = reorderPlan[i];
      let videoElement = findVideoElementByTitle(videoInfo.title);
      
      if (!videoElement) {
          await updateStatus('reordering', reorderPlan.length - 1 - i, totalVideos, `Searching for "${videoInfo.title}"...`);
          // Reuse the robust scrolling method from the plan generation step.
          await scrollToBottom();
          videoElement = findVideoElementByTitle(videoInfo.title);

          if (!videoElement) {
            throw new Error(`Could not find video "${videoInfo.title}" after scrolling to the bottom. The playlist may have changed.`);
          }
      }
      
      try {
        videoElement.scrollIntoView({ block: 'center' });
        await clickMenuOption(videoElement, 'Move to top');
        await waitForMove(videoInfo.title);
      } catch (e) {
        // Attempt to close any open menus by clicking the body
        document.body.click();
        // Continue to the next video
      }
      
      await updateStatus('reordering', reorderPlan.length - i, totalVideos);
    }

    if (isCancelled) {
      return; // Exit if cancelled during the loop
    }

    // Verification Step
    const verificationResult = await verifyOrder(planToExecute);
    if (verificationResult === true) {
      await updateStatus('complete', totalVideos, totalVideos);
    } else {
      throw new Error(verificationResult);
    }
  } catch (error) {
    await updateStatus('error', 0, 0, `Execution failed: ${error.message}`);
  } finally {
    isReordering = false;
    isCancelled = false;
    setTimeout(() => {
        chrome.storage.local.get('reorder_status', (data) => {
            if (data.reorder_status && data.reorder_status.state === 'complete') {
                updateStatus('idle');
            }
        });
    }, 5000);
  }
}

async function verifyOrder(planToVerify) {
  // Use the last 'processed' count from reordering as the current step for verification status
  const status = await chrome.storage.local.get('reorder_status');
  const currentProcessed = status.reorder_status?.processed || planToVerify.length;
  await updateStatus('reordering', currentProcessed, planToVerify.length, 'Verifying final order...');

  // Wait a moment for the DOM to settle after the last move operation.
  await new Promise(resolve => setTimeout(resolve, 2000));

  const videoElements = Array.from(document.querySelectorAll('ytd-playlist-video-renderer'));
  if (videoElements.length < planToVerify.length) {
    return "Verification failed: Not all videos were found on the page after reordering.";
  }

  // Get the titles of the top videos from the DOM, up to the length of our plan.
  const currentOrderTitles = videoElements.slice(0, planToVerify.length).map(el => {
    const titleEl = el.querySelector('#video-title');
    return titleEl ? titleEl.textContent.trim() : 'Untitled';
  });

  // Compare the current order with the planned order.
  for (let i = 0; i < planToVerify.length; i++) {
    if (currentOrderTitles[i] !== planToVerify[i].title) {
      const errorMsg = `Mismatch at position ${i + 1}. Expected: "${planToVerify[i].title}", but found: "${currentOrderTitles[i]}"`;
      return errorMsg; // Return the detailed error message for the UI
    }
  }

  return true; // Return true on success
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'generatePlan') {
    if (isReordering) {
      sendResponse({ status: 'error', message: 'An operation is already in progress.' });
      return;
    }
    generateReorderPlan(request.order, request.maxLength);
    sendResponse({ status: 'started' });
  } else if (request.action === 'executeReorder') {
    // Retrieve the plan from storage to execute it
    chrome.storage.local.get('reorder_status', (data) => {
      if (data.reorder_status && data.reorder_status.plan) {
        executeReorder(data.reorder_status.plan);
        sendResponse({ status: 'executing' });
      }
    });
    return true; // Indicate async response
  } else if (request.action === 'cancelReorder') {
    if (isReordering) {
      isCancelled = true;
      isReordering = false;
      updateStatus('idle');
      sendResponse({ status: 'cancelling' });
    }
  }
});

// For testing purposes
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    generateReorderPlan,
    executeReorder,
    scrollToBottom, // Export for mocking
    verifyOrder,
  };
}