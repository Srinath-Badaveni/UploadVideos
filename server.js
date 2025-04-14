// Import required packages
const express = require("express");
const multer = require("multer");
const axios = require("axios");
const fs = require("fs");
const cors = require('cors');
const path = require("path");
const { promisify } = require("util");
const dns = require("dns");
const mime = require("mime-types");
const crypto = require("crypto");
require("dotenv").config();


const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static("public"));


// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});

const upload = multer({ storage });

// Environment variables for Bunny.net
const BUNNY_STORAGE_NAME = process.env.BUNNY_STORAGE_NAME;
const BUNNY_STORAGE_ZONE = process.env.BUNNY_STORAGE_ZONE;
const BUNNY_STREAM_LIBRARY_ID = process.env.BUNNY_STREAM_LIBRARY_ID;
const BUNNY_STREAM_API_KEY = process.env.BUNNY_STREAM_API_KEY;
const BUNNY_STORAGE_API_KEY = process.env.BUNNY_STORAGE_API_KEY;


async function uploadToBunnyStorage(filePath, fileName) {
  try {
    console.log(`Uploading ${fileName} to Bunny Storage...`);
    
    const fileStream = fs.createReadStream(filePath);
    
    // The correct format for Bunny Storage API
    const url = `https://${BUNNY_STORAGE_ZONE}.storage.bunnycdn.com/${BUNNY_STORAGE_NAME}/${fileName}`;
    console.log('Storage upload URL:', url);
    
    const response = await axios.put(
      url,
      fileStream,
      {
        headers: {
          // For Bunny Storage, we use the Storage API key
          'AccessKey': BUNNY_STORAGE_API_KEY,
          'Content-Type': 'application/octet-stream'
        }
      }
    );
    
    console.log('Upload to Bunny Storage successful');
    return `https://${BUNNY_STORAGE_ZONE}.storage.bunnycdn.com/${BUNNY_STORAGE_NAME}/${fileName}`;
  } catch (error) {
    console.error('Error uploading to Bunny Storage:', error.response ? error.response.data : error);
    throw error;
  }
}

// Create a Bunny Stream video
async function createBunnyStreamVideo(title) {
  try {
    console.log('Creating Bunny Stream video entry...');
    
    const response = await axios.post(
      `https://video.bunnycdn.com/library/${BUNNY_STREAM_LIBRARY_ID}/videos`,
      { title },
      {
        headers: {
          'AccessKey': BUNNY_STREAM_API_KEY,
          'Content-Type': 'application/json'
        }
      }
    );
    
    console.log('Created Bunny Stream video entry');
    return response.data;
  } catch (error) {
    console.error('Error creating Bunny Stream video:', error.response ? error.response.data : error);
    throw error;
  }
}

// Upload directly to Bunny Stream
async function uploadToBunnyStream(filePath, videoId) {
  try {
    console.log(`Uploading video to Bunny Stream with ID: ${videoId}...`);
    
    const fileStream = fs.createReadStream(filePath);
    
    const response = await axios.put(
      `https://video.bunnycdn.com/library/${BUNNY_STREAM_LIBRARY_ID}/videos/${videoId}`,
      fileStream,
      {
        headers: {
          'AccessKey': BUNNY_STREAM_API_KEY,
          'Content-Type': 'application/octet-stream'
        }
      }
    );
    
    console.log('Upload to Bunny Stream successful');
    return response.data;
  } catch (error) {
    console.error('Error uploading to Bunny Stream:', error.response ? error.response.data : error);
    throw error;
  }
}

// Import from URL to Bunny Stream
async function importToBunnyStream(sourceUrl, videoId) {
  try {
    console.log(`Importing video from URL to Bunny Stream...`);
    console.log('Source URL:', sourceUrl);
    console.log('Video ID:', videoId);
    
    const response = await axios.post(
      `https://video.bunnycdn.com/library/${BUNNY_STREAM_LIBRARY_ID}/videos/${videoId}/import`,
      { url: sourceUrl },
      {
        headers: {
          'AccessKey': BUNNY_STREAM_API_KEY,
          'Content-Type': 'application/json'
        }
      }
    );
    
    console.log('Import to Bunny Stream initiated');
    return response.data;
  } catch (error) {
    console.error('Error importing to Bunny Stream:', error.response ? error.response.data : error);
    throw error;
  }
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Alternate approach: Skip storage and upload directly to Stream
app.post('/upload', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }
    
    console.log('File received:', req.file.path, 'Size:', req.file.size);
    
    // Option 1: Use Storage + Stream approach
    try {
      // 1. Create a video entry in Bunny Stream
      const videoData = await createBunnyStreamVideo(req.file.originalname);
      console.log('Video entry created with ID:', videoData.guid);
      
      // Try direct upload to Stream first as it's simpler
      await uploadToBunnyStream(req.file.path, videoData.guid);
      
      // Delete local file
      fs.unlinkSync(req.file.path);
      
      res.json({
        success: true,
        message: 'Video uploaded directly to Stream',
        videoId: videoData.guid,
        videoData
      });
    } catch (directUploadError) {
      console.error('Direct upload to Stream failed, trying Storage approach:', directUploadError);
      
      // Option 2: Storage + Stream approach as fallback
      try {
        // 1. Create a video entry in Bunny Stream
        const videoData = await createBunnyStreamVideo(req.file.originalname);
        console.log('Video entry created with ID:', videoData.guid);
        
        // 2. Upload to Bunny Storage for backup/archive
        const storageUrl = await uploadToBunnyStorage(req.file.path, req.file.filename);
        console.log('Storage URL:', storageUrl);
        
        // 3. Import from Bunny Storage URL to Bunny Stream
        await importToBunnyStream(storageUrl, videoData.guid);
        console.log('Import from Storage to Stream initiated');
        
        // Delete local file
        fs.unlinkSync(req.file.path);
        
        res.json({
          success: true,
          message: 'Video uploaded via Storage and now processing',
          videoId: videoData.guid,
          videoData
        });
      } catch (error) {
        throw error; // Pass to outer catch block
      }
    }
  } catch (error) {
    console.error('Error in upload process:', error);
    
    // Clean up the file if it exists
    try {
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
    } catch (cleanupError) {
      console.error('Error cleaning up file:', cleanupError);
    }
    
    res.status(500).json({ success: false, message: 'Upload failed', error: error.message });
  }
});

// Get video info
app.get('/video/:videoId', async (req, res) => {
  try {
    const response = await axios.get(
      `https://video.bunnycdn.com/library/${BUNNY_STREAM_LIBRARY_ID}/videos/${req.params.videoId}`,
      {
        headers: {
          'AccessKey': BUNNY_STREAM_API_KEY
        }
      }
    );
    
    res.json({ success: true, video: response.data });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to get video info', error: error.message });
  }
});

// Get all videos
app.get('/videos', async (req, res) => {
  try {
    const response = await axios.get(
      `https://video.bunnycdn.com/library/${BUNNY_STREAM_LIBRARY_ID}/videos`,
      {
        headers: {
          'AccessKey': BUNNY_STREAM_API_KEY
        }
      }
    );
    data = response.data.items
    console.log(data)
    
    res.json({data});
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to get videos', error: error.message });
  }
});

// Create uploads directory if it doesn't exist
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});