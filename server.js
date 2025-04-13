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
app.use(express.json({ limit: "50mb" })); // Reduced limit for JSON
app.use(express.urlencoded({ extended: true, limit: "50mb" })); // Reduced limit for URL-encoded
app.use(express.static("public"));

// Configure multer for disk storage with memory-efficient streaming
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    // Ensure uploads directory exists
    if (!fs.existsSync("uploads/")) {
      fs.mkdirSync("uploads/");
    }
    cb(null, "uploads/");
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + path.extname(file.originalname));
  },
});

// Configure multer with file size limits and proper error handling
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 2000 * 1024 * 1024, // 2GB max file size
  }
});

// Environment variables
const STORAGE_ZONE = process.env.STORAGE_ZONE;
const STORAGE_API_KEY = process.env.STORAGE_API_KEY;
const BUNNY_API_URL = process.env.BUNNY_API_URL;

// DNS lookup promise for network connectivity check
const dnsLookup = promisify(dns.lookup);

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

// Create custom axios instance with optimized settings for Render
const axiosInstance = axios.create({
  timeout: 120000, // 2 minutes default timeout
  maxContentLength: Infinity,
  maxBodyLength: Infinity
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
    await new Promise((resolve) => setTimeout(resolve, 5000)); // Wait 5 seconds
  }
  
  // Create new promise to handle retry with backoff
  const backoff = new Promise((resolve) => {
    const delay = config.retryDelay * Math.pow(1.5, config.retryCount - 1); // Exponential backoff
    console.log(`Retrying request (${config.retryCount}/${config.retry}), waiting ${delay}ms...`);
    setTimeout(() => {
      resolve();
    }, delay);
  });
  
  // Wait for backoff then retry request
  await backoff;
  return axiosInstance(config);
});

// Memory-efficient direct upload to BunnyCDN storage
async function uploadToBunny(filePath, storageZoneName, accessKey, progressCallback) {
  const fileName = path.basename(filePath);
  const uploadUrl = `https://storage.bunnycdn.com/${storageZoneName}/${fileName}`;
  const fileSize = fs.statSync(filePath).size;
  const fileType = mime.lookup(filePath) || "application/octet-stream";
  
  console.log(`Starting upload to BunnyCDN: ${fileName}, Size: ${(fileSize / (1024 * 1024)).toFixed(2)} MB`);
  
  try {
    // Create readable stream instead of loading the file into memory
    const fileStream = fs.createReadStream(filePath);
    
    // Set up upload with progress tracking
    let uploadedBytes = 0;
    let lastLogged = 0;
    
    // Wrap the stream to track progress (memory efficient way)
    const progressStream = new (require('stream').Transform)({
      transform(chunk, encoding, callback) {
        uploadedBytes += chunk.length;
        
        // Report progress less frequently to reduce CPU usage
        const percent = (uploadedBytes / fileSize) * 100;
        if (percent - lastLogged >= 5 || percent >= 99.9) { // Log every 5% or at completion
          lastLogged = percent;
          if (typeof progressCallback === 'function') {
            progressCallback(percent, uploadedBytes, fileSize);
          }
        }
        
        this.push(chunk);
        callback();
      }
    });
    
    // Pipe the file through our progress tracker
    fileStream.pipe(progressStream);
    
    // Use axios for the upload with optimized settings
    const response = await axiosInstance.put(uploadUrl, progressStream, {
      headers: {
        'AccessKey': accessKey,
        'Content-Type': fileType,
        'Content-Length': fileSize
      },
      // Render-specific optimizations
      timeout: 3600000, // 1 hour timeout
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      retry: 3,
      retryDelay: 10000 // 10 seconds between retries
    });
    
    // Ensure 100% progress is reported
    if (typeof progressCallback === 'function') {
      progressCallback(100, fileSize, fileSize);
    }
    
    console.log(`Upload completed successfully: ${fileName}`);
    return { success: true, fileName };
  } catch (error) {
    console.error(`Upload failed: ${error.message}`);
    throw error;
  }
}

// Get videos from BunnyCDN storage
async function listVideos(storageZoneName, accessKey, folder = "") {
  try {
    const url = `https://storage.bunnycdn.com/${storageZoneName}/${folder}`;
    
    const response = await axiosInstance.get(url, {
      headers: {
        'AccessKey': accessKey
      },
      timeout: 20000,
      retry: 2,
      retryDelay: 5000
    });
    
    // Filter for video files
    const videoFiles = response.data.filter(file => 
      file.ObjectName.match(/\.(mp4|mov|avi|mkv|webm)$/i)
    );
    
    return videoFiles;
  } catch (error) {
    console.error("Failed to list videos:", error.response?.data || error.message);
    throw error;
  }
}

// Get video details
async function getVideoDetails(storageZoneName, path, apiKey) {
  try {
    const response = await axiosInstance.get(
      `https://storage.bunnycdn.com/${storageZoneName}/${path}`,
      {
        headers: {
          'AccessKey': apiKey,
        },
        timeout: 20000
      }
    );
    return response.data;
  } catch (error) {
    console.error('Error getting video details:', error.response?.data || error.message);
    return null;
  }
}

// Middleware to check connectivity before processing requests
app.use(async (req, res, next) => {
  if (req.path === "/check-connectivity" || req.path === "/health") {
    return next(); // Skip check for these endpoints
  }
  
  // Skip connectivity check for OPTIONS requests (CORS preflight)
  if (req.method === 'OPTIONS') {
    return next();
  }
  
  // Skip connectivity check for static files
  if (req.path.startsWith('/public/') || req.path === '/' || req.path.endsWith('.js') || req.path.endsWith('.css')) {
    return next();
  }
  
  const isConnected = await checkConnectivity();
  if (!isConnected) {
    return res.status(503).json({
      error: "Network connectivity issue",
      message: "Unable to reach Bunny.net servers. Please check your internet connection."
    });
  }
  next();
});

// Health check endpoint for Render
app.get("/health", (req, res) => {
  res.status(200).json({ status: "healthy", timestamp: new Date().toISOString() });
});

// Connectivity check endpoint
app.get("/check-connectivity", async (req, res) => {
  const isConnected = await checkConnectivity();
  res.status(200).json({
    connected: isConnected,
    timestamp: new Date().toISOString()
  });
});

// Upload endpoint
app.post("/upload", upload.single("video"), async (req, res) => {
  // Create a unique upload ID
  const uploadId = Date.now().toString();
  
  // Initialize progress tracking
  const progressData = {
    progress: 0,
    bytesUploaded: 0,
    bytesTotal: 0,
    status: "preparing",
    error: null,
    startTime: new Date().toISOString()
  };
  
  // Store the progress data
  if (!global.uploadProgress) {
    global.uploadProgress = new Map();
  }
  global.uploadProgress.set(uploadId, progressData);
  
  // Send immediate response with upload ID (important for Render)
  res.status(202).json({
    uploadId: uploadId,
    message: "Upload started",
    statusUrl: `/upload-status/${uploadId}`
  });
  
  // Process upload in background
  (async function() {
    try {
      if (!req.file) {
        progressData.status = "failed";
        progressData.error = "No video file uploaded";
        return;
      }
      
      const filePath = req.file.path;
      const fileSize = fs.statSync(filePath).size;
      
      // Update progress tracking
      progressData.status = "uploading";
      progressData.bytesTotal = fileSize;
      global.uploadProgress.set(uploadId, progressData);
      
      console.log(`Processing file: ${path.basename(filePath)}, Size: ${(fileSize / (1024 * 1024)).toFixed(2)} MB`);
      
      // Define progress callback
      const progressCallback = (percent, bytesUploaded, bytesTotal) => {
        if (global.uploadProgress && global.uploadProgress.has(uploadId)) {
          const progressObj = global.uploadProgress.get(uploadId);
          progressObj.progress = percent;
          progressObj.bytesUploaded = bytesUploaded;
          progressObj.bytesTotal = bytesTotal || progressObj.bytesTotal;
          
          global.uploadProgress.set(uploadId, progressObj);
        }
      };
      
      try {
        // Upload to BunnyCDN
        const videoData = await uploadToBunny(
          filePath,
          STORAGE_ZONE,
          STORAGE_API_KEY,
          progressCallback
        );
        
        console.log("Video created in Bunny.net:", videoData);
        
        // Final update after successful upload
        if (global.uploadProgress && global.uploadProgress.has(uploadId)) {
          const progressObj = global.uploadProgress.get(uploadId);
          progressObj.status = "completed";
          progressObj.progress = 100;
          progressObj.bytesUploaded = progressObj.bytesTotal;
          progressObj.videoId = videoData.fileName;
          progressObj.completedAt = new Date().toISOString();
          global.uploadProgress.set(uploadId, progressObj);
        }
      } catch (uploadError) {
        if (global.uploadProgress && global.uploadProgress.has(uploadId)) {
          const progressObj = global.uploadProgress.get(uploadId);
          progressObj.status = "failed";
          progressObj.error = `Upload failed: ${uploadError.message}`;
          global.uploadProgress.set(uploadId, progressObj);
        }
        console.error("Upload failed:", uploadError.message);
      }
      
      // Clean up temporary file regardless of success/failure
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          console.log(`Temporary file deleted: ${filePath}`);
        }
      } catch (cleanupError) {
        console.error("Error cleaning up temporary file:", cleanupError);
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
      try {
        if (req.file && fs.existsSync(req.file.path)) {
          fs.unlinkSync(req.file.path);
        }
      } catch (e) {
        console.error("Error cleaning up temporary file:", e);
      }
    }
  })().catch(err => console.error("Unhandled error in upload process:", err));
});

// Upload status endpoint
app.get("/upload-status/:uploadId", (req, res) => {
  const uploadId = req.params.uploadId;
  
  if (!global.uploadProgress || !global.uploadProgress.has(uploadId)) {
    return res.status(404).json({
      error: "Upload not found"
    });
  }
  
  const progressData = global.uploadProgress.get(uploadId);
  
  // Schedule cleanup for completed or failed uploads
  if (progressData.status === "completed" || progressData.status === "failed") {
    setTimeout(() => {
      if (global.uploadProgress && global.uploadProgress.has(uploadId)) {
        global.uploadProgress.delete(uploadId);
      }
    }, 30 * 60 * 1000); // 30 minutes
  }
  
  res.status(200).json(progressData);
});

// Videos list endpoint
app.get("/videos", async (req, res) => {
  try {
    const videos = await listVideos(STORAGE_ZONE, STORAGE_API_KEY);
    res.status(200).json(videos);
  } catch (error) {
    console.error("Error fetching videos:", error);
    res.status(500).json({
      error: "Failed to fetch videos",
      details: error.message,
      recommendation: error.message.includes("Network")
        ? "Please check your internet connection and try again"
        : "Please try again later"
    });
  }
});

// Video details endpoint
app.get("/videos/:videoId", async (req, res) => {
  try {
    const videoDetails = await getVideoDetails(STORAGE_ZONE, req.params.videoId, STORAGE_API_KEY);
    
    if (!videoDetails) {
      return res.status(404).json({ error: "Video not found" });
    }
    
    res.status(200).json(videoDetails);
  } catch (error) {
    console.error("Error fetching video details:", error);
    res.status(500).json({
      error: "Failed to fetch video details",
      details: error.message
    });
  }
});

// Serve the index page
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Video upload server is ready to handle uploads up to 2GB`);
});