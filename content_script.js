// This script is injected into the YouTube playlist page.
const LOG_PREFIX = '[Playlist Reorder]';

/**
 * Sends a status update message to the popup, optionally requesting confirmation.
 * @param {string} message - The message to display.
 * @param {boolean} done - Whether the process is complete.
 * @param {boolean} confirm - Whether to show confirmation buttons in the popup.
 */
function updateStatus(message, done = false, confirm = false) {
    chrome.runtime.sendMessage({ action: "updateStatus", message, done, confirm });
}

/**
 * Parses a time string (e.g., "1:05", "12:34:56") into seconds.
 * @param {string} timeStr - The time string from YouTube.
 * @returns {number} - Total seconds.
 */
function parseTime(timeStr) {
    if (!timeStr) return Infinity;
    const parts = timeStr.split(':').map(Number);
    let seconds = 0;
    if (parts.length === 3) { // H:MM:SS
        seconds += parts[0] * 3600;
        seconds += parts[1] * 60;
        seconds += parts[2];
    } else if (parts.length === 2) { // MM:SS
        seconds += parts[0] * 60;
        seconds += parts[1];
    } else if (parts.length === 1) { // SS
        seconds += parts[0];
    }
    return seconds;
}

/**
 * Formats seconds into a time string (e.g., "1:05", "12:34:56").
 * @param {number} totalSeconds - The total seconds.
 * @returns {string} - The formatted time string.
 */
function formatTime(totalSeconds) {
    if (totalSeconds === Infinity || isNaN(totalSeconds) || totalSeconds < 0) {
        return 'N/A';
    }
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = Math.floor(totalSeconds % 60);

    const paddedSeconds = seconds.toString().padStart(2, '0');
    
    if (hours > 0) {
        const paddedMinutes = minutes.toString().padStart(2, '0');
        return `${hours}:${paddedMinutes}:${paddedSeconds}`;
    }
    return `${minutes}:${paddedSeconds}`;
}

/**

 * Scrolls the page to load all videos in the playlist.
 * @returns {Promise<void>}
 */
async function loadAllVideos() {
    updateStatus('Loading all videos...');
    console.log(`${LOG_PREFIX} Starting to scroll and load all videos.`);
    const contentContainer = document.querySelector("ytd-playlist-video-list-renderer #contents");
    if (!contentContainer) {
        updateStatus("Error: Could not find video container.", true);
        console.error(`${LOG_PREFIX} Could not find video container element.`);
        return;
    }

    let lastVideoCount = 0;
    let currentVideoCount = contentContainer.children.length;
    let retries = 0;
    const maxRetries = 5; // To prevent infinite loops if something goes wrong

    while (lastVideoCount < currentVideoCount || retries < maxRetries) {
        window.scrollTo(0, document.documentElement.scrollHeight);
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for new videos to load

        lastVideoCount = currentVideoCount;
        currentVideoCount = contentContainer.children.length;
        updateStatus(`Loading... Found ${currentVideoCount} videos.`);

        if (lastVideoCount === currentVideoCount) {
            retries++;
            console.log(`${LOG_PREFIX} Scroll retry #${retries}. Video count is stable at ${currentVideoCount}.`);
        } else {
            retries = 0; // Reset retries if new videos were loaded
        }
    }
    console.log(`${LOG_PREFIX} Finished loading videos. Total found: ${currentVideoCount}.`);
}

/**
 * Gathers video data from the DOM.
 * @returns {Array<Object>} - An array of video objects.
 */
function getVideoData() {
    console.log(`${LOG_PREFIX} Gathering video data from DOM...`);
    const videoElements = Array.from(document.querySelectorAll('ytd-playlist-video-renderer'));
    console.log(`${LOG_PREFIX} Found ${videoElements.length} video elements.`);
    
    const videoData = videoElements.map((el, index) => {
        const titleEl = el.querySelector('#video-title');
        // Use a more specific selector for the time element
        const timeEl = el.querySelector('ytd-thumbnail-overlay-time-status-renderer #text');
        
        return {
            title: titleEl ? titleEl.textContent.trim() : 'Unknown Title',
            duration: timeEl ? parseTime(timeEl.textContent.trim()) : Infinity,
            originalIndex: index
        };
    });

    if (videoData.length > 0) {
        console.log(`${LOG_PREFIX} Sample video data:`, { title: videoData[0].title, duration: videoData[0].duration });
    }
    return videoData;
}

/**
 * Finds a video's DOM element in the playlist by its title.
 * @param {string} title - The title of the video to find.
 * @returns {HTMLElement|null} - The found element or null.
 */
function findVideoElementByTitle(title) {
    console.log(`${LOG_PREFIX} Searching for video element with title: "${title}"`);
    const videoElements = Array.from(document.querySelectorAll('ytd-playlist-video-renderer'));
    const foundElement = videoElements.find(el => {
        const titleEl = el.querySelector('#video-title');
        return titleEl && titleEl.textContent.trim() === title;
    });
    if (foundElement) {
        console.log(`${LOG_PREFIX} Found element for "${title}".`);
    }
    return foundElement;
}

/**
 * Waits for a specified element to appear at the top of the playlist.
 * This is used to confirm that a "Move to top" operation has completed.
 * @param {HTMLElement} elementToMove - The element that was moved.
 */
async function waitForElementToMove(elementToMove) {
    const titleToFind = elementToMove.querySelector('#video-title')?.textContent.trim();
    if (!titleToFind) {
        console.warn(`${LOG_PREFIX} Cannot verify move, element has no title. Falling back to fixed wait.`);
        await new Promise(r => setTimeout(r, 1000)); // Fallback to a fixed wait
        return;
    }

    console.log(`${LOG_PREFIX} Waiting for "${titleToFind}" to appear at the top...`);
    const maxRetries = 10;
    const retryDelay = 500; // 500ms between checks

    for (let i = 0; i < maxRetries; i++) {
        await new Promise(r => setTimeout(r, retryDelay));
        
        const firstVideo = document.querySelector('ytd-playlist-video-list-renderer #contents ytd-playlist-video-renderer');
        if (firstVideo) {
            const firstVideoTitle = firstVideo.querySelector('#video-title')?.textContent.trim();
            if (firstVideoTitle === titleToFind) {
                console.log(`${LOG_PREFIX} Verified that "${titleToFind}" is now at the top.`);
                // Add a small extra delay for any final UI animations to settle.
                await new Promise(r => setTimeout(r, 250));
                return;
            }
        }
    }
    console.warn(`${LOG_PREFIX} Could not verify that "${titleToFind}" moved to the top. The operation might have failed or the UI is slow. Proceeding anyway.`);
}

/**
 * Simulates clicking the "Move to top" menu item for a video.
 * This is more reliable than simulating drag-and-drop.
 * @param {HTMLElement} videoElement - The video element to move.
 */
async function moveToTop(videoElement) {
    const title = videoElement.querySelector('#video-title')?.textContent.trim() || 'Unknown Video';
    console.log(`${LOG_PREFIX} Moving to top: "${title}"`);

    // 1. Find and click the three-dot menu button for the video
    const menuButton = videoElement.querySelector('ytd-menu-renderer #button');
    if (!menuButton) {
        throw new Error(`Could not find menu button for: ${title}`);
    }
    menuButton.click();

    // Wait for the menu to appear. It's added to the body.
    await new Promise(r => setTimeout(r, 200));

    // 2. Find the "Move to top" option in the menu popup.
    // The menu popup is rendered in a `ytd-menu-popup-renderer` which is a sibling of `ytd-app`.
    const menuPopup = document.querySelector("ytd-menu-popup-renderer");
    if (!menuPopup) {
        menuButton.click(); // try to close the menu
        throw new Error(`Could not find menu popup for: ${title}`);
    }

    const menuItems = Array.from(menuPopup.querySelectorAll('ytd-menu-service-item-renderer'));
    const moveToTopItem = menuItems.find(item => {
        const textElement = item.querySelector('yt-formatted-string');
        return textElement && textElement.textContent.trim() === 'Move to top';
    });

    if (!moveToTopItem) {
        menuButton.click(); // try to close the menu
        console.error(`${LOG_PREFIX} Could not find "Move to top". Available items:`, menuItems.map(item => item.querySelector('yt-formatted-string')?.textContent.trim()).filter(Boolean));
        throw new Error(`Could not find "Move to top" option for: ${title}`);
    }
    moveToTopItem.click();

    // 3. Wait for the UI to update and confirm the move.
    await waitForElementToMove(videoElement);
    console.log(`${LOG_PREFIX} Successfully moved "${title}"`);
}


/**
 * Main reordering logic.
 * @param {number} maxDurationMinutes - Max duration to filter videos.
 * @param {string} sortOrder - 'asc' or 'desc'.
 */
async function reorderPlaylist(maxDurationMinutes, sortOrder) {
    console.log(`${LOG_PREFIX} Starting reorderPlaylist function.`);
    console.log(`${LOG_PREFIX} Options:`, { maxDurationMinutes, sortOrder });

    await loadAllVideos();
    
    const allVideos = getVideoData();
    if (allVideos.length === 0) {
        updateStatus("Playlist is empty or videos not found.", true);
        return;
    }

    updateStatus(`Found ${allVideos.length} videos. Filtering...`);
    const maxDurationSeconds = maxDurationMinutes * 60;

    const videosToReorder = allVideos.filter(v => v.duration <= maxDurationSeconds);

    if (videosToReorder.length === 0) {
        updateStatus(`No videos under ${maxDurationMinutes} minutes found.`, true);
        return;
    }

    // --- Display a preview and wait for confirmation ---
    const finalOrderVideos = [...videosToReorder];
    finalOrderVideos.sort((a, b) => (sortOrder === 'asc') ? a.duration - b.duration : b.duration - a.duration);

    // Log the final order to the console
    console.log(`${LOG_PREFIX} Final order preview:`);
    const consolePreview = finalOrderVideos.map((video, index) => ({
        '#': index + 1,
        'Title': video.title,
        'Length': formatTime(video.duration)
    }));
    console.table(consolePreview);

    const videoListString = finalOrderVideos.map((video, index) => {
        const formattedDuration = formatTime(video.duration);
        return `${index + 1}. ${video.title} (${formattedDuration})`;
    }).join('<br>');

    const previewHtml = `<b>Final Order Preview:</b><br><div style="text-align:left; max-height: 150px; overflow-y: auto; border: 1px solid #ccc; padding: 5px; margin-top: 5px; font-style: normal; background: #fff;">${videoListString}</div>`;
    updateStatus(previewHtml, false, true); // done=false, confirm=true

    const userResponse = await new Promise(resolve => {
        const listener = (request, sender, sendResponse) => {
            if (request.action === 'proceedReorder' || request.action === 'cancelReorder') {
                chrome.runtime.onMessage.removeListener(listener);
                resolve(request.action);
            }
        };
        chrome.runtime.onMessage.addListener(listener);
    });

    if (userResponse === 'cancelReorder') {
        console.log(`${LOG_PREFIX} Reordering cancelled by user.`);
        // The popup will handle the UI reset and status message.
        return;
    }
    // --- End of confirmation logic ---


    updateStatus(`Found ${videosToReorder.length} videos to reorder. Sorting...`);
    console.log(`${LOG_PREFIX} ${videosToReorder.length} videos to reorder.`);

    // To move items to the top of the playlist one by one, we need to process them
    // in the reverse of the desired final order.
    // For 'asc' (shortest to longest), we move the longest videos first.
    // For 'desc' (longest to shortest), we move the shortest videos first.
    const reverseSort = (sortOrder === 'asc');
    videosToReorder.sort((a, b) => reverseSort ? b.duration - a.duration : a.duration - b.duration);

    for (let i = 0; i < videosToReorder.length; i++) {
        const videoInfo = videosToReorder[i];

        updateStatus(`Moving video ${i + 1} of ${videosToReorder.length}: ${videoInfo.title}`);
        
        let videoElement = findVideoElementByTitle(videoInfo.title);

        // If the element isn't found, the DOM might have changed. Re-scan and try again once.
        if (!videoElement) {
            console.warn(`${LOG_PREFIX} Could not find video: "${videoInfo.title}". Re-scanning page...`);
            updateStatus(`Could not find "${videoInfo.title}", re-scanning...`);
            await loadAllVideos();
            videoElement = findVideoElementByTitle(videoInfo.title);

            if (!videoElement) {
                console.error(`${LOG_PREFIX} Still could not find video: "${videoInfo.title}" after re-scan. Skipping.`);
                updateStatus(`Skipping missing video: ${videoInfo.title}`);
                continue;
            }
        }

        await moveToTop(videoElement);
    }

    updateStatus('Reordering complete!', true);
    console.log(`${LOG_PREFIX} Reordering process finished.`);
}


// Listen for the message from the popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log(`${LOG_PREFIX} Message received from popup:`, request);
    if (request.action === "reorder") {
        reorderPlaylist(request.maxDuration, request.sortOrder)
            .catch(err => {
                console.error(`${LOG_PREFIX} Reordering failed with an error:`, err);
                updateStatus(`Error: ${err.message}`, true);
            });
    }
});

console.log(`${LOG_PREFIX} Content script loaded and listening for messages.`);