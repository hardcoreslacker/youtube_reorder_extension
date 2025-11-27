let isReordering = false; // Tracks if an operation (gathering or reordering) is active.
let isCancelled = false;
let reorderPlan = [];

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
            console.error("Could not find video container element.");
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
                    console.log("Scrolling finished.");
                    resolve();
                }
            } else {
                consecutiveStops = 0;
                lastHeight = currentHeight;
            }
        }, 1000); // Scroll and check every second

        // Failsafe timeout to prevent infinite scrolling
        scrollTimeout = setTimeout(() => { clearInterval(scrollInterval); resolve(); console.warn("Scrolling timed out."); }, 30000);
    });
}

async function generateReorderPlan(order, maxLength) {
  if (isReordering) {
    console.log("Operation already in progress.");
    return;
  }
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
    reorderPlan = videoData;
    const planForPopup = reorderPlan.map(v => ({ title: v.title, duration: v.duration }));
    await updateStatus('preview', 0, reorderPlan.length, '', planForPopup);

  } catch (error) {
    console.error("Failed to generate plan:", error);
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
    console.log('Waiting for DOM to stabilize...');
    return new Promise(resolve => {
        let mutationTimeout;
        const observer = new MutationObserver(() => {
            clearTimeout(mutationTimeout);
            mutationTimeout = setTimeout(() => {
                observer.disconnect();
                console.log('DOM is stable.');
                resolve();
            }, timeout);
        });

        observer.observe(targetNode, { childList: true, subtree: true });

        // Kick off the first timeout. If no mutations happen, it will resolve.
        mutationTimeout = setTimeout(() => {
            observer.disconnect();
            console.log('Initial DOM stability timeout reached without mutations.');
            resolve();
        }, timeout);
    });
}

async function waitForMove(titleToFind) {
    console.log(`Waiting for "${titleToFind}" to appear at the top...`);
    const maxRetries = 15;
    const retryDelay = 500; // ms

    for (let i = 0; i < maxRetries; i++) {
        await new Promise(r => setTimeout(r, retryDelay));
        
        const firstVideo = document.querySelector('ytd-playlist-video-list-renderer #contents ytd-playlist-video-renderer');
        if (firstVideo) {
            const firstVideoTitle = firstVideo.querySelector('#video-title')?.textContent.trim();
            if (firstVideoTitle === titleToFind) {
                console.log(`Verified that "${titleToFind}" is now at the top.`);
                // Now, wait for the DOM to stop changing before proceeding.
                const playlistContents = document.querySelector('ytd-playlist-video-list-renderer #contents');
                if (playlistContents) await waitForDOMStability(playlistContents);
                return;
            }
        }
    }
    console.warn(`Could not verify that "${titleToFind}" moved to the top. The operation might have failed or the UI is slow.`);
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

async function executeReorder() {
  if (reorderPlan.length === 0) {
    console.log("No reorder plan to execute.");
    isReordering = false; // Reset state if there's nothing to do.
    return;
  }
  isReordering = true; // Ensure this is true before starting.

  try {
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
        console.log("Reordering cancelled by user.");
        await updateStatus('idle');
        break;
      }
      const videoInfo = reorderPlan[i];
      let videoElement = findVideoElementByTitle(videoInfo.title);
      
      if (!videoElement) {
          console.warn(`Could not find "${videoInfo.title}". Assuming it's off-screen. Scrolling down to find it...`);
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
        console.error(`Failed to move "${videoInfo.title}":`, e.message);
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
    const verificationResult = await verifyOrder();
    if (verificationResult === true) {
      await updateStatus('complete', totalVideos, totalVideos);
    } else {
      throw new Error(verificationResult);
    }
  } catch (error) {
    console.error("Reordering failed:", error);
    await updateStatus('error', 0, 0, error.message);
  } finally {
    reorderPlan = [];
    isReordering = false;
    isCancelled = false;
    // After a few seconds, reset to idle to allow another sort.
    setTimeout(() => {
        chrome.storage.local.get('reorder_status', (data) => {
            if (data.reorder_status && data.reorder_status.state === 'complete') {
                updateStatus('idle');
            }
        });
    }, 5000);
  }
}

async function verifyOrder() {
  console.log("Verifying final playlist order...");
  // Use the last 'processed' count from reordering as the current step for verification status
  const status = await chrome.storage.local.get('reorder_status');
  const currentProcessed = status.reorder_status?.processed || reorderPlan.length;
  await updateStatus('reordering', currentProcessed, reorderPlan.length, 'Verifying final order...');

  // Wait a moment for the DOM to settle after the last move operation.
  await new Promise(resolve => setTimeout(resolve, 2000));

  const videoElements = Array.from(document.querySelectorAll('ytd-playlist-video-renderer'));

  if (videoElements.length < reorderPlan.length) {
    console.error("Verification failed: Final video count on page is less than planned.");
    return "Verification failed: Not all videos were found on the page after reordering.";
  }

  // Get the titles of the top videos from the DOM, up to the length of our plan.
  const currentOrderTitles = videoElements.slice(0, reorderPlan.length).map(el => {
    const titleEl = el.querySelector('#video-title');
    return titleEl ? titleEl.textContent.trim() : 'Untitled';
  });

  // Compare the current order with the planned order.
  for (let i = 0; i < reorderPlan.length; i++) {
    if (currentOrderTitles[i] !== reorderPlan[i].title) {
      const errorMsg = `Mismatch at position ${i + 1}. Expected: "${reorderPlan[i].title}", but found: "${currentOrderTitles[i]}"`;
      console.error("Verification failed. Displaying comparison table:");
      
      // Log a "diff" table to the console for easy debugging.
      const comparison = reorderPlan.map((plannedVideo, index) => ({
        '#': index + 1,
        'Expected Order': plannedVideo.title,
        'Actual Order': currentOrderTitles[index] || '---',
        'Match': plannedVideo.title === currentOrderTitles[index] ? '✅' : '❌'
      }));
      console.table(comparison);

      return errorMsg; // Return the detailed error message for the UI
    }
  }

  console.log("Verification successful. The playlist order matches the plan.");
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
    executeReorder();
    sendResponse({ status: 'executing' });
  } else if (request.action === 'cancelReorder') {
    if (isReordering) {
      isCancelled = true;
      isReordering = false;
      reorderPlan = [];
      updateStatus('idle');
      sendResponse({ status: 'cancelling' });
    }
  }
});