// Import required packages
const express = require("express");
const multer = require("multer");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { promisify } = require("util");
const tus = require("tus-js-client");
const dns = require("dns");
const mime = require("mime-types");
const crypto = require("crypto");
require("dotenv").config();

// Initialize Express app
const app = express();
app.use(express.json());
app.use(express.static("public"));
// Increased file size limits for Express
app.use(express.json({ limit: "2100mb" }));
app.use(express.urlencoded({ extended: true, limit: "2100mb" }));

// Configure multer for temporary file storag

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, "uploads/");
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + path.extname(file.originalname));
  },
});

// Increased file size limit to 2GB (plus some buffer)
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 2100 * 1024 * 1024, // 2.1GB max file size (extra buffer)
  },
});

// Ensure uploads directory exists
if (!fs.existsSync("uploads/")) {
  fs.mkdirSync("uploads/");
}

const STORAGE_ZONE = process.env.STORAGE_ZONE || "learningstream";
const STORAGE_API_KEY =
  process.env.STORAGE_API_KEY || "3c45cde6-2010-4744-999786804a31-854b-452a";
const BUNNY_API_URL = `https://storage.bunnycdn.com/${STORAGE_ZONE}`;
const BUNNY_TUS_URL = `https://video.bunnycdn.com/tusupload`;

// DNS lookup promise for network connectivity check
const dnsLookup = promisify(dns.lookup);

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

// Network connectivity check function
async function checkConnectivity() {
  try {
    await dnsLookup("video.bunnycdn.com");
    return true;
  } catch (error) {
    console.error("Network connectivity issue detected:", error.message);
    return false;
  }
}

// Create custom axios instance with retry capability
const axiosInstance = axios.create({
  timeout: 30000, // 30 seconds default timeout
});

// Axios retry interceptor
axiosInstance.interceptors.response.use(null, async (error) => {
  const config = error.config;

  // If config doesn't exist or retries not set, reject
  if (!config || !config.retry) {
    return Promise.reject(error);
  }

  // Set retry count
  config.retryCount = config.retryCount || 0;

  // Check if we've maxed out the total retry count
  if (config.retryCount >= config.retry) {
    return Promise.reject(error);
  }

  // Increase retry count
  config.retryCount += 1;

  // Check network connectivity before retrying
  const isConnected = await checkConnectivity();
  if (!isConnected) {
    console.log("No network connectivity, waiting longer before retry...");
    await new Promise((resolve) => setTimeout(resolve, 10000)); // Wait 10 seconds
  }

  // Create new promise to handle retry
  const backoff = new Promise((resolve) => {
    console.log(
      `Retrying request (${config.retryCount}/${config.retry}), waiting ${
        config.retryDelay * config.retryCount
      }ms...`
    );
    setTimeout(() => {
      resolve();
    }, config.retryDelay * config.retryCount);
  });

  // Wait for backoff then retry request
  await backoff;
  return axiosInstance(config);
});

// Create video in Bunny Stream with retry logic

async function createVideoToStorageZone(
  filePath,
  storageZoneName,
  storageApiKey
) {
  const fileName = path.basename(filePath);
  const uploadUrl = `https://storage.bunnycdn.com/${storageZoneName}/${fileName}`;
  console.log(fileName, uploadUrl, filePath);

  let attempts = 0;
  const maxAttempts = 5;

  while (attempts < maxAttempts) {
    try {
      const isConnected = await checkConnectivity();
      if (!isConnected) {
        console.log("No network connection. Retrying in 5 seconds...");
        await new Promise((resolve) => setTimeout(resolve, 5000));
        attempts++;
        continue;
      }

      const fileData = fs.readFileSync(filePath);

      console.log(
        `Uploading ${fileName} to ${uploadUrl} (Attempt ${
          attempts + 1
        }/${maxAttempts})`
      );

      const response = await axios.put(uploadUrl, fileData, {
        headers: {
          AccessKey: storageApiKey,
          "Content-Type": "application/octet-stream",
        },
        timeout: 30000,
      });

      console.log("Upload successful:", response);
      return { success: true, fileName };
    } catch (error) {
      attempts++;
      console.error(`Upload failed (Attempt ${attempts}): ${error.message}`);

      if (attempts >= maxAttempts) {
        throw new Error(
          `Failed to upload video after ${maxAttempts} attempts.`
        );
      }


      const backoff = Math.pow(2, attempts) * 1000;
      console.log(`Retrying in ${backoff / 1000} seconds...`);
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }
}

// async function uploadWithRetry(filePath, videoId, maxRetries = 5) {
//   let attempt = 0;
//   let lastError = null;

//   while (attempt <= maxRetries) {
//     try {
//       attempt++;
//       console.log(`Upload attempt ${attempt}/${maxRetries + 1}`);

//       // Check network connectivity before attempting
//       const isConnected = await checkConnectivity();
//       if (!isConnected) {
//         console.log(
//           "Network connectivity issues detected, waiting before retry..."
//         );
//         await new Promise((resolve) => setTimeout(resolve, 10000)); // 10 second wait
//         continue;
//       }

//       // Try TUS upload first
//       try {
//         return await uploadWithTus(filePath, videoId);
//       } catch (tusError) {
//         console.warn(
//           `TUS upload failed, falling back to direct upload: ${tusError.message}`
//         );
//         // If TUS fails, try direct upload as fallback
//         return await uploadDirectly(filePath, videoId);
//       }
//     } catch (error) {
//       lastError = error;
//       console.error(
//         `Upload attempt ${attempt} failed: ${error.message || error}`
//       );

//       // For network related errors, we should always retry
//       const networkErrors = [
//         "ECONNRESET",
//         "ETIMEDOUT",
//         "ESOCKETTIMEDOUT",
//         "socket hang up",
//         "network",
//         "timeout",
//         "aborted",
//       ];

//       const shouldRetry = networkErrors.some(
//         (errType) =>
//           (error.message &&
//             error.message.toLowerCase().includes(errType.toLowerCase())) ||
//           (error.code && error.code === errType)
//       );

//       if (!shouldRetry || attempt > maxRetries) {
//         console.error(`Failed to upload after ${attempt} attempts`);
//         throw new Error(
//           `Upload failed after ${attempt} attempts: ${lastError.message}`
//         );
//       }

//       // Exponential backoff with jitter
//       const baseDelay = Math.pow(2, attempt) * 3000; // Base of 3 seconds
//       const jitter = Math.random() * 1000; // Add up to 1 second of jitter
//       const delay = baseDelay + jitter;

//       console.log(`Retrying upload in ${(delay / 1000).toFixed(1)} seconds...`);
//       await new Promise((resolve) => setTimeout(resolve, delay));
//     }
//   }

//   throw new Error(
//     `Upload failed after all ${maxRetries + 1} attempts: ${lastError?.message}`
//   );
// }

async function listVideos(storageZoneName, storageApiKey, folder = "") {
  try {
    const isConnected = await checkConnectivity();
    if (!isConnected) {
      throw new Error("No internet connection.");
    }

    const url = `https://storage.bunnycdn.com/${storageZoneName}/${folder}`;
    const response = await axios.get(url, {
      headers: {
        AccessKey: storageApiKey,
      },
      timeout: 20000,
    });

    const files = response.data;

    // Optional: filter for video file types
    const videoFiles = files.filter((file) =>
      file.ObjectName.match(/\.(mp4|mov|avi|mkv)$/i)
    );

    return videoFiles;
  } catch (error) {
    console.error(
      "Failed to list videos:",
      error.response?.data || error.message
    );
    throw error;
  }
}

async function uploadWithRetry(
  filePath,
  videoId,
  maxRetries = 5,
  progressCallback
) {
  let attempt = 0;
  let lastError = null;

  while (attempt <= maxRetries) {
    try {
      attempt++;
      console.log("upload with retry 298")
      console.log(`Upload attempt ${attempt}/${maxRetries + 1}`);

      // Check network connectivity before attempting
      const isConnected = await checkConnectivity();
      if (!isConnected) {
        console.log(
          "Network connectivity issues detected, waiting before retry..."
        );
        await new Promise((resolve) => setTimeout(resolve, 10000)); // 10 second wait
        continue;
      }

      // Try TUS upload first with progress callback
      console.log("upload with tus")
      try {
        return await uploadWithTus(filePath, videoId, progressCallback);
      } catch (tusError) {
        console.warn(
          `TUS upload failed, falling back to direct upload: ${tusError.message}`
        );
        // If TUS fails, try direct upload as fallback with progress callback
        console.log("upload with directly")

        return await uploadDirectly(filePath, videoId, progressCallback);
      }
    } catch (error) {
      lastError = error;
      console.error(
        `Upload attempt ${attempt} failed: ${error.message || error}`
      );

      // For network related errors, we should always retry
      const networkErrors = [
        "ECONNRESET",
        "ETIMEDOUT",
        "ESOCKETTIMEDOUT",
        "socket hang up",
        "network",
        "timeout",
        "aborted",
      ];

      const shouldRetry = networkErrors.some(
        (errType) =>
          (error.message &&
            error.message.toLowerCase().includes(errType.toLowerCase())) ||
          (error.code && error.code === errType)
      );

      if (!shouldRetry || attempt > maxRetries) {
        console.error(`Failed to upload after ${attempt} attempts`);
        throw new Error(
          `Upload failed after ${attempt} attempts: ${lastError.message}`
        );
      }

      // Exponential backoff with jitter
      const baseDelay = Math.pow(2, attempt) * 3000; // Base of 3 seconds
      const jitter = Math.random() * 1000; // Add up to 1 second of jitter
      const delay = baseDelay + jitter;

      console.log(`Retrying upload in ${(delay / 1000).toFixed(1)} seconds...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw new Error(
    `Upload failed after all ${maxRetries + 1} attempts: ${lastError?.message}`
  );
}

// Fix the uploadWithTus function to properly handle progress callbacks
async function uploadWithTus(filePath, videoId, progressCallback) {
  return new Promise(async (resolve, reject) => {
    try {
      console.log(`Starting TUS upload for video ID: ${videoId}`);
      // Create upload instance
      const fileSize = fs.statSync(filePath).size;
      const fileStream = fs.createReadStream(filePath);
      const fileName = path.basename(filePath);

      // Make sure videoId is properly encoded
      const encodedVideoId = Buffer.from(videoId).toString("base64");

      console.log(`Using videoId: ${videoId} (encoded: ${encodedVideoId})`);
      console.log(`File size: ${fileSize} bytes`);
      const uploadUrl = `https://video.bunnycdn.com/tusupload?videoId=${encodedVideoId}`;

      const fileType = mime.lookup(filePath) || "application/octet-stream";

      const upload = new tus.Upload(fileStream, {
        endpoint: uploadUrl,
        metadata: {
          filename: Buffer.from(fileName).toString("base64"),
          filetype: Buffer.from(fileType).toString("base64"),
        },
        uploadSize: fileSize,
        retryDelays: [0, 1000, 3000],
        onError: function (error) {
          console.error("Upload failed:", error);
          reject(error);
        },
        onProgress: function (bytesUploaded, bytesTotal) {
          const percentage = ((bytesUploaded / bytesTotal) * 100).toFixed(2);
          console.log(
            `Uploaded: ${bytesUploaded} / ${bytesTotal} (${percentage}%)`
          );

          // Call the progress callback if provided
          if (typeof progressCallback === "function") {
            progressCallback(parseFloat(percentage), bytesUploaded, bytesTotal);
          }
        },
        onSuccess: function () {
          console.log("TUS Upload finished:", upload.url);
          resolve(upload.url);
        },
      });

      upload.start();
    } catch (error) {
      console.error(`Error initializing TUS upload: ${error.message}`);
      reject(error);
    }
  });
}

// Fix the Direct upload function to properly handle progress callbacks
async function uploadDirectly(filePath, videoId, progressCallback) {
  try {
    console.log(`Starting direct upload for video ID: ${videoId}`);

    const fileStream = fs.createReadStream(filePath);
    const fileName = path.basename(filePath);
    const fileType = mime.lookup(filePath) || "application/octet-stream";
    const fileSize = fs.statSync(filePath).size;

    console.log(
      `File: ${fileName}, Size: ${fileSize} bytes, Type: ${fileType}`
    );

    // Create form data for direct upload
    const response = await axiosInstance.put(
      `${BUNNY_API_URL}/${fileName}`,
      fileStream,
      {
        headers: {
          AccessKey: STORAGE_API_KEY,
          "Content-Type": fileType,
          "Content-Length": fileSize,
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: 3600000, // 1 hour timeout
        retry: 3,
        retryDelay: 5000,
        onUploadProgress: (progressEvent) => {
          // Handle when total is unknown (older browsers)
          const total = progressEvent.total || fileSize;
          const percentage = ((progressEvent.loaded / total) * 100).toFixed(2);
          console.log(`Direct upload progress: ${percentage}%`);

          // Call the progress callback if provided
          if (typeof progressCallback === "function") {
            progressCallback(
              parseFloat(percentage),
              progressEvent.loaded,
              total
            );
          }
        },
      }
    );

    console.log("Direct upload completed successfully");
    return response.data;
  } catch (error) {
    console.error(`Direct upload failed: ${error.message}`);
    throw error;
  }
}

// Middleware to check connectivity before processing requests
app.use(async (req, res, next) => {
  if (req.path === "/check-connectivity") {
    return next(); // Skip check for the connectivity endpoint
  }

  const isConnected = await checkConnectivity();
  if (!isConnected) {
    return res.status(503).json({
      error: "Network connectivity issue",
      message:
        "Unable to reach Bunny.net servers. Please check your internet connection and try again later.",
    });
  }
  next();
});

async function getVideoDetails(storageZoneName, path, apiKey) {
  try {
    const response = await axios.get(
      `https://storage.bunnycdn.com/${storageZoneName}/${path}`,
      {
        headers: {
          AccessKey: apiKey,
        },
      }
    );
    return response.data; // returns array of files and their details
  } catch (error) {
    console.error('Error getting video details from Bunny Storage Zone:', error.response?.data || error.message);
    return null;
  }
}


// Add a connectivity check endpoint
app.get("/check-connectivity", async (req, res) => {
  const isConnected = await checkConnectivity();
  res.status(200).json({
    connected: isConnected,
    timestamp: new Date().toISOString(),
  });
});

// Modified endpoint to track upload progress
app.post("/upload", upload.single("video"), async (req, res) => {
  // Create a unique upload ID for this upload
  const uploadId = Date.now().toString();

  // Store progress information
  const progressData = {
    progress: 0,
    bytesUploaded: 0,
    bytesTotal: 0,
    status: "preparing",
    error: null,
  };

  // Store the progress data in a global map
  if (!global.uploadProgress) {
    global.uploadProgress = new Map();
  }
  global.uploadProgress.set(uploadId, progressData);

  // Send initial response with upload ID
  res.status(202).json({
    uploadId: uploadId,
    message: "Upload started",
    statusUrl: `/upload-status/${uploadId}`,
  });

  // Process upload in background
  (async function () {
    try {
      if (!req.file) {
        progressData.status = "failed";
        progressData.error = "No video file uploaded";
        return;
      }

      const filePath = req.file.path;
      progressData.status = "creating";

      const videoTitle =
        req.body.title ||
        path.basename(
          req.file.originalname,
          path.extname(req.file.originalname)
        );
      const collectionId = req.body.collectionId || "";

      // Update file size
      const fileSize = fs.statSync(filePath).size;
      progressData.bytesTotal = fileSize;

      // 1. Create video in Bunny Stream
      const videoData = await createVideoToStorageZone(
        filePath,
        STORAGE_ZONE,
        STORAGE_API_KEY
      );
      console.log("Video created in Bunny.net:", videoData);
      progressData.status = "uploading";
      progressData.videoId = videoData.guid;

      // 2. Upload the video file with progress tracking
      try {
        // Define progress callback and ensure it updates the global progress object
        const progressCallback = (percent, bytesUploaded, bytesTotal) => {
          // Update progress data object in the global map
          if (global.uploadProgress && global.uploadProgress.has(uploadId)) {
            const progressObj = global.uploadProgress.get(uploadId);
            progressObj.progress = percent;
            progressObj.bytesUploaded = bytesUploaded;
            progressObj.bytesTotal = bytesTotal || progressObj.bytesTotal;
            // Update the map
            global.uploadProgress.set(uploadId, progressObj);
          }
        };

        // Pass the progress callback to uploadWithRetry
        await uploadWithRetry(filePath, videoData.guid, 5, progressCallback);

        // Update progress status after successful upload
        if (global.uploadProgress && global.uploadProgress.has(uploadId)) {
          const progressObj = global.uploadProgress.get(uploadId);
          progressObj.status = "processing";
          progressObj.progress = 100;
          global.uploadProgress.set(uploadId, progressObj);
        }

        // 3. Get updated video details
        const videoDetails = await getVideoDetails(STORAGE_ZONE,videoData.fileName,STORAGE_API_KEY);

        // Final progress update
        if (global.uploadProgress && global.uploadProgress.has(uploadId)) {
          const progressObj = global.uploadProgress.get(uploadId);
          progressObj.status = "completed";
          progressObj.videoDetails = videoDetails;
          global.uploadProgress.set(uploadId, progressObj);
        }
      } catch (uploadError) {
        if (global.uploadProgress && global.uploadProgress.has(uploadId)) {
          const progressObj = global.uploadProgress.get(uploadId);
          progressObj.status = "failed";
          progressObj.error = `Upload failed: ${uploadError.message}`;
          global.uploadProgress.set(uploadId, progressObj);
        }
        console.error("Upload failed after all retries:", uploadError.message);
      }

      // 4. Delete temporary file
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (error) {
      console.error("Upload process failed:", error);
      if (global.uploadProgress && global.uploadProgress.has(uploadId)) {
        const progressObj = global.uploadProgress.get(uploadId);
        progressObj.status = "failed";
        progressObj.error = error.message;
        global.uploadProgress.set(uploadId, progressObj);
      }

      // Clean up temp file if it exists
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
    }
  })();
});

// Add endpoint to check upload status that returns fresh data
app.get("/upload-status/:uploadId", (req, res) => {
  const uploadId = req.params.uploadId;

  if (!global.uploadProgress || !global.uploadProgress.has(uploadId)) {
    return res.status(404).json({
      error: "Upload not found",
    });
  }

  const progressData = global.uploadProgress.get(uploadId);

  // If upload is completed or failed, we could remove it from memory after some time
  if (progressData.status === "completed" || progressData.status === "failed") {
    // Schedule cleanup after 5 minutes
    setTimeout(() => {
      if (global.uploadProgress && global.uploadProgress.has(uploadId)) {
        global.uploadProgress.delete(uploadId);
      }
    }, 5 * 60 * 1000);
  }

  res.status(200).json(progressData);
});

// Endpoint to get a list of videos
app.get("/videos", async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const itemsPerPage = parseInt(req.query.itemsPerPage) || 10;

    const videos = await listVideos(STORAGE_ZONE, STORAGE_API_KEY);
    console.log("/videos",videos);
    res.status(200).json(videos);
  } catch (error) {
    console.error("Error fetching videos:", error);
    res.status(500).json({
      error: "Failed to fetch videos",
      details: error.message,
      recommendation: error.message.includes("Network")
        ? "Please check your internet connection and try again"
        : "Please try again later",
    });
  }
});

// Endpoint to get video details
app.get("/videos/:videoId", async (req, res) => {
  try {
    const videoDetails = await getVideoDetails(STORAGE_ZONE,videoData.fileName,STORAGE_API_KEY);
    console.log(videoDetails);
    res.status(200).json(videoDetails);
  } catch (error) {
    console.error("Error fetching video details:", error);
    res.status(500).json({
      error: "Failed to fetch video details",
      details: error.message,
      recommendation: error.message.includes("Network")
        ? "Please check your internet connection and try again"
        : "Please try again later",
    });
  }
});

// HTML page for video upload form
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Video upload server is ready to handle uploads up to 2GB`);
});
