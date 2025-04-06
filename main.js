const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");
const fs = require("fs");

const BATCH_SIZE = 100; // Maximum batch size for API
const MAX_RETRIES = 5;
const BASE_DELAY = 200; // Reduced delay between requests
const BACKOFF_FACTOR = 1.5; // Reduced backoff factor for faster retry
const MAX_CONCURRENT_BATCHES = 8; // Number of concurrent batch requests

// Add delay function
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Proxy configuration
let proxyList = [];
let currentProxyIndex = 0;

// Global variable to track if target was found so all processes can stop
let TARGET_FOUND = false;

// Load proxies from file
function loadProxiesFromFile(filePath = "proxy.txt") {
  try {
    const data = fs.readFileSync(filePath, "utf8");
    const lines = data.split("\n").filter((line) => line.trim() !== "");

    proxyList = lines.map((line) => {
      const [host, port, username, password] = line.split(":");
      return {
        host,
        port,
        username,
        password,
        url: `http://${username}:${password}@${host}:${port}`,
      };
    });

    console.log(`Loaded ${proxyList.length} proxies from ${filePath}`);
    return proxyList.length > 0;
  } catch (error) {
    console.error(`Error loading proxies: ${error.message}`);
    return false;
  }
}

// Get next proxy in FIFO order
function getNextProxy() {
  if (proxyList.length === 0) return null;

  const proxy = proxyList[currentProxyIndex];
  currentProxyIndex = (currentProxyIndex + 1) % proxyList.length;

  return proxy.url;
}

const setupAxiosWithProxy = (proxyUrl) => {
  try {
    const httpsAgent = new HttpsProxyAgent(proxyUrl);
    return axios.create({
      httpsAgent,
      proxy: false, // Important when using agent directly
      timeout: 10000, // Add timeout to avoid hanging requests
    });
  } catch (error) {
    console.error(`Error creating proxy agent: ${error.message}`);
    return axios; // Fallback to regular axios
  }
};

// Use proxy or fallback to regular axios
let axiosInstance = axios;
const useProxy = (proxyUrl) => {
  if (proxyUrl) {
    axiosInstance = setupAxiosWithProxy(proxyUrl);
  } else {
    axiosInstance = axios;
  }
};

// Core API functions
async function getTargetUserId(username) {
  try {
    const proxyUrl = getNextProxy();
    if (proxyUrl) useProxy(proxyUrl);

    const response = await axiosInstance.post(
      `https://users.roblox.com/v1/usernames/users`,
      {
        usernames: [username],
        excludeBannedUsers: true,
      }
    );

    if (response.data.data.length === 0) {
      console.log(`User ${username} not found`);
      return null;
    }

    return response.data.data[0].id;
  } catch (error) {
    console.log(`Error getting user ID: ${error.message}`);
    return null;
  }
}

async function getTargetProfileURL(userId) {
  try {
    const proxyUrl = getNextProxy();
    if (proxyUrl) useProxy(proxyUrl);

    const response = await axiosInstance.request({
      method: "post",
      maxBodyLength: Infinity,
      url: "https://thumbnails.roblox.com/v1/batch",
      headers: {
        "Content-Type": "application/json",
      },
      data: JSON.stringify([
        {
          type: "AvatarHeadShot",
          targetId: userId,
          format: "webp",
          size: "48x48",
        },
      ]),
    });

    if (!response.data.data[0] || !response.data.data[0].imageUrl) {
      console.log(`Could not get profile image for userId ${userId}`);
      return null;
    }

    return response.data.data[0].imageUrl;
  } catch (error) {
    console.log(`Error getting target profile URL: ${error.message}`);
    return null;
  }
}

async function getProfilesByTokensWithRequestId(tokens, requestIds) {
  try {
    const proxyUrl = getNextProxy();
    if (proxyUrl) useProxy(proxyUrl);

    // Create batch request for multiple tokens with requestId
    const batchData = tokens.map((token, index) => ({
      type: "AvatarHeadShot",
      token: token,
      format: "webp",
      size: "48x48",
      requestId: requestIds[index],
    }));

    const response = await axiosInstance.request({
      method: "post",
      maxBodyLength: Infinity,
      url: "https://thumbnails.roblox.com/v1/batch",
      headers: {
        "Content-Type": "application/json",
      },
      data: JSON.stringify(batchData),
    });

    // Create a token to profile mapping
    const profileMap = {};

    // Map responses back to tokens
    response.data.data.forEach((profile, index) => {
      if (index < tokens.length && profile.imageUrl) {
        profileMap[tokens[index]] = {
          imageUrl: profile.imageUrl,
          requestId: profile.requestId,
        };
      }
    });

    return profileMap;
  } catch (error) {
    console.log(`Error getting profiles: ${error.message}`);
    return {};
  }
}

// Add a cancel function for Promises
function createCancelablePromise(promise) {
  let hasCanceled = false;

  const wrappedPromise = new Promise((resolve, reject) => {
    promise
      .then((val) => {
        if (hasCanceled) {
          // Instead of rejecting with error object, just resolve with a cancel status
          resolve({ found: false, aborted: true, silent: true });
        } else {
          resolve(val);
        }
      })
      .catch((error) => {
        if (hasCanceled) {
          // Instead of rejecting with error object, just resolve with a cancel status
          resolve({ found: false, aborted: true, silent: true });
        } else {
          reject(error);
        }
      });
  });

  return {
    promise: wrappedPromise,
    cancel: () => {
      hasCanceled = true;
    },
  };
}

// Main search function
async function searchServersForTarget(
  placeId,
  targetProfileURL,
  cursor = "",
  pageNum = 1,
  retryCount = 0
) {
  // If target already found in another search, abort immediately
  if (TARGET_FOUND) {
    console.log(
      `Aborting search on page ${pageNum} - target already found elsewhere`
    );
    return { found: false, aborted: true };
  }

  try {
    const proxyUrl = getNextProxy();
    if (proxyUrl) useProxy(proxyUrl);

    // Minimal delay between requests
    await delay(100);

    console.log(
      `Loading servers page ${pageNum} | Cursor: ${cursor || "initial"}`
    );

    // Get servers data for this page
    const response = await axiosInstance.request({
      method: "get",
      maxBodyLength: Infinity,
      url: `https://games.roblox.com/v1/games/${placeId}/servers/Public?sortOrder=Desc&excludeFullGames=false&limit=100&cursor=${cursor}`,
      headers: {},
      timeout: 5000, // Reduced timeout for faster failure detection
    });

    const servers = response.data.data;
    if (!servers || servers.length === 0) {
      console.log(`No servers found on page ${pageNum}`);
      return { found: false, error: "No servers found" };
    }

    // Check if target already found while we were fetching
    if (TARGET_FOUND) {
      console.log(
        `Aborting search on page ${pageNum} - target found elsewhere while fetching`
      );
      return { found: false, aborted: true };
    }

    // Prepare to check servers in this page
    // Start processing this page while also requesting the next page in parallel
    let nextPagePromise = null;
    let nextPageCancelable = null;
    if (response.data.nextPageCursor) {
      console.log(
        `Pre-fetching next page (${pageNum + 1}) while processing current page`
      );
      // Start fetching the next page without waiting for this one to complete
      nextPagePromise = searchServersForTarget(
        placeId,
        targetProfileURL,
        response.data.nextPageCursor,
        pageNum + 1,
        0
      );
      nextPageCancelable = createCancelablePromise(nextPagePromise);
    }

    console.log(
      `Page ${pageNum}: Processing ${
        servers.length
      } servers with ${servers.reduce(
        (sum, server) => sum + server.playerTokens.length,
        0
      )} players`
    );

    // Collect all tokens from all servers on this page
    const allTokens = [];
    const requestIds = [];
    const serverMap = {};

    // Prioritize servers with more players and lower ping (likely to be more popular and stable)
    servers.sort((a, b) => {
      // First sort by player count (descending)
      const playerDiff = b.playerTokens.length - a.playerTokens.length;
      if (playerDiff !== 0) return playerDiff;

      // If equal player count, sort by ping (ascending)
      return (a.ping || 999) - (b.ping || 999);
    });

    for (const server of servers) {
      serverMap[server.id] = server;
      for (const token of server.playerTokens) {
        allTokens.push(token);
        requestIds.push(server.id);
      }
    }

    // Process tokens in parallel batches
    let matchFound = false;
    let foundServer = null;
    let foundToken = null;

    // Break tokens into batches
    const batches = [];
    for (let i = 0; i < allTokens.length; i += BATCH_SIZE) {
      batches.push({
        tokens: allTokens.slice(i, i + BATCH_SIZE),
        requestIds: requestIds.slice(i, i + BATCH_SIZE),
      });
    }

    console.log(
      `Processing ${batches.length} batches in parallel groups of ${MAX_CONCURRENT_BATCHES}`
    );

    // Track all active batch promises so we can abort them if needed
    const activeBatchPromises = [];

    // Process batches in parallel groups
    for (
      let i = 0;
      i < batches.length && !matchFound && !TARGET_FOUND;
      i += MAX_CONCURRENT_BATCHES
    ) {
      // Check if target already found in another search
      if (TARGET_FOUND) {
        console.log(
          `Aborting batch processing - target already found elsewhere`
        );
        break;
      }

      const batchGroup = batches.slice(i, i + MAX_CONCURRENT_BATCHES);

      console.log(
        `Processing batch group ${
          Math.floor(i / MAX_CONCURRENT_BATCHES) + 1
        }/${Math.ceil(batches.length / MAX_CONCURRENT_BATCHES)}`
      );

      // Process each batch in this group concurrently
      const batchPromises = batchGroup.map(async (batch, idx) => {
        // Check if target already found
        if (TARGET_FOUND) {
          return { found: false, aborted: true };
        }

        try {
          console.log(
            `Starting batch ${i + idx + 1}/${batches.length} with ${
              batch.tokens.length
            } tokens`
          );

          // Use a unique proxy for each concurrent batch if available
          const batchProxyUrl = getNextProxy();
          if (batchProxyUrl) useProxy(batchProxyUrl);

          const profileMap = await getProfilesByTokensWithRequestId(
            batch.tokens,
            batch.requestIds
          );

          // Check for matches
          for (let j = 0; j < batch.tokens.length; j++) {
            // Check if target already found elsewhere
            if (TARGET_FOUND) {
              return { found: false, aborted: true };
            }

            const token = batch.tokens[j];

            if (!profileMap[token] || !profileMap[token].imageUrl) continue;

            if (profileMap[token].imageUrl === targetProfileURL) {
              const serverId = profileMap[token].requestId;
              console.log(
                `\n✅ MATCH FOUND! Token: ${token.slice(
                  0,
                  10
                )}..., Server: ${serverId}`
              );

              // Set global flag so other searches can abort
              TARGET_FOUND = true;

              return {
                found: true,
                serverId,
                token,
                batchIndex: i + idx,
              };
            }
          }

          return { found: false };
        } catch (error) {
          // If target already found, don't report errors
          if (TARGET_FOUND) {
            return { found: false, aborted: true };
          }
          console.log(`Error in batch ${i + idx + 1}: ${error.message}`);
          return { found: false, error: error.message };
        }
      });

      // Store promises for potential cancellation
      activeBatchPromises.push(...batchPromises);

      // Wait for all batches in this group to complete or until a match is found
      const results = await Promise.all(batchPromises);

      // Check if any batch found a match
      const matchResult = results.find((r) => r.found);
      if (matchResult) {
        matchFound = true;
        foundServer = serverMap[matchResult.serverId];
        foundToken = matchResult.token;
        console.log(
          `✅ Found match in batch ${matchResult.batchIndex + 1}/${
            batches.length
          }`
        );

        // Set global flag to stop all other searches
        TARGET_FOUND = true;

        // Cancel the next page request
        if (nextPageCancelable) {
          console.log(`Canceling next page fetching`);
          nextPageCancelable.cancel();
        }

        break;
      }
    }

    if (matchFound && foundServer) {
      console.log(`\n✅ TARGET FOUND in server ${foundServer.id}!`);
      console.log(`Server details:`, foundServer);
      console.log(
        `Command: Roblox.GameLauncher.joinGameInstance(${placeId}, "${foundServer.id}")`
      );
      console.log(
        `\nSUCCESS: Target found! All other searches will be terminated.`
      );

      // Set global flag so other searches can abort
      TARGET_FOUND = true;

      return {
        found: true,
        serverId: foundServer.id,
        server: foundServer,
        token: foundToken,
      };
    }

    // If target was found in another search while we were processing
    if (TARGET_FOUND) {
      console.log(`Stopping page ${pageNum} search - target found elsewhere`);
      // Cancel next page request if it exists
      if (nextPageCancelable) {
        nextPageCancelable.cancel();
      }
      return { found: false, aborted: true };
    }

    // If we were pre-fetching the next page, wait for its result
    if (nextPagePromise && !TARGET_FOUND) {
      console.log(`Waiting for pre-fetched next page (${pageNum + 1}) results`);
      try {
        const nextPageResult = await nextPagePromise;
        // If it's a silent abort, don't show any messages
        if (nextPageResult && nextPageResult.silent) {
          return { found: false, aborted: true };
        }
        return nextPageResult;
      } catch (error) {
        // Never show cancelation errors
        if (TARGET_FOUND) {
          return { found: false, aborted: true };
        }

        // Only show error if we haven't found the target elsewhere
        if (!TARGET_FOUND) {
          console.log(`Error from next page promise: ${error}`);
        }
        return { found: false, error: "Next page error" };
      }
    } else {
      console.log(`Finished searching all server pages. Target not found.`);
      return { found: false };
    }
  } catch (error) {
    // If target was found while we were handling an error
    if (TARGET_FOUND) {
      console.log(
        `Aborting error handling on page ${pageNum} - target found elsewhere`
      );
      return { found: false, aborted: true };
    }

    console.log(`Error on page ${pageNum}: ${error.message}`);

    // Handle rate limiting with minimal backoff
    if (
      error.response &&
      error.response.status === 429 &&
      retryCount < MAX_RETRIES
    ) {
      console.log(
        `Rate limited on page ${pageNum}, retrying after delay... (Attempt ${
          retryCount + 1
        })`
      );
      const backoffTime = BASE_DELAY * Math.pow(BACKOFF_FACTOR, retryCount);
      await delay(backoffTime);
      return await searchServersForTarget(
        placeId,
        targetProfileURL,
        cursor,
        pageNum,
        retryCount + 1
      );
    } else if (retryCount >= MAX_RETRIES) {
      console.log(
        `Maximum retry attempts reached for page ${pageNum}. Aborting.`
      );
      return { found: false, error: "Max retries exceeded" };
    }

    return { found: false, error: error.message };
  }
}

// Main orchestration
async function findTargetInServers(username, placeId) {
  try {
    // Reset the global flag at the start of a new search
    TARGET_FOUND = false;

    console.log(`Starting search for ${username} in game ${placeId}`);

    const targetUserId = await getTargetUserId(username);
    if (!targetUserId) {
      console.log(`Could not find user ID for ${username}`);
      return { found: false, error: "User not found" };
    }

    const targetProfileURL = await getTargetProfileURL(targetUserId);
    if (!targetProfileURL) {
      console.log(
        `Could not get profile URL for ${username} (ID: ${targetUserId})`
      );
      return { found: false, error: "Profile image not found" };
    }

    console.log(
      `Target: ${username} | ID: ${targetUserId} | Profile: ${targetProfileURL}`
    );

    // Search for target in servers
    const result = await searchServersForTarget(placeId, targetProfileURL);

    // Final status
    if (result.found) {
      console.log(`\n✅ SEARCH COMPLETE: Found target successfully!`);
    } else if (TARGET_FOUND) {
      console.log(`\n✅ SEARCH COMPLETE: Target was found in another search.`);
    } else {
      console.log(`\n❌ SEARCH COMPLETE: Target not found in any server.`);
    }

    return result;
  } catch (error) {
    // If target was found in another process
    if (TARGET_FOUND) {
      console.log(
        `Error in findTargetInServers but target was already found elsewhere.`
      );
      return { found: true, note: "Found elsewhere" };
    }

    console.log(`Main search error: ${error.message}`);
    return { found: false, error: error.message };
  }
}

// Entry point
async function main() {
  try {
    console.time("searchTime");

    // Load proxies
    const proxiesLoaded = loadProxiesFromFile();
    if (!proxiesLoaded) {
      console.log("No proxies loaded. Using direct connection.");
    }

    const username = process.argv[2];
    const placeId = process.argv[3];

    console.log(`Starting search for ${username} in place ${placeId}`);

    const result = await findTargetInServers(username, placeId);

    console.timeEnd("searchTime");

    // Only show errors if target wasn't found
    if (!result.found && !TARGET_FOUND && result.error) {
      console.log(`Search failed: ${result.error}`);
    }

    return result;
  } catch (error) {
    // If target was found, don't show error
    if (TARGET_FOUND) {
      console.timeEnd("searchTime");
      return { found: true, note: "Found but there was an error in main" };
    }

    console.log(`Fatal error: ${error.message}`);
    console.timeEnd("searchTime");
    return { found: false, error: error.message };
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

// Export for potential module use
module.exports = { findTargetInServers, main };
