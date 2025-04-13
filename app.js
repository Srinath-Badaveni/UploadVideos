// Import required packages
const express = require("express");
const multer = require("multer");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { promisify } = require("util");
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

// Set EJS as view engine
app.set('view engine', 'ejs');

// Configure multer for temporary file storage
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

// Bunny Storage configuration
const STORAGE_ZONE = process.env.STORAGE_ZONE || "learningstream";
const STORAGE_API_KEY = process.env.STORAGE_API_KEY || "3c45cde6-2010-4744-999786804a31-854b-452a";
const STORAGE_URL = `https://storage.bunnycdn.com/${STORAGE_ZONE}`;
const CDN_URL = process.env.CDN_URL || `https://${STORAGE_ZONE}.b-cdn.net`;

// DNS lookup promise for network connectivity check
const dnsLookup = promisify(dns.lookup);

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

// Network connectivity check function
async function checkConnectivity() {
  try {
    await dnsLookup("storage.bunnycdn.com");
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

// Upload to Bunny Storage with retry logic
async function uploadToBunnyStorage(filePath, fileName, maxRetries = 5) {
  let attempts = 0;
  const maxAttempts = maxRetries;

  while (attempts < maxAttempts) {
    try {
      // Check network connectivity
      const isConnected = await checkConnectivity();
      if (!isConnected) {
        console.log("No network connection detected. Waiting before retry...");
        await new Promise((resolve) => setTimeout(resolve, 5000)); // 5 second wait
        attempts++;
        continue;
      }

      console.log(
        `Attempting to upload to Bunny Storage: ${STORAGE_URL}/${fileName} (attempt ${
          attempts + 1
        }/${maxAttempts})`
      );

      const fileBuffer = fs.readFileSync(filePath);
      const response = await axiosInstance.put(
        `${STORAGE_URL}/${fileName}`,
        fileBuffer,
        {
          headers: {
            AccessKey: STORAGE_API_KEY,
            "Content-Type": "application/octet-stream",
          },
          timeout: 60000, // 60 seconds timeout
          retry: 3,
          retryDelay: 2000,
        }
      );
      
      return {
        success: true,
        url: `${CDN_URL}/${fileName}`,
        response: response.data
      };
    } catch (error) {
      attempts++;

      if (error.code === "ENOTFOUND") {
        console.error(
          "DNS resolution failed. Cannot connect to Bunny.net API."
        );
        console.error(
          "Please check your internet connection and DNS settings."
        );
      } else if (error.code === "ECONNRESET" || error.code === "ECONNABORTED") {
        console.error(
          `Connection issue (${error.code}). Retry attempt ${attempts}/${maxAttempts}`
        );
      } else {
        console.error("Error uploading to storage:", error.message);
      }

      if (attempts >= maxAttempts) {
        throw new Error(`Failed to upload to storage after ${maxAttempts} attempts`);
      }

      // Exponential backoff
      const backoffTime = Math.pow(2, attempts) * 1000;
      console.log(`Waiting ${backoffTime / 1000} seconds before retry...`);
      await new Promise((resolve) => setTimeout(resolve, backoffTime));
    }
  }
}

// List files from Bunny Storage
async function listBunnyStorageFiles(path = "/", maxRetries = 3) {
  let attempts = 0;
  const maxAttempts = maxRetries;

  while (attempts < maxAttempts) {
    try {
      // Check network connectivity
      const isConnected = await checkConnectivity();
      if (!isConnected) {
        console.log("No network connection detected. Waiting before retry...");
        await new Promise((resolve) => setTimeout(resolve, 5000)); // 5 second wait
        attempts++;
        continue;
      }

      console.log(`Listing files from Bunny Storage: ${STORAGE_URL}${path}`);

      const response = await axiosInstance.get(`${STORAGE_URL}${path}`, {
        headers: {
          AccessKey: STORAGE_API_KEY,
        },
        timeout: 30000, // 30 seconds timeout
        retry: 2,
        retryDelay: 2000,
      });

      // Filter for video files only
      const videoExtensions = ['.mp4', '.webm', '.mov', '.avi', '.mkv', '.flv'];
      const videoFiles = response.data.filter(file => {
        if (file.IsDirectory) return false;
        const ext = path.extname(file.ObjectName).toLowerCase();
        return videoExtensions.includes(ext);
      });
      
      return videoFiles.map(file => ({
        name: file.ObjectName,
        size: file.Length,
        url: `${CDN_URL}/${file.ObjectName}`,
        lastModified: file.LastChanged
      }));
    } catch (error) {
      attempts++;

      if (error.code === "ENOTFOUND") {
        console.error("DNS resolution failed. Cannot connect to Bunny.net API.");
      } else if (error.code === "ECONNRESET" || error.code === "ECONNABORTED") {
        console.error(`Connection issue (${error.code}). Retry attempt ${attempts}/${maxAttempts}`);
      } else {
        console.error("Error listing files:", error.message);
      }

      if (attempts >= maxAttempts) {
        throw new Error(`Failed to list files after ${maxAttempts} attempts`);
      }

      // Exponential backoff
      const backoffTime = Math.pow(2, attempts) * 1000;
      console.log(`Waiting ${backoffTime / 1000} seconds before retry...`);
      await new Promise((resolve) => setTimeout(resolve, backoffTime));
    }
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

// Add a connectivity check endpoint
app.get("/check-connectivity", async (req, res) => {
  const isConnected = await checkConnectivity();
  res.status(200).json({
    connected: isConnected,
    timestamp: new Date().toISOString(),
  });
});

// Home page - Upload form and video list
app.get("/", async (req, res) => {
  try {
    // Get list of videos from storage
    const videos = await listBunnyStorageFiles("/");
    console.log(videos)
    res.render("index", { videos });
  } catch (error) {
    console.error("Error loading home page:", error);
    res.render("index", { 
      videos: [], 
      error: "Failed to load videos. Please try again later." 
    });
  }
});

// Video player page
app.get("/play/:filename", (req, res) => {
  const filename = req.params.filename;
  const videoUrl = `${CDN_URL}/${filename}`;
  res.render("player", { videoUrl, filename });
});

// Endpoint for Bunny Storage upload
app.post("/upload", upload.single("video"), async (req, res) => {
  // Create a unique upload ID for this upload
  const uploadId = Date.now().toString();
  
  // Store progress information
  const progressData = {
    progress: 0,
    bytesUploaded: 0,
    bytesTotal: 0,
    status: 'preparing',
    error: null
  };
  
  // Store the progress data in a global map
  if (!global.uploadProgress) {
    global.uploadProgress = new Map();
  }
  global.uploadProgress.set(uploadId, progressData);
  
  try {
    if (!req.file) {
      return res.status(400).send("No video file uploaded");
    }
    
    const filePath = req.file.path;
    const originalFileName = req.file.originalname;
    
    // Update progress status
    progressData.status = 'uploading';
    progressData.bytesTotal = fs.statSync(filePath).size;
    
    // Upload to Bunny Storage
    const uploadResult = await uploadToBunnyStorage(filePath, originalFileName);
    
    // Update progress after successful upload
    progressData.status = 'completed';
    progressData.progress = 100;
    progressData.fileUrl = uploadResult.url;
    
    // Delete temporary file
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    
    // Redirect to the homepage with a success message
    res.redirect("/?success=1&file=" + encodeURIComponent(originalFileName));
  } catch (error) {
    console.error("Upload process failed:", error);
    
    // Update progress with error
    progressData.status = 'failed';
    progressData.error = error.message;
    
    // Clean up temp file if it exists
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    // Redirect with error
    res.redirect("/?error=" + encodeURIComponent(error.message));
  }
});

// Add endpoint to check upload status
app.get("/upload-status/:uploadId", (req, res) => {
  const uploadId = req.params.uploadId;
  
  if (!global.uploadProgress || !global.uploadProgress.has(uploadId)) {
    return res.status(404).json({
      error: "Upload not found"
    });
  }
  
  const progressData = global.uploadProgress.get(uploadId);
  
  // If upload is completed or failed, we could remove it from memory after some time
  if (progressData.status === 'completed' || progressData.status === 'failed') {
    // Schedule cleanup after 5 minutes
    setTimeout(() => {
      if (global.uploadProgress && global.uploadProgress.has(uploadId)) {
        global.uploadProgress.delete(uploadId);
      }
    }, 5 * 60 * 1000);
  }
  
  res.status(200).json(progressData);
});

// Delete video endpoint
app.get("/delete/:filename", async (req, res) => {
  const filename = req.params.filename;
  
  try {
    // Delete from Bunny Storage
    await axiosInstance.delete(`${STORAGE_URL}/${filename}`, {
      headers: {
        AccessKey: STORAGE_API_KEY,
      },
      timeout: 10000,
      retry: 2,
      retryDelay: 1000,
    });
    
    res.redirect("/?deleted=1");
  } catch (error) {
    console.error("Error deleting file:", error);
    res.redirect("/?error=" + encodeURIComponent("Failed to delete: " + error.message));
  }
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Video upload is ready at http://localhost:${PORT}`);
});