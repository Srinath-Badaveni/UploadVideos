const express = require('express');
const multer = require('multer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;

// Bunny Storage Info
const STORAGE_ZONE = 'learningstream';
const API_KEY = '3c45cde6-2010-4744-999786804a31-854b-452a';

// Set EJS
app.set('view engine', 'ejs');
app.use(express.static('public'));

// Multer setup
const upload = multer({ dest: 'uploads/' });

// Routes
app.get('/', (req, res) => {
  res.render('./views/upload.ejs');
});

app.post('/upload', upload.single('video'), async (req, res) => {
  const localFilePath = req.file.path;
  const originalFileName = req.file.originalname;

  try {
    const fileBuffer = fs.readFileSync(localFilePath);
    console.log("hi")

    const response = await axios.put(
      `https://storage.bunnycdn.com/${STORAGE_ZONE}/${originalFileName}`,
      fileBuffer,
      {
        headers: {
          AccessKey: API_KEY,
          'Content-Type': 'application/octet-stream',
        },
      }
    );

    // Delete local file after upload
    fs.unlinkSync(localFilePath);

    res.send(`✅ Uploaded successfully! File URL:<br>
      <a href="https://your-pullzone-name.b-cdn.net/${originalFileName}" target="_blank">
        https://your-pullzone-name.b-cdn.net/${originalFileName}
      </a>`);
  } catch (err) {
    console.error('❌ Upload failed:', err.response?.data || err.message);
    res.status(500).send('Upload failed.');
  }
});

app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
